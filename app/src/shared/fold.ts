/**
 * The ONE fold for a run (after Kestrel's apply.ts).
 *
 * Live, catch-up, and replay are all `state' = applyRunEvent(state, event)`
 * over the ordered event stream. Live is the fold pinned to the leading
 * edge; replay is the fold stopped at a playhead. There is no second
 * rendering path, so live and replay cannot disagree.
 *
 * Pure: no I/O, no React. Idempotent: an event with `seq <= state.seq` is a
 * no-op. Total: an event type with no visual mapping still advances `seq`.
 */

import type { AuditConfig, ClaimStatus, EvidenceOutcome, Phase, Role, RunState, RuntimeId, Stance, TaskStatus, TestMode } from './domain'
import { PHASES, ROLES } from './domain'
import type { Envelope } from './events'
import { claimTruth } from './verdict'

export type PhaseStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'blocked'

export interface TaskView {
  taskId: string
  role: Role
  phase: Phase
  runtime: RuntimeId
  attemptNumber: number
  status: TaskStatus
  reason: string | null
  startedAt: string
  endedAt: string | null
  lastHeartbeatAt: string | null
  toolCalls: number
  rejectedToolCalls: number
  lastTool: string | null
  messages: string[]
  blockedReason: string | null
  usage: Record<string, unknown> | null
}

export interface ChallengeView {
  taskId: string | null
  runtime: RuntimeId | null
  round: number
  stance: Stance
  reasoning: string
}

export interface EvidenceView {
  round: number
  outcome: EvidenceOutcome
  expected: string | null
  actual: string | null
  detail: string
  artifactId: string | null
}

export interface ClaimView {
  claimId: string
  taskId: string | null
  role: Role | null
  runtime: RuntimeId | null
  title: string
  category: string
  severity: string
  area: string
  location: string | null
  hasRepro: boolean
  status: ClaimStatus
  verdictReason: string | null
  round: number
  revisions: { round: number; action: string }[]
  withdrawn: boolean
  challenges: ChallengeView[]
  evidence: EvidenceView[]
  regressionTest: { artifactId: string; failsNow: boolean } | null
  review: { decision: 'accepted' | 'rejected'; reason: string; reviewer: string } | null
  seq: number
}

export interface RuleChangeView {
  changeId: string
  op: string
  role: string
  text: string
  status: 'proposed' | 'accepted' | 'rejected'
  runtime: RuntimeId | null
}

export interface ArtifactView {
  artifactId: string
  taskId: string | null
  label: string
  mime: string
  bytes: number
  sha256: string
  seq: number
}

export interface RunView {
  seq: number
  runId: string | null
  state: RunState | 'unknown'
  targetName: string | null
  mode: TestMode | null
  audit: AuditConfig | null
  roster: Partial<Record<Role, { runtime: RuntimeId; model: string }>>
  dnaVersion: number | null
  initiator: string | null
  createdAt: string | null
  startedAt: string | null
  endedAt: string | null
  terminalReason: string | null
  cancelRequestedBy: string | null
  round: number
  phases: Record<Phase, { status: PhaseStatus; note: string | null }>
  taskOrder: string[]
  tasks: Record<string, TaskView>
  activeTaskId: string | null
  claimOrder: string[]
  claims: Record<string, ClaimView>
  artifacts: Record<string, ArtifactView>
  app: { url: string; command: string; running: boolean } | null
  surface: { kind: string; name: string }[]
  reports: { reportId: string; version: number; author: string; seq: number }[]
  ruleChanges: RuleChangeView[]
}

const emptyPhases = (): RunView['phases'] =>
  Object.fromEntries(PHASES.map((p) => [p, { status: 'waiting' as PhaseStatus, note: null }])) as RunView['phases']

export const initialRunView: RunView = Object.freeze({
  seq: 0,
  runId: null,
  state: 'unknown',
  targetName: null,
  mode: null,
  audit: null,
  roster: {},
  dnaVersion: null,
  initiator: null,
  createdAt: null,
  startedAt: null,
  endedAt: null,
  terminalReason: null,
  cancelRequestedBy: null,
  round: 0,
  phases: emptyPhases(),
  taskOrder: [],
  tasks: {},
  activeTaskId: null,
  claimOrder: [],
  claims: {},
  artifacts: {},
  app: null,
  surface: [],
  reports: [],
  ruleChanges: [],
}) as RunView

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function withTask(state: RunView, taskId: string | null, fn: (t: TaskView) => TaskView): RunView {
  if (taskId === null) return state
  const current = state.tasks[taskId]
  if (!current) return state
  return { ...state, tasks: { ...state.tasks, [taskId]: fn(current) } }
}

