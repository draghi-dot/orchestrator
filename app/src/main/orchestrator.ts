/** Durable five-phase audit pipeline. Worker prose is never a verdict. */
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Phase, Role, Run, WorkerProfile } from '../shared/domain'
import { PHASE_ROLE, TERMINAL_RUN_STATES } from '../shared/domain'
import { bounded } from '../shared/events'
import { settleClaim } from '../shared/verdict'
import type { EvidenceStore } from './evidence'
import type { ToolGateway } from './gateway'
import type { KnowledgeBase } from './knowledge'
import type { ProcessManager } from './processes'
import { assignmentPrompt, systemPrompt } from './prompts'
import type { AgentRuntime, Assignment, Outcome } from './runtimes/types'
import { type Lease, type QaStore, type StartRunInput, StaleOwnershipError } from './store'
import { TaskTools, type Purpose } from './tools'
import { type NodeRunner, verifyClaim, writeRegressionTest } from './verify'

export interface OrchestratorOptions {
  store: QaStore
  evidence: EvidenceStore
  processes: ProcessManager
  runtimes: (profile: WorkerProfile) => AgentRuntime
  runRoot: string
  gateway?: ToolGateway
  bridgePath?: string
  node?: NodeRunner
  knowledge?: () => KnowledgeBase | null
  workerId?: string
  heartbeatMs?: number
  cancelGraceMs?: number
  fetchImpl?: typeof fetch
}

class CancelledError extends Error {}
interface ActiveRun {
  runId: string
  controller: AbortController
  gate: (() => void) | null
  runDir: string
  workdir: string | null
}

export class Orchestrator {
  private readonly store: QaStore
  private readonly workerId: string
  private running: Promise<void> | null = null
  private kickRequested = false
  private stopped = false
  private active: ActiveRun | null = null

  constructor(private readonly options: OrchestratorOptions) {
    this.store = options.store
    this.workerId = options.workerId ?? `worker-${process.pid}`
  }

  start(input: StartRunInput): { run: Run; created: boolean } {
    if (this.stopped) throw new Error('The application is shutting down')
    const result = this.store.startRun(input)
    this.kick()
    return result
  }

  requestPause(runId: string, by: string): Run {
    return this.store.transitionRun(runId, 'request_pause', 'run_pause_requested', { by })
  }

  resume(runId: string, by: string): Run {
    const run = this.store.transitionRun(runId, 'resume', 'run_resumed', { by })
    if (this.active?.runId === runId) {
      this.active.gate?.()
      this.active.gate = null
    }
    return run
  }

  requestCancel(runId: string, by: string): Run {
    const current = this.store.getRun(runId)
    if (TERMINAL_RUN_STATES.has(current.state) || current.state === 'cancel_requested') return current
    if (current.state === 'queued') {
      return this.store.transitionRun(runId, 'cancel', 'run_cancelled', { mode: 'before_start', by }, { terminalReason: 'Cancelled before start', summary: this.store.summarize(runId) })
    }
    const run = this.store.transitionRun(runId, 'request_cancel', 'run_cancel_requested', { by })
    if (this.active?.runId === runId) {
      this.active.controller.abort('cancelled')
      this.active.gate?.()
      this.active.gate = null
    }
    return run
  }

