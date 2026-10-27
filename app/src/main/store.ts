/**
 * The QA Arena control-plane store: imported apps and their snapshots, run
 * contracts, tasks, the durable event log, evidence metadata, claims with
 * their challenges and verifications, reports, and the versioned DNA.
 *
 * Every state change and the event that records it commit in ONE
 * transaction. Worker writes go through a `Lease`; a lease whose generation
 * was revoked (force stop, ownership change) is rejected with
 * `StaleOwnershipError`.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Artifact,
  AuditConfig,
  Category,
  Challenge,
  Claim,
  ClaimReview,
  ClaimStatus,
  DnaRule,
  DnaVersion,
  EvidenceOutcome,
  Phase,
  ReportVersion,
  Reproduction,
  ReviewDecision,
  Role,
  Run,
  RunContract,
  RunState,
  RunSummary,
  RuleChange,
  RuntimeId,
  Severity,
  Snapshot,
  Stance,
  StackInfo,
  Target,
  TargetSource,
  Task,
  TaskStatus,
  TestAccount,
  Verification,
} from '../shared/domain'
import { AREA_LABEL, DEPTH_LIMITS, FOCUS_LABEL, ROLES, TERMINAL_TASK_STATUSES } from '../shared/domain'
import { type Envelope, type EventType, validateEvent } from '../shared/events'
import { type RunTrigger, nextRunState, nextTaskStatus, triggerForTaskStatus } from '../shared/lifecycle'

export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export class StaleOwnershipError extends Error {
  constructor(taskId: string, detail: string) {
    super(`stale ownership for task ${taskId}: ${detail}`)
    this.name = 'StaleOwnershipError'
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`)
    this.name = 'NotFoundError'
  }
}

export interface Lease {
  runId: string
  taskId: string
  role: Role
  runtime: RuntimeId
  workerId: string
  generation: number
}

export interface StartRunInput {
  idempotencyKey: string
  targetId: string
  mode: RunContract['mode']
  externalUrl: string | null
  allowCommands: boolean
  audit: AuditConfig
  roster: RunContract['roster']
  initiator: string
  limits?: RunContract['limits']
}

export interface StoreOptions {
  now?: () => string
  newId?: (prefix: string) => string
}

type Row = Record<string, unknown>

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as object).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Row)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const hashContract = (contract: RunContract): string => createHash('sha256').update(canonicalJson(contract)).digest('hex')

const json = <T>(v: unknown): T => JSON.parse(String(v)) as T
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export class QaStore {
  private readonly now: () => string
  private readonly newId: (prefix: string) => string
  private readonly listeners = new Set<(events: Envelope[]) => void>()
  private pending: Envelope[] = []
  private depth = 0

  constructor(
    readonly db: DatabaseSync,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? ((prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
  }

  id(prefix: string): string {
    return this.newId(prefix)
  }

  // ---------------------------------------------------------------- plumbing

  /** Subscribe to committed events. Called only after COMMIT, never for a
   * rolled-back write. Consumers that need history re-read with `catchUp`. */
  onCommit(listener: (events: Envelope[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.depth += 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      const committed = this.pending
      this.pending = []
      this.depth -= 1
      for (const listener of this.listeners) {
        try {
          listener(committed)
        } catch {
          // A broken subscriber must not undo or block a committed write.
        }
      }
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      this.pending = []
      this.depth -= 1
      throw err
    }
  }

  /** Append one event. Only for writes that are not a worker's (lifecycle,
   * host replays, operator decisions); workers use `workerAppend`. */
  append(runId: string, taskId: string | null, type: EventType, payload: Record<string, unknown>, eventId?: string): Envelope {
    return this.tx(() => {
      validateEvent(type, payload)
      const id = eventId ?? this.newId('evt')
      const existing = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(id) as Row | undefined
      if (existing) return this.toEnvelope(existing)
      const ts = this.now()
      const result = this.db
        .prepare('INSERT INTO events (event_id, run_id, task_id, type, ts, payload) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, runId, taskId, type, ts, JSON.stringify(payload))
      const envelope: Envelope = { seq: Number(result.lastInsertRowid), eventId: id, runId, taskId, type, ts, payload }
      this.pending.push(envelope)
      return envelope
    })
  }

  private toEnvelope(row: Row): Envelope {
    return {
      seq: Number(row.seq),
      eventId: String(row.event_id),
      runId: String(row.run_id),
      taskId: optStr(row.task_id),
      type: row.type as EventType,
      ts: String(row.ts),
      payload: json(row.payload),
    }
  }

  // ------------------------------------------------------------------ targets

  createTarget(input: { id?: string; name: string; source: TargetSource }): Target {
    const target: Target = { id: input.id ?? this.newId('app'), name: input.name, source: input.source, createdAt: this.now(), latestSnapshot: null }
    this.db.prepare('INSERT INTO targets (id, name, source, created_at) VALUES (?, ?, ?, ?)').run(target.id, target.name, JSON.stringify(target.source), target.createdAt)
    return target
  }

  addSnapshot(input: Omit<Snapshot, 'id' | 'createdAt'> & { id?: string }): Snapshot {
    const snapshot: Snapshot = { ...input, id: input.id ?? this.newId('snap'), createdAt: this.now() }
    this.db
      .prepare(
        `INSERT INTO snapshots (id, target_id, root_path, content_hash, commit_sha, file_count, bytes, stack, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshot.id, snapshot.targetId, snapshot.rootPath, snapshot.contentHash, snapshot.commitSha, snapshot.fileCount, snapshot.bytes, JSON.stringify(snapshot.stack), snapshot.createdAt)
    return snapshot
  }

  private toSnapshot(r: Row): Snapshot {
    return {
      id: String(r.id),
      targetId: String(r.target_id),
      rootPath: String(r.root_path),
      contentHash: String(r.content_hash),
      commitSha: optStr(r.commit_sha),
      fileCount: Number(r.file_count),
      bytes: Number(r.bytes),
      stack: json<StackInfo>(r.stack),
      createdAt: String(r.created_at),
    }
  }

  getSnapshot(id: string): Snapshot {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`snapshot ${id}`)
    return this.toSnapshot(row)
  }

  private toTarget(r: Row): Target {
    const latest = this.db.prepare('SELECT * FROM snapshots WHERE target_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(String(r.id)) as Row | undefined
    return {
      id: String(r.id),
      name: String(r.name),
      source: json<TargetSource>(r.source),
      createdAt: String(r.created_at),
      latestSnapshot: latest ? this.toSnapshot(latest) : null,
    }
  }

  listTargets(): Target[] {
    return (this.db.prepare('SELECT * FROM targets ORDER BY created_at DESC, rowid DESC').all() as Row[]).map((r) => this.toTarget(r))
  }

  getTarget(id: string): Target {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`app ${id}`)
    return this.toTarget(row)
  }

  // ---------------------------------------------------------------------- DNA

  addDnaVersion(input: { rules: DnaRule[]; parentId: string | null; note: string; createdBy: string }): DnaVersion {
    return this.tx(() => {
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM dna_versions').get() as Row
      const version: DnaVersion = {
        id: this.newId('dna'),
        version: Number(row.v) + 1,
        rules: input.rules,
        parentId: input.parentId,
        note: input.note,
        createdBy: input.createdBy,
        createdAt: this.now(),
      }
      this.db
        .prepare('INSERT INTO dna_versions (id, version, rules, parent_id, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(version.id, version.version, JSON.stringify(version.rules), version.parentId, version.note, version.createdBy, version.createdAt)
      return version
    })
  }

  private toDna(r: Row): DnaVersion {
    return {
      id: String(r.id),
      version: Number(r.version),
      rules: json<DnaRule[]>(r.rules),
      parentId: optStr(r.parent_id),
      note: String(r.note),
      createdBy: String(r.created_by),
      createdAt: String(r.created_at),
    }
  }

  currentDna(): DnaVersion {
    const row = this.db.prepare('SELECT * FROM dna_versions ORDER BY version DESC LIMIT 1').get() as Row | undefined
    if (!row) throw new NotFoundError('dna')
    return this.toDna(row)
  }

  getDna(id: string): DnaVersion {
    const row = this.db.prepare('SELECT * FROM dna_versions WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`dna ${id}`)
    return this.toDna(row)
  }

  listDna(): DnaVersion[] {
    return (this.db.prepare('SELECT * FROM dna_versions ORDER BY version DESC').all() as Row[]).map((r) => this.toDna(r))
  }

  // --------------------------------------------------------------------- runs

  /** Idempotent start. The same key with the same contract returns the
   * original run; the same key with a different contract is a conflict. */
  startRun(input: StartRunInput): { run: Run; created: boolean } {
    if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new ConflictError('idempotency key is required')
    if (!['white', 'black', 'both'].includes(input.mode)) throw new ConflictError('Choose a valid audit mode')
    if (typeof input.allowCommands !== 'boolean') throw new ConflictError('Command permission must be explicit')
    const audit = input.audit
    if (!audit || !Object.hasOwn(DEPTH_LIMITS, audit.depth)) throw new ConflictError('Choose a valid audit depth')
    if (!Array.isArray(audit.areas) || !audit.areas.length || audit.areas.some((x) => x !== 'whole_app' && !Object.hasOwn(AREA_LABEL, x))) throw new ConflictError('Choose a valid audit area')
    if (!Array.isArray(audit.focus) || !audit.focus.length || audit.focus.some((x) => !Object.hasOwn(FOCUS_LABEL, x))) throw new ConflictError('Choose at least one audit focus')
    if (!Array.isArray(audit.excludedPaths) || audit.excludedPaths.some((p) => typeof p !== 'string' || p.startsWith('/') || p.split(/[\\/]/).includes('..'))) throw new ConflictError('Excluded paths must stay within the project')
    if (!Array.isArray(audit.accounts) || audit.accounts.some((a) => typeof a !== 'string')) throw new ConflictError('Invalid test account selection')
    if (typeof audit.instructions !== 'string' || audit.instructions.length > 2000 || typeof audit.useKnowledge !== 'boolean') throw new ConflictError('Invalid audit instructions')
    for (const role of ROLES) {
      const profile = input.roster?.[role]
      if (!profile || !['offline', 'claude', 'codex', 'omp'].includes(profile.runtime) || typeof profile.model !== 'string') throw new ConflictError(`Invalid worker for ${role}`)
    }
    const limits = input.limits ?? DEPTH_LIMITS[audit.depth]
    if (!Number.isInteger(limits.maxRounds) || limits.maxRounds < 1 || limits.maxRounds > 5 || !Number.isInteger(limits.maxClaims) || limits.maxClaims < 1 || limits.maxClaims > 100) throw new ConflictError('Invalid run limits')
    for (const role of ROLES) if (!Number.isFinite(limits.taskTimeoutSeconds[role]) || limits.taskTimeoutSeconds[role] <= 0 || limits.taskTimeoutSeconds[role] > 3600 || !Number.isInteger(limits.toolBudget[role]) || limits.toolBudget[role] < 1 || limits.toolBudget[role] > 1000) throw new ConflictError(`Invalid limits for ${role}`)
    return this.tx(() => {
      const target = this.getTarget(input.targetId)
      const snapshot = target.latestSnapshot
      if (!snapshot) throw new ConflictError(`${target.name} has no snapshot to test`)
      if (input.externalUrl !== null) {
        let parsed: URL
        try {
          parsed = new URL(input.externalUrl)
        } catch {
          throw new ConflictError('app URL is not a valid URL')
        }
        if (parsed.username || parsed.password) throw new ConflictError('Do not put credentials in the test URL; use a named test account')
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConflictError('app URL must use http or https')
      }
      if (input.mode !== 'white' && !input.externalUrl && !input.allowCommands) {
        throw new ConflictError('Testing the running app needs either permission to start it here or an authorized test URL')
      }
      const known = new Set(this.listTestAccounts(target.id).filter((a) => a.configured).map((a) => a.name))
      for (const name of input.audit.accounts) if (!known.has(name)) throw new ConflictError(`test account ${name} is not set up for ${target.name}`)
      const dna = this.currentDna()
      const contract: RunContract = {
        targetId: target.id,
        targetName: target.name,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contentHash,
        commitSha: snapshot.commitSha,
        mode: input.mode,
        externalUrl: input.externalUrl ? new URL(input.externalUrl).origin : null,
        allowCommands: input.allowCommands,
        audit: input.audit,
        roster: input.roster,
        dnaVersionId: dna.id,
        initiator: input.initiator,
        limits: input.limits ?? DEPTH_LIMITS[input.audit.depth],
      }
      const contractHash = hashContract(contract)
      const existing = this.db.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(input.idempotencyKey) as Row | undefined
      if (existing) {
        if (String(existing.contract_hash) !== contractHash) {
          throw new ConflictError('this start request was already used for a different run')
        }
        return { run: this.toRun(existing), created: false }
      }
      const id = this.newId('run')
      this.db
        .prepare('INSERT INTO runs (id, idempotency_key, contract_hash, contract, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, input.idempotencyKey, contractHash, JSON.stringify(contract), 'queued', this.now())
      this.append(id, null, 'run_created', {
        target_name: target.name,
        mode: contract.mode,
        audit: contract.audit,
        roster: contract.roster,
        initiator: input.initiator,
        dna_version: dna.version,
        snapshot_hash: snapshot.contentHash,
        external_url: contract.externalUrl,
        allow_commands: contract.allowCommands,
      })
      return { run: this.getRun(id), created: true }
    })
  }

  private toRun(r: Row): Run {
    return {
      id: String(r.id),
      idempotencyKey: String(r.idempotency_key),
      contractHash: String(r.contract_hash),
      contract: json<RunContract>(r.contract),
      state: r.state as RunState,
      terminalReason: optStr(r.terminal_reason),
      summary: r.summary ? json<RunSummary>(r.summary) : null,
      appUrl: optStr(r.app_url),
      createdAt: String(r.created_at),
      startedAt: optStr(r.started_at),
      endedAt: optStr(r.ended_at),
    }
  }

  getRun(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`run ${id}`)
    return this.toRun(row)
  }

  activeRuns(): Run[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE state IN ('queued', 'running', 'pause_requested', 'paused', 'cancel_requested')").all() as Row[]
    return rows.map((row) => this.getRun(String(row.id)))
  }

  listRuns(limit = 200): Run[] {
    return (this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => this.toRun(r))
  }

  nextQueuedRun(): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 1").get() as Row | undefined
    return row ? this.toRun(row) : null
  }

  /** Apply one lifecycle trigger and record its event atomically. */
  transitionRun(
    runId: string,
    trigger: RunTrigger,
    type: EventType,
    payload: Record<string, unknown> = {},
    extra: { terminalReason?: string; summary?: RunSummary } = {},
  ): Run {
    return this.tx(() => {
      const run = this.getRun(runId)
      const next = nextRunState(run.state, trigger)
      const ts = this.now()
      const terminal = next === 'completed' || next === 'failed' || next === 'cancelled'
      this.db
        .prepare(
          `UPDATE runs SET state = ?,
             started_at = CASE WHEN ? = 'running' AND started_at IS NULL THEN ? ELSE started_at END,
             ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
             terminal_reason = COALESCE(?, terminal_reason),
             summary = COALESCE(?, summary)
           WHERE id = ?`,
        )
        .run(next, next, ts, terminal ? 1 : 0, ts, extra.terminalReason ?? null, extra.summary ? JSON.stringify(extra.summary) : null, runId)
      this.append(runId, null, type, payload)
      return this.getRun(runId)
    })
  }

  setAppUrl(runId: string, url: string | null): void {
    this.db.prepare('UPDATE runs SET app_url = ? WHERE id = ?').run(url, runId)
  }

  // -------------------------------------------------------------------- tasks

  createTask(runId: string, role: Role, phase: Phase, ordinal: number, runtime: RuntimeId, workerId: string): Lease {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(attempt_number), 0) AS n FROM tasks WHERE run_id = ? AND phase = ? AND ordinal = ?')
        .get(runId, phase, ordinal) as Row
      const attemptNumber = Number(row.n) + 1
      const id = this.newId('task')
      this.db
        .prepare(
          `INSERT INTO tasks (id, run_id, role, phase, ordinal, attempt_number, runtime, worker_id, owner_generation, status, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'running', ?)`,
        )
        .run(id, runId, role, phase, ordinal, attemptNumber, runtime, workerId, this.now())
      this.append(runId, id, 'task_started', { role, phase, runtime, worker_id: workerId, attempt_number: attemptNumber })
      return { runId, taskId: id, role, runtime, workerId, generation: 1 }
    })
  }

  private toTask(r: Row): Task {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      role: r.role as Role,
      phase: r.phase as Phase,
      ordinal: Number(r.ordinal),
      attemptNumber: Number(r.attempt_number),
      runtime: r.runtime as RuntimeId,
      workerId: String(r.worker_id),
      ownerGeneration: Number(r.owner_generation),
      status: r.status as TaskStatus,
      terminalReason: optStr(r.terminal_reason),
      startedAt: String(r.started_at),
      endedAt: optStr(r.ended_at),
      lastHeartbeatAt: optStr(r.last_heartbeat_at),
    }
  }

  getTask(id: string): Task {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`task ${id}`)
    return this.toTask(row)
  }

  listTasks(runId: string): Task[] {
    return (this.db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY started_at, rowid').all(runId) as Row[]).map((r) => this.toTask(r))
  }

  /** Throws unless `lease` still owns a live task. */
  assertOwner(lease: Lease): Task {
    const task = this.getTask(lease.taskId)
    if (task.workerId !== lease.workerId) throw new StaleOwnershipError(lease.taskId, `owned by ${task.workerId}`)
    if (task.ownerGeneration !== lease.generation) {
      throw new StaleOwnershipError(lease.taskId, `generation ${lease.generation} superseded by ${task.ownerGeneration}`)
    }
    if (TERMINAL_TASK_STATUSES.has(task.status)) throw new StaleOwnershipError(lease.taskId, `task already ${task.status}`)
    return task
  }

  /** The only way a worker writes an event. */
  workerAppend(lease: Lease, type: EventType, payload: Record<string, unknown>, eventId?: string): Envelope {
    return this.tx(() => {
      this.assertOwner(lease)
      if (type === 'worker_heartbeat') this.db.prepare('UPDATE tasks SET last_heartbeat_at = ? WHERE id = ?').run(this.now(), lease.taskId)
      return this.append(lease.runId, lease.taskId, type, payload, eventId)
    })
  }

  finishTask(lease: Lease, status: Exclude<TaskStatus, 'running'>, reason: string, extra: Record<string, unknown> = {}): Task {
    return this.tx(() => {
      const task = this.assertOwner(lease)
      const next = nextTaskStatus(task.status, triggerForTaskStatus(status))
      this.db.prepare('UPDATE tasks SET status = ?, terminal_reason = ?, ended_at = ? WHERE id = ?').run(next, reason, this.now(), lease.taskId)
      this.append(lease.runId, lease.taskId, 'task_finished', { role: task.role, phase: task.phase, status: next, reason, ...extra })
      return this.getTask(lease.taskId)
    })
  }

  /** Force-stop path: bump the owner generation so any late write from the
   * old worker is rejected, and close the task with a durable reason. */
  revokeTask(taskId: string, status: 'cancelled' | 'error', reason: string): Task {
    return this.tx(() => {
      const task = this.getTask(taskId)
      this.db.prepare('UPDATE tasks SET owner_generation = owner_generation + 1 WHERE id = ?').run(taskId)
      if (!TERMINAL_TASK_STATUSES.has(task.status)) {
        const next = nextTaskStatus(task.status, triggerForTaskStatus(status))
        this.db.prepare('UPDATE tasks SET status = ?, terminal_reason = ?, ended_at = ? WHERE id = ?').run(next, reason, this.now(), taskId)
        this.append(task.runId, taskId, 'task_finished', { role: task.role, phase: task.phase, status: next, reason, revoked: true })
      }
      return this.getTask(taskId)
    })
  }

  // ----------------------------------------------------------------- evidence

  recordArtifact(
    runId: string,
    lease: Lease | null,
    input: { sha256: string; mime: string; bytes: number; label: string; redaction: Artifact['redaction'] },
  ): Artifact {
    return this.tx(() => {
      if (lease) this.assertOwner(lease)
      const artifact: Artifact = { id: this.newId('art'), runId, taskId: lease?.taskId ?? null, createdAt: this.now(), ...input }
      this.db
        .prepare('INSERT INTO artifacts (id, sha256, run_id, task_id, mime, bytes, label, redaction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(artifact.id, artifact.sha256, artifact.runId, artifact.taskId, artifact.mime, artifact.bytes, artifact.label, artifact.redaction, artifact.createdAt)
      this.append(runId, artifact.taskId, 'artifact_saved', {
        artifact_id: artifact.id,
        sha256: artifact.sha256,
        mime: artifact.mime,
        label: artifact.label,
        bytes: artifact.bytes,
      })
      return artifact
    })
  }

  getArtifact(id: string): Artifact {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined
    if (!r) throw new NotFoundError(`artifact ${id}`)
    return {
      id: String(r.id),
      sha256: String(r.sha256),
      runId: String(r.run_id),
      taskId: optStr(r.task_id),
      mime: String(r.mime),
      bytes: Number(r.bytes),
      label: String(r.label),
      redaction: r.redaction as Artifact['redaction'],
      createdAt: String(r.created_at),
    }
  }

  getToolCall(taskId: string, toolCallId: string): unknown | undefined {
    const row = this.db.prepare('SELECT result FROM tool_calls WHERE task_id = ? AND tool_call_id = ?').get(taskId, toolCallId) as Row | undefined
    return row ? json(row.result) : undefined
  }

  saveToolCall(lease: Lease, toolCallId: string, result: unknown): void {
    this.tx(() => {
      this.assertOwner(lease)
      this.db.prepare('INSERT OR IGNORE INTO tool_calls (task_id, tool_call_id, result) VALUES (?, ?, ?)').run(lease.taskId, toolCallId, JSON.stringify(result))
    })
  }

  // ------------------------------------------------------------------- claims

  proposeClaim(
    lease: Lease,
    input: {
      title: string
      detail: string
      category: Category
      severity: Severity
      severityRationale: string
      area: 'white' | 'black'
      location: string | null
      evidenceQuote: string | null
      reproduction: Reproduction | null
      suggestedFix: string | null
    },
    maxClaims: number,
  ): Claim {
    return this.tx(() => {
      this.assertOwner(lease)
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM claims WHERE run_id = ?').get(lease.runId) as Row
      if (Number(count.n) >= maxClaims) throw new ConflictError(`this run already has the maximum of ${maxClaims} findings`)
      const claim: Claim = {
        id: this.newId('claim'),
        runId: lease.runId,
        taskId: lease.taskId,
        role: lease.role,
        runtime: lease.runtime,
        ...input,
        status: 'candidate',
        verdictReason: null,
        round: 1,
        withdrawn: false,
        regressionTestArtifactId: null,
        createdAt: this.now(),
      }
      this.db
        .prepare(
          `INSERT INTO claims (id, run_id, task_id, role, runtime, title, detail, category, severity, severity_rationale, area, location,
             evidence_quote, reproduction, suggested_fix, status, round, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 1, ?)`,
        )
        .run(
          claim.id,
          claim.runId,
          claim.taskId,
          claim.role,
          claim.runtime,
          claim.title,
          claim.detail,
          claim.category,
          claim.severity,
          claim.severityRationale,
          claim.area,
          claim.location,
          claim.evidenceQuote,
          claim.reproduction ? JSON.stringify(claim.reproduction) : null,
          claim.suggestedFix,
          claim.createdAt,
        )
      this.append(lease.runId, lease.taskId, 'claim_proposed', {
        claim_id: claim.id,
        title: claim.title,
        category: claim.category,
        severity: claim.severity,
        area: claim.area,
        location: claim.location,
        has_repro: claim.reproduction !== null,
      })
      return claim
    })
  }

  /** The proposer answers a challenge: amend the evidence, or withdraw. */
  reviseClaim(
    lease: Lease,
    input: { claimId: string; action: 'amend' | 'withdraw'; round: number; detail?: string; location?: string | null; evidenceQuote?: string | null; reproduction?: Reproduction | null },
  ): Claim {
    return this.tx(() => {
      this.assertOwner(lease)
      const claim = this.getClaim(input.claimId)
      if (claim.runId !== lease.runId) throw new ConflictError('that finding belongs to a different run')
      if (claim.withdrawn) throw new ConflictError('that finding was already withdrawn')
      if (input.action === 'withdraw') {
        this.db.prepare("UPDATE claims SET withdrawn = 1, round = ?, status = 'rejected', verdict_reason = ? WHERE id = ?").run(input.round, 'Withdrawn by its author after the challenge.', claim.id)
        this.append(lease.runId, lease.taskId, 'claim_revised', { claim_id: claim.id, action: 'withdraw', round: input.round })
        this.append(lease.runId, null, 'claim_verdict', { claim_id: claim.id, status: 'rejected', reason: 'Withdrawn by its author after the challenge.' })
      } else {
        this.db
          .prepare("UPDATE claims SET detail = ?, location = ?, evidence_quote = ?, reproduction = ?, round = ?, status = 'candidate', verdict_reason = NULL WHERE id = ?")
          .run(
            input.detail ?? claim.detail,
            input.location === undefined ? claim.location : input.location,
            input.evidenceQuote === undefined ? claim.evidenceQuote : input.evidenceQuote,
            input.reproduction === undefined ? (claim.reproduction ? JSON.stringify(claim.reproduction) : null) : input.reproduction ? JSON.stringify(input.reproduction) : null,
            input.round,
            claim.id,
          )
        const updated = this.getClaim(claim.id)
        this.append(lease.runId, lease.taskId, 'claim_revised', { claim_id: claim.id, action: 'amend', round: input.round, has_repro: updated.reproduction !== null })
      }
      return this.getClaim(claim.id)
    })
  }

  private toClaim(r: Row): Claim {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      taskId: String(r.task_id),
      role: r.role as Role,
      runtime: r.runtime as RuntimeId,
      title: String(r.title),
      detail: String(r.detail),
      category: r.category as Category,
      severity: r.severity as Severity,
      severityRationale: String(r.severity_rationale),
      area: r.area as 'white' | 'black',
      location: optStr(r.location),
      evidenceQuote: optStr(r.evidence_quote),
      reproduction: r.reproduction ? json<Reproduction>(r.reproduction) : null,
      suggestedFix: optStr(r.suggested_fix),
      status: r.status as ClaimStatus,
      verdictReason: optStr(r.verdict_reason),
      round: Number(r.round),
      withdrawn: Number(r.withdrawn) === 1,
      regressionTestArtifactId: optStr(r.regression_artifact_id),
      createdAt: String(r.created_at),
    }
  }

  getClaim(id: string): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new NotFoundError(`finding ${id}`)
    return this.toClaim(row)
  }

  listClaims(runId: string): Claim[] {
    return (this.db.prepare('SELECT * FROM claims WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as Row[]).map((r) => this.toClaim(r))
  }

  listAllClaims(limit = 500): Claim[] {
    return (this.db.prepare('SELECT * FROM claims ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => this.toClaim(r))
  }

  recordChallenge(lease: Lease, input: { claimId: string; stance: Stance; reasoning: string; round: number }): Challenge {
    return this.tx(() => {
      this.assertOwner(lease)
      const claim = this.getClaim(input.claimId)
      if (claim.runId !== lease.runId) throw new ConflictError('that finding belongs to a different run')
      if (claim.taskId === lease.taskId) throw new ConflictError('a worker cannot challenge its own finding')
      if (claim.withdrawn) throw new ConflictError('that finding was withdrawn')
      const existing = this.db.prepare('SELECT id FROM challenges WHERE claim_id = ? AND task_id = ?').get(input.claimId, lease.taskId) as Row | undefined
      if (existing) throw new ConflictError('you already ruled on this finding in this round')
      const challenge: Challenge = {
        id: this.newId('chal'),
        claimId: input.claimId,
        taskId: lease.taskId,
        runtime: lease.runtime,
        round: input.round,
        stance: input.stance,
        reasoning: input.reasoning,
        createdAt: this.now(),
      }
      this.db
        .prepare('INSERT INTO challenges (id, claim_id, task_id, runtime, round, stance, reasoning, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(challenge.id, challenge.claimId, challenge.taskId, challenge.runtime, challenge.round, challenge.stance, challenge.reasoning, challenge.createdAt)
      this.append(lease.runId, lease.taskId, 'challenge_recorded', { claim_id: input.claimId, stance: input.stance, reasoning: input.reasoning, round: input.round })
      return challenge
    })
  }

  listChallenges(claimId: string): Challenge[] {
    return (this.db.prepare('SELECT * FROM challenges WHERE claim_id = ? ORDER BY round, created_at, rowid').all(claimId) as Row[]).map((r) => ({
      id: String(r.id),
      claimId: String(r.claim_id),
      taskId: String(r.task_id),
      runtime: r.runtime as RuntimeId,
      round: Number(r.round),
      stance: r.stance as Stance,
      reasoning: String(r.reasoning),
      createdAt: String(r.created_at),
    }))
  }

  recordVerification(runId: string, input: Omit<Verification, 'createdAt'>): Verification {
    return this.tx(() => {
      const v: Verification = { ...input, createdAt: this.now() }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO verifications (id, claim_id, round, outcome, expected, actual, detail, artifact_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(this.newId('ver'), v.claimId, v.round, v.outcome, v.expected, v.actual, v.detail, v.artifactId, v.createdAt)
      this.append(runId, null, 'evidence_checked', {
        claim_id: v.claimId,
        round: v.round,
        outcome: v.outcome,
        expected: v.expected,
        actual: v.actual,
        detail: v.detail,
        artifact_id: v.artifactId,
      })
      return v
    })
  }

  listVerifications(claimId: string): Verification[] {
    return (this.db.prepare('SELECT * FROM verifications WHERE claim_id = ? ORDER BY round').all(claimId) as Row[]).map((r) => ({
      claimId: String(r.claim_id),
      round: Number(r.round),
      outcome: r.outcome as EvidenceOutcome,
      expected: optStr(r.expected),
      actual: optStr(r.actual),
      detail: String(r.detail),
      artifactId: optStr(r.artifact_id),
      createdAt: String(r.created_at),
    }))
  }

  settleClaim(claimId: string, status: ClaimStatus, reason: string): Claim {
    return this.tx(() => {
      const claim = this.getClaim(claimId)
      this.db.prepare('UPDATE claims SET status = ?, verdict_reason = ? WHERE id = ?').run(status, reason, claimId)
      this.append(claim.runId, null, 'claim_verdict', { claim_id: claimId, status, reason })
      return this.getClaim(claimId)
    })
  }

  setRegressionTest(claimId: string, artifactId: string, failsNow: boolean): void {
    this.tx(() => {
      const claim = this.getClaim(claimId)
      this.db.prepare('UPDATE claims SET regression_artifact_id = ? WHERE id = ?').run(artifactId, claimId)
      this.append(claim.runId, null, 'regression_test_written', { claim_id: claimId, artifact_id: artifactId, fails_now: failsNow })
    })
  }

  reviewClaim(input: { claimId: string; decision: ReviewDecision; reason: string; reviewer: string }): ClaimReview {
    if (!input.reason.trim()) throw new ConflictError('a decision needs a reason')
    return this.tx(() => {
      const claim = this.getClaim(input.claimId)
      if (claim.status !== 'needs_review' && claim.status !== 'inconclusive') throw new ConflictError(`a ${claim.status} finding does not need a person to decide`)
      if (this.getReview(claim.id)) throw new ConflictError('this finding was already decided')
      const review: ClaimReview = { id: this.newId('rev'), claimId: claim.id, decision: input.decision, reason: input.reason.trim(), reviewer: input.reviewer, createdAt: this.now() }
      this.db
        .prepare('INSERT INTO claim_reviews (id, claim_id, decision, reason, reviewer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(review.id, review.claimId, review.decision, review.reason, review.reviewer, review.createdAt)
      this.append(claim.runId, null, 'claim_reviewed', { claim_id: claim.id, decision: review.decision, reason: review.reason, reviewer: review.reviewer })
      return review
    })
  }

  getReview(claimId: string): ClaimReview | null {
    const r = this.db.prepare('SELECT * FROM claim_reviews WHERE claim_id = ?').get(claimId) as Row | undefined
    if (!r) return null
    return { id: String(r.id), claimId: String(r.claim_id), decision: r.decision as ReviewDecision, reason: String(r.reason), reviewer: String(r.reviewer), createdAt: String(r.created_at) }
  }

  // ------------------------------------------------------- test accounts

  /** Credentials for a test account. The value is only ever read by the
   * host when it sends a request; it never goes to the renderer or a model. */
  setTestAccount(targetId: string, name: string, headerName: string, headerValue: string): void {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new ConflictError('account names use letters, digits, - and _ only')
    if (!/^[A-Za-z0-9-]{1,60}$/.test(headerName)) throw new ConflictError('that is not a valid header name')
    this.db
      .prepare('INSERT OR REPLACE INTO test_accounts (target_id, name, header_name, header_value, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(targetId, name, headerName, headerValue, this.now())
  }

  removeTestAccount(targetId: string, name: string): void {
    this.db.prepare('DELETE FROM test_accounts WHERE target_id = ? AND name = ?').run(targetId, name)
  }

  listTestAccounts(targetId: string): TestAccount[] {
    return (this.db.prepare('SELECT name, header_name, header_value FROM test_accounts WHERE target_id = ? ORDER BY name').all(targetId) as Row[]).map((r) => ({
      name: String(r.name),
      headerName: String(r.header_name),
      configured: String(r.header_value).length > 0,
    }))
  }

  testAccountHeader(targetId: string, name: string): { name: string; value: string } | null {
    const r = this.db.prepare('SELECT header_name, header_value FROM test_accounts WHERE target_id = ? AND name = ?').get(targetId, name) as Row | undefined
    return r ? { name: String(r.header_name), value: String(r.header_value) } : null
  }

  // --------------------------------------------------------- ground truth

  setGroundTruth(targetId: string, bugs: { id: string; title: string; match: string[] }[]): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM ground_truth WHERE target_id = ?').run(targetId)
      for (const b of bugs) this.db.prepare('INSERT INTO ground_truth (target_id, bug_id, title, match) VALUES (?, ?, ?, ?)').run(targetId, b.id, b.title, JSON.stringify(b.match))
    })
  }

  listGroundTruth(targetId: string): { id: string; title: string; match: string[] }[] {
    return (this.db.prepare('SELECT * FROM ground_truth WHERE target_id = ? ORDER BY bug_id').all(targetId) as Row[]).map((r) => ({
      id: String(r.bug_id),
      title: String(r.title),
      match: json<string[]>(r.match),
    }))
  }

  listReviewQueue(): Claim[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM claims c
           WHERE c.status IN ('needs_review', 'inconclusive')
             AND NOT EXISTS (SELECT 1 FROM claim_reviews r WHERE r.claim_id = c.id)
           ORDER BY c.created_at DESC`,
        )
        .all() as Row[]
    ).map((r) => this.toClaim(r))
  }

  // ------------------------------------------------------------------ reports

  writeReport(runId: string, lease: Lease | null, author: string, markdown: string): ReportVersion {
    return this.tx(() => {
      if (lease) this.assertOwner(lease)
      const row = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM reports WHERE run_id = ?').get(runId) as Row
      const report: ReportVersion = { id: this.newId('rep'), runId, taskId: lease?.taskId ?? null, version: Number(row.v) + 1, author, markdown, createdAt: this.now() }
      this.db
        .prepare('INSERT INTO reports (id, run_id, task_id, version, author, markdown, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(report.id, report.runId, report.taskId, report.version, report.author, report.markdown, report.createdAt)
      this.append(runId, report.taskId, 'report_written', { report_id: report.id, version: report.version, author })
      return report
    })
  }

  listReports(runId: string): ReportVersion[] {
    const rows = this.db.prepare('SELECT * FROM reports WHERE run_id = ? ORDER BY version DESC').all(runId) as Row[]
    return rows.map((r) => ({ id: String(r.id), runId: String(r.run_id), taskId: r.task_id ? String(r.task_id) : null, version: Number(r.version), author: String(r.author), markdown: String(r.markdown), createdAt: String(r.created_at) }))
  }

  latestReport(runId: string): ReportVersion | null {
    const r = this.db.prepare('SELECT * FROM reports WHERE run_id = ? ORDER BY version DESC LIMIT 1').get(runId) as Row | undefined
    if (!r) return null
    return {
      id: String(r.id),
      runId: String(r.run_id),
      taskId: optStr(r.task_id),
      version: Number(r.version),
      author: String(r.author),
      markdown: String(r.markdown),
      createdAt: String(r.created_at),
    }
  }

  // ------------------------------------------------------------- rule changes

  proposeRuleChange(lease: Lease, input: { op: 'add' | 'remove'; ruleId: string | null; role: RuleChange['role']; text: string; rationale: string }, max = 5): RuleChange {
    return this.tx(() => {
      this.assertOwner(lease)
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM rule_changes WHERE run_id = ?').get(lease.runId) as Row
      if (Number(count.n) >= max) throw new ConflictError(`this run already proposed the maximum of ${max} rule changes`)
      const change: RuleChange = {
        id: this.newId('chg'),
        runId: lease.runId,
        taskId: lease.taskId,
        runtime: lease.runtime,
        op: input.op,
        ruleId: input.ruleId,
        role: input.role,
        text: input.text,
        rationale: input.rationale,
        status: 'proposed',
        decidedBy: null,
        decisionReason: null,
        decidedAt: null,
        createdAt: this.now(),
      }
      this.db
        .prepare(
          `INSERT INTO rule_changes (id, run_id, task_id, runtime, op, rule_id, role, text, rationale, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        )
        .run(change.id, change.runId, change.taskId, change.runtime, change.op, change.ruleId, change.role, change.text, change.rationale, change.createdAt)
      this.append(lease.runId, lease.taskId, 'rule_change_proposed', { change_id: change.id, op: change.op, role: change.role, text: change.text, rule_id: change.ruleId })
      return change
    })
  }

  private toRuleChange(r: Row): RuleChange {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      taskId: String(r.task_id),
      runtime: r.runtime as RuntimeId,
      op: r.op as 'add' | 'remove',
      ruleId: optStr(r.rule_id),
      role: r.role as RuleChange['role'],
      text: String(r.text),
      rationale: String(r.rationale),
      status: r.status as RuleChange['status'],
      decidedBy: optStr(r.decided_by),
      decisionReason: optStr(r.decision_reason),
      decidedAt: optStr(r.decided_at),
      createdAt: String(r.created_at),
    }
  }

  listRuleChanges(filter: { runId?: string; status?: RuleChange['status'] } = {}): RuleChange[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.runId) {
      clauses.push('run_id = ?')
      params.push(filter.runId)
    }
    if (filter.status) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.db.prepare(`SELECT * FROM rule_changes ${where} ORDER BY created_at DESC, rowid DESC`).all(...params) as Row[]).map((r) => this.toRuleChange(r))
  }

  /** Accepting a change writes a new DNA version on top of the current one. */
  decideRuleChange(input: { changeId: string; decision: 'accepted' | 'rejected'; reason: string; by: string }): { change: RuleChange; dna: DnaVersion | null } {
    if (!input.reason.trim()) throw new ConflictError('a decision needs a reason')
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM rule_changes WHERE id = ?').get(input.changeId) as Row | undefined
      if (!row) throw new NotFoundError(`rule change ${input.changeId}`)
      const change = this.toRuleChange(row)
      if (change.status !== 'proposed') throw new ConflictError(`this change was already ${change.status}`)
      this.db
        .prepare('UPDATE rule_changes SET status = ?, decided_by = ?, decision_reason = ?, decided_at = ? WHERE id = ?')
        .run(input.decision, input.by, input.reason.trim(), this.now(), change.id)
      this.append(change.runId, null, 'rule_change_decided', { change_id: change.id, status: input.decision, by: input.by, reason: input.reason.trim() })
      let dna: DnaVersion | null = null
      if (input.decision === 'accepted') {
        const current = this.currentDna()
        let rules = current.rules
        if (change.op === 'remove') {
          if (!rules.some((r) => r.id === change.ruleId)) throw new ConflictError('the rule this change removes is no longer in the DNA')
          rules = rules.filter((r) => r.id !== change.ruleId)
        } else {
          rules = [...rules, { id: this.newId('rule'), role: change.role, text: change.text, origin: { runId: change.runId, runtime: change.runtime }, addedInVersion: current.version + 1 }]
        }
        dna = this.addDnaVersion({ rules, parentId: current.id, note: `${change.op === 'add' ? 'Added' : 'Removed'}: ${change.text}`, createdBy: input.by })
        this.append(change.runId, null, 'dna_versioned', { dna_id: dna.id, version: dna.version, change_id: change.id })
      }
      return { change: this.toRuleChange(this.db.prepare('SELECT * FROM rule_changes WHERE id = ?').get(change.id) as Row), dna }
    })
  }

  // ------------------------------------------------------------------- events

  /** Every event with seq > afterSeq (optionally one run), ascending, plus
   * the global high-water mark this read covered. */
  catchUp(afterSeq: number, runId: string | null = null, limit = 10_000): { events: Envelope[]; highWaterSeq: number; complete: boolean } {
    const highWaterSeq = this.latestSeq()
    const rows = runId
      ? (this.db.prepare('SELECT * FROM events WHERE seq > ? AND seq <= ? AND run_id = ? ORDER BY seq LIMIT ?').all(afterSeq, highWaterSeq, runId, limit + 1) as Row[])
      : (this.db.prepare('SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?').all(afterSeq, highWaterSeq, limit + 1) as Row[])
    const complete = rows.length <= limit
    return { events: rows.slice(0, limit).map((r) => this.toEnvelope(r)), highWaterSeq, complete }
  }

  latestSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as Row
    return Number(row.s)
  }

  // -------------------------------------------------------------- summaries

  summarize(runId: string): RunSummary {
    const summary: RunSummary = { claims: 0, confirmed: 0, rejected: 0, inconclusive: 0, needs_review: 0, candidate: 0, ruleChanges: 0 }
    for (const c of this.listClaims(runId)) {
      summary.claims += 1
      summary[c.status] += 1
    }
    summary.ruleChanges = this.listRuleChanges({ runId }).length
    return summary
  }

  /** On boot, nothing from a previous process still owns work. Make that
   * explicit instead of leaving runs that look alive. */
  recoverOrphans(reason: string): string[] {
    const recovered: string[] = []
    const live = this.db.prepare("SELECT id, state FROM runs WHERE state IN ('running', 'pause_requested', 'paused', 'cancel_requested')").all() as Row[]
    for (const row of live) {
      const runId = String(row.id)
      for (const task of this.listTasks(runId)) if (task.status === 'running') this.revokeTask(task.id, 'error', reason)
      if (row.state === 'cancel_requested') {
        this.transitionRun(runId, 'cancel', 'run_cancelled', { mode: 'recovered_after_restart' }, { terminalReason: reason, summary: this.summarize(runId) })
      } else {
        this.transitionRun(runId, 'fail', 'run_failed', { reason }, { terminalReason: reason, summary: this.summarize(runId) })
      }
      recovered.push(runId)
    }
    return recovered
  }
}