function withClaim(state: RunView, claimId: string, fn: (c: ClaimView) => ClaimView): RunView {
  const current = state.claims[claimId]
  if (!current) return state
  return { ...state, claims: { ...state.claims, [claimId]: fn(current) } }
}

const pushMessage = (messages: string[], text: string) => [...messages, text].slice(-6)

export function applyRunEvent(state: RunView, event: Envelope): RunView {
  if (event.seq <= state.seq) return state
  if (state.runId !== null && event.runId !== state.runId) return { ...state, seq: event.seq }

  const p = event.payload
  let next: RunView = { ...state, seq: event.seq, runId: event.runId }

  switch (event.type) {
    case 'run_created': {
      const roster = (p.roster && typeof p.roster === 'object' ? p.roster : {}) as RunView['roster']
      next = {
        ...next,
        state: 'queued',
        targetName: str(p.target_name),
        mode: str(p.mode) as TestMode,
        audit: (p.audit && typeof p.audit === 'object' ? p.audit : null) as AuditConfig | null,
        roster,
        dnaVersion: Number(p.dna_version) || null,
        initiator: str(p.initiator),
        createdAt: event.ts,
      }
      break
    }
    case 'run_started':
      next = { ...next, state: 'running', startedAt: event.ts }
      break
    case 'run_pause_requested':
      next = { ...next, state: 'pause_requested' }
      break
    case 'run_paused':
      next = { ...next, state: 'paused' }
      break
    case 'run_resumed':
      next = { ...next, state: 'running' }
      break
    case 'run_cancel_requested':
      next = { ...next, state: 'cancel_requested', cancelRequestedBy: str(p.by) }
      break
    case 'run_cancelled':
      next = { ...next, state: 'cancelled', endedAt: event.ts, terminalReason: str(p.mode), activeTaskId: null }
      break
    case 'run_completed':
      next = { ...next, state: 'completed', endedAt: event.ts, activeTaskId: null }
      break
    case 'run_failed':
      next = { ...next, state: 'failed', endedAt: event.ts, terminalReason: str(p.reason), activeTaskId: null }
      break
    case 'phase_started': {
      const phase = str(p.phase) as Phase
      if (!next.phases[phase]) break
      next = { ...next, phases: { ...next.phases, [phase]: { status: 'running', note: null } } }
      break
    }
    case 'phase_finished': {
      const phase = str(p.phase) as Phase
      if (!next.phases[phase]) break
      next = { ...next, phases: { ...next.phases, [phase]: { status: str(p.status) as PhaseStatus, note: strOrNull(p.note) } } }
      break
    }
    case 'round_started':
      next = { ...next, round: Number(p.round) || next.round }
      break
    case 'task_started': {
      if (event.taskId === null) break
      const task: TaskView = {
        taskId: event.taskId,
        role: str(p.role) as Role,
        phase: str(p.phase) as Phase,
        runtime: str(p.runtime) as RuntimeId,
        attemptNumber: Number(p.attempt_number) || 1,
        status: 'running',
        reason: null,
        startedAt: event.ts,
        endedAt: null,
        lastHeartbeatAt: null,
        toolCalls: 0,
        rejectedToolCalls: 0,
        lastTool: null,
        messages: [],
        blockedReason: null,
        usage: null,
      }
      next = {
        ...next,
        tasks: { ...next.tasks, [event.taskId]: task },
        taskOrder: next.taskOrder.includes(event.taskId) ? next.taskOrder : [...next.taskOrder, event.taskId],
        activeTaskId: event.taskId,
      }
      break
    }
    case 'task_finished':
      next = withTask(next, event.taskId, (t) => ({
        ...t,
        status: str(p.status) as TaskStatus,
        reason: strOrNull(p.reason),
        endedAt: event.ts,
        usage: p.usage && typeof p.usage === 'object' ? (p.usage as Record<string, unknown>) : t.usage,
      }))
      if (next.activeTaskId === event.taskId) next = { ...next, activeTaskId: null }
      break
    case 'worker_heartbeat':
      next = withTask(next, event.taskId, (t) => ({ ...t, lastHeartbeatAt: event.ts }))
      break
    case 'agent_message':
      next = withTask(next, event.taskId, (t) => ({ ...t, messages: pushMessage(t.messages, str(p.text)) }))
      break
    case 'agent_blocked':
      next = withTask(next, event.taskId, (t) => ({ ...t, blockedReason: str(p.reason) }))
      break
    case 'tool_called':
      next = withTask(next, event.taskId, (t) => ({ ...t, toolCalls: t.toolCalls + 1 }))
      break
    case 'tool_result':
      next = withTask(next, event.taskId, (t) => ({ ...t, lastTool: str(p.summary) }))
      break
    case 'tool_rejected':
      next = withTask(next, event.taskId, (t) => ({ ...t, rejectedToolCalls: t.rejectedToolCalls + 1, lastTool: `Refused: ${str(p.reason)}` }))
      break
    case 'artifact_saved': {
      const artifactId = str(p.artifact_id)
      next = {
        ...next,
        artifacts: {
          ...next.artifacts,
          [artifactId]: { artifactId, taskId: event.taskId, label: str(p.label), mime: str(p.mime), bytes: Number(p.bytes) || 0, sha256: str(p.sha256), seq: event.seq },
        },
      }
      break
    }
    case 'app_started':
      next = { ...next, app: { url: str(p.url), command: str(p.command), running: true } }
      break
    case 'app_stopped':
      if (next.app) next = { ...next, app: { ...next.app, running: false } }
      break
    case 'surface_noted':
      next = { ...next, surface: [...next.surface, { kind: str(p.kind), name: str(p.name) }] }
      break
    case 'claim_proposed': {
      const claimId = str(p.claim_id)
      const proposer = event.taskId ? next.tasks[event.taskId] : undefined
      const claim: ClaimView = {
        claimId,
        taskId: event.taskId,
        role: proposer?.role ?? null,
        runtime: proposer?.runtime ?? null,
        title: str(p.title),
        category: str(p.category),
        severity: str(p.severity),
        area: str(p.area),
        location: strOrNull(p.location),
        hasRepro: p.has_repro === true,
        status: 'candidate',
        verdictReason: null,
        round: 1,
        revisions: [],
        withdrawn: false,
        challenges: [],
        evidence: [],
        regressionTest: null,
        review: null,
        seq: event.seq,
      }
      next = { ...next, claims: { ...next.claims, [claimId]: claim }, claimOrder: [...next.claimOrder, claimId] }
      break
    }
    case 'claim_revised': {
      const action = str(p.action)
      const round = Number(p.round) || 1
      next = withClaim(next, str(p.claim_id), (c) => ({
        ...c,
        round,
        revisions: [...c.revisions, { round, action }],
        withdrawn: c.withdrawn || action === 'withdraw',
        hasRepro: action === 'amend' && p.has_repro === true ? true : c.hasRepro,
        status: action === 'amend' ? 'candidate' : c.status,
      }))
      break
    }
    case 'challenge_recorded': {
      const challenger = event.taskId ? next.tasks[event.taskId] : undefined
      next = withClaim(next, str(p.claim_id), (c) => ({
        ...c,
        challenges: [
          ...c.challenges,
          { taskId: event.taskId, runtime: challenger?.runtime ?? null, round: Number(p.round) || 1, stance: str(p.stance) as Stance, reasoning: str(p.reasoning) },
        ],
      }))
      break
    }
    case 'evidence_checked':
      next = withClaim(next, str(p.claim_id), (c) => ({
        ...c,
        evidence: [
          ...c.evidence,
          {
            round: Number(p.round) || 1,
            outcome: str(p.outcome) as EvidenceOutcome,
            expected: strOrNull(p.expected),
            actual: strOrNull(p.actual),
            detail: str(p.detail),
            artifactId: strOrNull(p.artifact_id),
          },
        ],
      }))
      break
    case 'claim_verdict':
      next = withClaim(next, str(p.claim_id), (c) => ({ ...c, status: str(p.status) as ClaimStatus, verdictReason: str(p.reason) }))
      break
    case 'regression_test_written':
      next = withClaim(next, str(p.claim_id), (c) => ({ ...c, regressionTest: { artifactId: str(p.artifact_id), failsNow: p.fails_now === true } }))
      break
    case 'claim_reviewed':
      next = withClaim(next, str(p.claim_id), (c) => ({
        ...c,
        review: { decision: str(p.decision) as 'accepted' | 'rejected', reason: str(p.reason), reviewer: str(p.reviewer) },
      }))
      break
    case 'report_written':
      next = { ...next, reports: [...next.reports, { reportId: str(p.report_id), version: Number(p.version) || 0, author: str(p.author), seq: event.seq }] }
      break
    case 'rule_change_proposed': {
      const proposer = event.taskId ? next.tasks[event.taskId] : undefined
      next = {
        ...next,
        ruleChanges: [...next.ruleChanges, { changeId: str(p.change_id), op: str(p.op), role: str(p.role), text: str(p.text), status: 'proposed', runtime: proposer?.runtime ?? null }],
      }
      break
    }
    case 'rule_change_decided':
      next = {
        ...next,
        ruleChanges: next.ruleChanges.map((r) => (r.changeId === str(p.change_id) ? { ...r, status: str(p.status) as RuleChangeView['status'] } : r)),
      }
      break
    default:
      break
  }
  return next
}