  kick(): void {
    if (this.stopped) return
    if (this.running) { this.kickRequested = true; return }
    this.running = this.loop().finally(() => {
      this.running = null
      if (this.kickRequested && !this.stopped) { this.kickRequested = false; this.kick() }
    })
  }

  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    if (this.active) this.requestCancel(this.active.runId, 'application shutdown')
    await this.idle()
    await this.options.processes.stopAll()
  }

  private async checkpoint(runId: string): Promise<void> {
    for (;;) {
      const state = this.store.getRun(runId).state
      if (state === 'cancel_requested' || this.active?.controller.signal.aborted) throw new CancelledError('Run cancelled')
      if (this.stopped) throw new CancelledError('Application shutting down')
      if (state === 'running') return
      if (state === 'pause_requested') {
        this.store.transitionRun(runId, 'pause_acknowledged', 'run_paused', {})
        continue
      }
      if (state === 'paused') {
        await new Promise<void>((resolve) => { if (this.active) this.active.gate = resolve; else resolve() })
        continue
      }
      throw new Error(`Cannot continue a ${state} run`)
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const run = this.store.nextQueuedRun()
      if (!run) return
      try {
        await this.execute(run)
      } catch (err) {
        const reason = bounded(err instanceof Error ? err.message : String(err), 1000)
        const cancelled = this.store.getRun(run.id).state === 'cancel_requested'
        for (const task of this.store.listTasks(run.id)) {
          if (task.status === 'running') this.store.revokeTask(task.id, cancelled ? 'cancelled' : 'error', reason)
        }
        if (!TERMINAL_RUN_STATES.has(this.store.getRun(run.id).state)) {
          this.store.transitionRun(run.id, cancelled ? 'cancel' : 'fail', cancelled ? 'run_cancelled' : 'run_failed', cancelled ? { mode: 'stopped', reason } : { reason }, {
            terminalReason: reason, summary: this.store.summarize(run.id),
          })
        }
      } finally {
        const url = await this.options.processes.stopApp(run.id)
        if (url) this.store.append(run.id, null, 'app_stopped', { url, reason: 'Run finished' })
        this.active = null
      }
    }
  }

  private async execute(initial: Run): Promise<void> {
    const runDir = join(this.options.runRoot, initial.id)
    mkdirSync(runDir, { recursive: true })
    this.active = { runId: initial.id, controller: new AbortController(), gate: null, runDir, workdir: null }
    const run = this.store.transitionRun(initial.id, 'start', 'run_started', { worker_id: this.workerId })
    if (run.contract.mode !== 'white' && !run.contract.externalUrl && run.contract.allowCommands) {
      const workdir = join(runDir, 'app')
      cpSync(this.store.getSnapshot(run.contract.snapshotId).rootPath, workdir, { recursive: true, dereference: false })
      this.active.workdir = workdir
    }

    await this.phase(run, 'build', async () => {
      if (run.contract.mode === 'white') return 'Source-only audit; no app process required'
      if (run.contract.externalUrl) return 'Using the authorized test URL'
      await this.task(run, 'build', 0, 1)
      if (!this.store.getRun(run.id).appUrl) throw new Error('Builder did not start the app; running-app audit cannot continue')
      return 'App started and ready for testing'
    })
    await this.phase(run, 'research', async () => {
      await this.task(run, 'research', 0, 1)
      await this.task(run, 'research', 1, 1, 'reporter', 'research', false)
      return `${this.store.listClaims(run.id).length} findings proposed`
    })
    await this.phase(run, 'challenge', async () => {
      for (let round = 1; round <= run.contract.limits.maxRounds; round++) {
        await this.checkpoint(run.id)
        if (round > 1) {
          const contested = this.store.listClaims(run.id).filter((c) => !c.withdrawn && ['needs_review', 'inconclusive'].includes(c.status))
          if (!contested.length) break
          this.store.append(run.id, null, 'round_started', { round })
          await this.task(run, 'challenge', round * 2 - 1, round, 'researcher', 'revise')
        } else {
          this.store.append(run.id, null, 'round_started', { round })
        }
        if (!this.store.listClaims(run.id).some((c) => c.status === 'candidate' && !c.withdrawn)) break
        await this.task(run, 'challenge', round * 2, round)
        await this.verify(run, round)
      }
      for (const claim of this.store.listClaims(run.id)) {
        if (claim.status === 'candidate') this.store.settleClaim(claim.id, 'inconclusive', 'No completed evidence and challenge cycle')
      }
      return 'Host evidence checks and debate finished'
    })
    await this.phase(run, 'report', async () => {
      const previousReport = this.store.latestReport(run.id)?.id
      await this.task(run, 'report', 0, 1)
      if (this.store.latestReport(run.id)?.id === previousReport) this.store.writeReport(run.id, null, 'QA Arena host', this.fallbackReport(run))
      return 'Final report saved'
    })
    await this.phase(run, 'improve', async () => {
      await this.task(run, 'improve', 0, 1)
      return 'Proposed DNA changes await your review'
    })
    await this.checkpoint(run.id)
    const summary = this.store.summarize(run.id)
    this.store.transitionRun(run.id, 'complete', 'run_completed', { summary }, { summary })
  }

  private async phase(run: Run, phase: Phase, fn: () => Promise<string>): Promise<void> {
    await this.checkpoint(run.id)
    this.store.append(run.id, null, 'phase_started', { phase })
    try {
      const note = await fn()
      await this.checkpoint(run.id)
      const blocked = this.store.listTasks(run.id).filter((t) => t.phase === phase && t.status === 'blocked')
      this.store.append(run.id, null, 'phase_finished', { phase, status: blocked.length ? 'blocked' : 'done', note: blocked.length ? `${note}. Worker limitations: ${blocked.map((t) => t.terminalReason).join('; ')}` : note })
    } catch (err) {
      this.store.append(run.id, null, 'phase_finished', { phase, status: err instanceof CancelledError ? 'cancelled' : 'error', note: bounded(String(err), 500) })
      throw err
    }
  }

  private async verify(run: Run, round: number): Promise<void> {
    const active = this.active!
    const deps = { store: this.store, evidence: this.options.evidence, signal: active.controller.signal, fetchImpl: this.options.fetchImpl }
    for (const claim of this.store.listClaims(run.id).filter((c) => c.status === 'candidate' && !c.withdrawn)) {
      await this.checkpoint(run.id)
      const result = await verifyClaim(deps, run, claim)
      await this.checkpoint(run.id)
      this.store.recordVerification(run.id, { claimId: claim.id, round, ...result })
      const stances = this.store.listChallenges(claim.id).filter((c) => c.round === round).map((c) => c.stance)
      const verdict = settleClaim(result.outcome, stances)
      const settled = this.store.settleClaim(claim.id, verdict.status, verdict.reason)
      if (settled.status === 'confirmed' && settled.reproduction) {
        const regression = await writeRegressionTest({ ...deps, runDir: active.runDir, node: this.options.node ?? { command: process.execPath, env: {} } }, run, settled)
        await this.checkpoint(run.id)
        if (regression && !regression.failsNow) this.store.settleClaim(claim.id, 'needs_review', regression.execution === 'passed' ? 'Replay reproduced the defect, but its regression test passed; investigate inconsistent behavior.' : 'The generated regression test could not execute successfully; inspect its artifact.')
      }
    }
  }

  private async task(run: Run, phase: Phase, ordinal: number, round: number, role: Role = PHASE_ROLE[phase], purpose: Purpose = 'research', finalReport = true): Promise<void> {
    await this.checkpoint(run.id)
    const active = this.active!
    const profile = run.contract.roster[role]
    const runtime = this.options.runtimes(profile)
    const lease = this.store.createTask(run.id, role, phase, ordinal, runtime.id, this.workerId)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, active.controller.signal])
    const snapshot = this.store.getSnapshot(run.contract.snapshotId)
    const dna = this.store.getDna(run.contract.dnaVersionId)
    const tools = new TaskTools({
      store: this.store, evidence: this.options.evidence, processes: this.options.processes, lease, run,
      snapshotRoot: snapshot.rootPath, workdir: active.workdir, dna, signal,
      fetchImpl: this.options.fetchImpl, knowledge: this.options.knowledge?.(), round, purpose,
    })
    const scratchDir = join(active.runDir, lease.taskId)
    mkdirSync(scratchDir, { recursive: true })
    const token = this.options.gateway?.register(tools)
    const node = this.options.node ?? { command: process.execPath, env: {} }
    const bridge = token && this.options.gateway && this.options.bridgePath ? {
      command: node.command, args: [this.options.bridgePath],
      env: { ...node.env, QA_GATEWAY_URL: this.options.gateway.url, QA_GATEWAY_TOKEN: token },
    } : null
    const timeout = run.contract.limits.taskTimeoutSeconds[role]
    const current = this.store.getRun(run.id)
    const assignment: Assignment = {
      taskId: lease.taskId, runId: run.id, role, phase, mode: run.contract.mode, model: profile.model,
      systemPrompt: systemPrompt(role, run.contract.mode, tools.rules()),
      prompt: assignmentPrompt({ role, mode: run.contract.mode, targetName: run.contract.targetName, snapshot,
        appUrl: current.appUrl ?? run.contract.externalUrl, codeAccess: tools.access().code,
        toolBudget: run.contract.limits.toolBudget[role], deadlineSeconds: timeout,
        claimCount: this.store.listClaims(run.id).length, finalReport,
      }) + `\nDebate round: ${round}. Task purpose: ${purpose}.\nAudit instructions: ${JSON.stringify(run.contract.audit)}\nApproved test accounts (names only): ${tools.accounts().join(', ') || 'none'}.`,
      deadlineSeconds: timeout,
      context: { targetName: run.contract.targetName, stack: snapshot.stack, appUrl: current.appUrl ?? run.contract.externalUrl, finalReport },
    }
    const heartbeat = setInterval(() => {
      try { this.store.workerAppend(lease, 'worker_heartbeat', { worker_id: this.workerId }) } catch { /* lease closed */ }
    }, this.options.heartbeatMs ?? 5000)
    const deadline = setTimeout(() => controller.abort('timeout'), timeout * 1000)
    let grace: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}
    const forced = new Promise<null>((resolve) => {
      onAbort = () => { grace = setTimeout(() => resolve(null), this.options.cancelGraceMs ?? 3000) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const execution = Promise.resolve().then(() => runtime.execute(assignment, {
        tools, signal, bridge, scratchDir,
        checkpoint: async () => { await this.checkpoint(run.id); signal.throwIfAborted() },
      })).catch((err): Outcome => ({ kind: signal.aborted ? 'cancelled' : 'error', reason: bounded(String(err), 500) }))
      const outcome = await Promise.race([execution, forced])
      if (active.controller.signal.aborted) {
        this.store.revokeTask(lease.taskId, 'cancelled', outcome === null ? 'Worker force stopped after cancellation' : 'Run cancelled')
        throw new CancelledError('Run cancelled')
      }
      if (controller.signal.reason === 'timeout') {
        this.store.revokeTask(lease.taskId, 'error', `Worker exceeded ${timeout}s deadline`)
        throw new Error(`${role} exceeded ${timeout}s deadline`)
      }
      if (!outcome) throw new Error(`${role} worker did not finish`)
      this.conclude(lease, outcome, tools)
      if (outcome.kind === 'error' || outcome.kind === 'cancelled') throw new Error(`${role}: ${outcome.reason}`)
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadline)
      if (grace) clearTimeout(grace)
      signal.removeEventListener('abort', onAbort)
      if (token) this.options.gateway?.unregister(token)
      controller.abort('task closed')
    }
  }

  private conclude(lease: Lease, outcome: Outcome, tools: TaskTools): void {
    const status = outcome.kind === 'finished' ? (tools.blockedReason ? 'blocked' : 'done') : outcome.kind
    try {
      this.store.finishTask(lease, status, tools.blockedReason ?? outcome.reason, {
        usage: outcome.usage ?? null, exit_code: outcome.exitCode ?? null,
        diagnostics: outcome.diagnostics ? bounded(outcome.diagnostics, 2000) : null,
      })
    } catch (err) { if (!(err instanceof StaleOwnershipError)) throw err }
  }

  private fallbackReport(run: Run): string {
    const claims = this.store.listClaims(run.id)
    return `# ${run.contract.targetName} QA report\n\nReporter produced no report. The following facts were recorded by the host.\n\n` +
      claims.map((c) => `- **${c.status}** — ${c.title} (${c.id}): ${c.verdictReason ?? 'No verdict'}`).join('\n') +
      '\n\n## Coverage limits\n\nThis report does not establish that untested behavior is correct.\n'
  }
}