export function foldRun(events: readonly Envelope[], upToSeq = Number.POSITIVE_INFINITY): RunView {
  let state = initialRunView
  for (const event of events) {
    if (event.seq > upToSeq) break
    state = applyRunEvent(state, event)
  }
  return state
}

/** A claim's status after a person's decision, if any. */
export function effectiveStatus(c: Pick<ClaimView, 'status' | 'review'>): ClaimStatus {
  if (c.review?.decision === 'accepted') return 'confirmed'
  if (c.review?.decision === 'rejected') return 'rejected'
  return c.status
}

export interface ArenaMetrics {
  claims: number
  confirmed: number
  rejected: number
  inconclusive: number
  needsReview: number
  candidate: number
  /** Confirmed over everything settled either way. Null until something settles. */
  precision: number | null
  /** Share of claims the host checked with a replay or a code citation. */
  verificationCoverage: number | null
  /** Unsupported findings the arena stopped from reaching the report. */
  falsePositivesCaught: number
  regressionTests: number
}

export function arenaMetrics(view: RunView): ArenaMetrics {
  const m: ArenaMetrics = { claims: 0, confirmed: 0, rejected: 0, inconclusive: 0, needsReview: 0, candidate: 0, precision: null, verificationCoverage: null, falsePositivesCaught: 0, regressionTests: 0 }
  let checked = 0
  for (const id of view.claimOrder) {
    const c = view.claims[id]
    m.claims += 1
    const status = effectiveStatus(c)
    if (status === 'confirmed') m.confirmed += 1
    else if (status === 'rejected') m.rejected += 1
    else if (status === 'inconclusive') m.inconclusive += 1
    else if (status === 'needs_review') m.needsReview += 1
    else m.candidate += 1
    if (c.evidence.some((e) => e.outcome !== 'no_evidence' && e.outcome !== 'error')) checked += 1
    if (c.regressionTest) m.regressionTests += 1
  }
  const settled = m.confirmed + m.rejected
  m.precision = settled > 0 ? m.confirmed / settled : null
  m.verificationCoverage = m.claims > 0 ? checked / m.claims : null
  m.falsePositivesCaught = m.rejected
  return m
}

export interface ScoreLine {
  runtime: RuntimeId
  role: Role
  claimsMade: number
  claimsHeld: number
  claimsFell: number
  challenges: number
  challengesRight: number
  challengesWrong: number
}

/** Arena score: claims that held up versus fell, and challenges that called
 * it right versus wrong once a claim is settled (by evidence or a person). */
export function scoreboard(view: RunView): ScoreLine[] {
  const lines = new Map<string, ScoreLine>()
  const line = (runtime: RuntimeId, role: Role) => {
    const key = `${role}:${runtime}`
    let l = lines.get(key)
    if (!l) {
      l = { runtime, role, claimsMade: 0, claimsHeld: 0, claimsFell: 0, challenges: 0, challengesRight: 0, challengesWrong: 0 }
      lines.set(key, l)
    }
    return l
  }
  for (const id of view.claimOrder) {
    const c = view.claims[id]
    const truth = claimTruth(c.status, c.review?.decision ?? null)
    if (c.runtime && c.role) {
      const l = line(c.runtime, c.role)
      l.claimsMade += 1
      if (truth === true) l.claimsHeld += 1
      if (truth === false) l.claimsFell += 1
    }
    // Score each challenger on its latest stance for the claim.
    const latest = new Map<string, ChallengeView>()
    for (const ch of c.challenges) if (ch.taskId) latest.set(`${ch.runtime}`, ch)
    for (const ch of latest.values()) {
      if (!ch.runtime || !ch.taskId) continue
      const role = view.tasks[ch.taskId]?.role ?? 'thinker'
      const l = line(ch.runtime, role)
      l.challenges += 1
      if (truth === null || ch.stance === 'unsure') continue
      const right = (ch.stance === 'agree' && truth) || (ch.stance === 'dispute' && !truth)
      if (right) l.challengesRight += 1
      else l.challengesWrong += 1
    }
  }
  return [...lines.values()].sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role))
}
