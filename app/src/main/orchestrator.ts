/**
 * The dispatcher + worker loop (after Kestrel's dispatcher/job_runner.py and
 * supervision kernel), sized for phase 1: one worker, one assignment at a
 * time, runs taken FIFO from the durable queue.
 *
 * Operator commands only record intent (`*_requested`). The worker
 * acknowledges at a safe boundary and that acknowledgement is a separate
 * durable event, so the UI never treats a command response as proof that a
 * worker stopped. If a cancelled worker does not stop within the grace
 * period, its attempt is revoked (owner generation bumped) and the run is
 * cancelled with mode `force_stopped`; any late write from it is rejected.
 */

import type { AgentProfile, AttemptStatus, CaseDef, Run, RunSummary } from '../shared/domain'
import { TERMINAL_RUN_STATES } from '../shared/domain'
import { evaluateAssertion } from '../shared/assertions'
import { bounded } from '../shared/events'
import type { AgentAdapter, AgentOutcome, Assignment } from './adapters/types'
import type { EvidenceStore } from './evidence'
import { type Lease, type QaStore, type StartRunInput, StaleOwnershipError } from './store'
import { ToolBelt } from './toolbelt'

export interface OrchestratorOptions {
  store: QaStore
  evidence: EvidenceStore
  adapters: (profile: AgentProfile) => AgentAdapter
  workerId?: string
  heartbeatMs?: number
  cancelGraceMs?: number
  fetchImpl?: typeof fetch
}

type Gate = { resolve: () => void }

class CancelledError extends Error {
  constructor() {
    super('run cancelled')
  }
}

export class Orchestrator {
  private readonly store: QaStore
  private readonly workerId: string
  private readonly heartbeatMs: number
  private readonly cancelGraceMs: number
  private running: Promise<void> | null = null
  private kickRequested = false
  private stopped = false
  private active: { runId: string; lease: Lease | null; controller: AbortController | null; gate: Gate | null } | null = null

  constructor(private readonly options: OrchestratorOptions) {
    this.store = options.store
    this.workerId = options.workerId ?? `worker-${process.pid}`
    this.heartbeatMs = options.heartbeatMs ?? 5000
    this.cancelGraceMs = options.cancelGraceMs ?? 5000
  }

  // ---------------------------------------------------------------- commands

  start(input: StartRunInput): { run: Run; created: boolean } {
    const result = this.store.startRun(input)
    this.kick()
    return result
  }

  requestPause(runId: string, by: string): Run {
    return this.store.transitionRun(runId, 'request_pause', 'run_pause_requested', { by })
  }

  resume(runId: string, by: string): Run {
    const run = this.store.transitionRun(runId, 'resume', 'run_resumed', { by })
    if (this.active?.runId === runId && this.active.gate) {
      const gate = this.active.gate
      this.active.gate = null
      gate.resolve()
    }
    return run
  }

  requestCancel(runId: string, by: string): Run {
    const current = this.store.getRun(runId)
    if (current.state === 'queued') {
      return this.store.transitionRun(runId, 'cancel', 'run_cancelled', { mode: 'before_start', by }, { terminalReason: 'cancelled before start', summary: this.store.summarize(runId) })
    }
    const run = this.store.transitionRun(runId, 'request_cancel', 'run_cancel_requested', { by })
    if (this.active?.runId === runId) {
      this.active.controller?.abort('cancelled')
      if (this.active.gate) {
        const gate = this.active.gate
        this.active.gate = null
        gate.resolve()
      }
    }
    return run
  }

  /** Wake the worker loop. Safe to call any number of times. */
  kick(): void {
    if (this.stopped) return
    if (this.running) {
      this.kickRequested = true
      return
    }
    this.running = this.loop().finally(() => {
      this.running = null
      if (this.kickRequested && !this.stopped) {
        this.kickRequested = false
        this.kick()
      }
    })
  }

  /** Resolves when the queue is drained (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.active?.controller?.abort('shutdown')
    this.active?.gate?.resolve()
    await this.idle()
  }

  // ------------------------------------------------------------------- loop

  private async loop(): Promise<void> {
    for (;;) {
      if (this.stopped) return
      const run = this.store.nextQueuedRun()
      if (!run) return
      try {
        await this.execute(run)
      } catch (err) {
        const reason = `orchestrator error: ${bounded(err instanceof Error ? err.message : String(err), 500)}`
        for (const attempt of this.store.listAttempts(run.id)) {
          if (attempt.status === 'running') this.store.revokeAttempt(attempt.id, 'error', reason)
        }
        const latest = this.store.getRun(run.id)
        if (!TERMINAL_RUN_STATES.has(latest.state)) {
          if (latest.state === 'cancel_requested') {
            this.store.transitionRun(run.id, 'cancel', 'run_cancelled', { mode: 'graceful' }, { terminalReason: reason, summary: this.store.summarize(run.id) })
          } else {
            this.store.transitionRun(run.id, 'fail', 'run_failed', { reason }, { terminalReason: reason, summary: this.store.summarize(run.id) })
          }
        }
      } finally {
        this.active = null
      }
    }
  }

  private cancelRequested(runId: string): boolean {
    return this.store.getRun(runId).state === 'cancel_requested'
  }

  /** The pause/cancel boundary. Throws CancelledError when the run is being
   * cancelled; otherwise returns once the run is (again) running. */
  private async checkpoint(runId: string): Promise<void> {
    for (;;) {
      const state = this.store.getRun(runId).state
      if (state === 'cancel_requested') throw new CancelledError()
      if (state === 'running') return
      if (state === 'pause_requested') {
        this.store.transitionRun(runId, 'pause_acknowledged', 'run_paused', {})
        continue
      }
      if (state === 'paused') {
        await new Promise<void>((resolve) => {
          if (this.active) this.active.gate = { resolve }
        })
        continue
      }
      throw new Error(`run ${runId} is ${state}; worker cannot continue`)
    }
  }

  private async execute(run: Run): Promise<void> {
    this.active = { runId: run.id, lease: null, controller: null, gate: null }
    this.store.transitionRun(run.id, 'start', 'run_started', { worker_id: this.workerId })
    const version = this.store.getSuiteVersion(run.contract.suiteVersionId)
    const cases = run.contract.caseIds.map((id) => {
      const found = version.cases.find((c) => c.id === id)
      if (!found) throw new Error(`case ${id} missing from suite version ${version.id}`)
      return found
    })

    let forceStopped = false
    try {
      for (const testCase of cases) {
        if (this.stopped) throw new Error('app shutting down')
        await this.checkpoint(run.id)
        const result = await this.runAttempt(run, testCase)
        if (result === 'force_stopped') {
          forceStopped = true
          break
        }
      }
    } catch (err) {
      if (!(err instanceof CancelledError)) throw err
    }

    const summary: RunSummary = this.store.summarize(run.id)
    if (this.cancelRequested(run.id)) {
      this.store.transitionRun(run.id, 'cancel', 'run_cancelled', { mode: forceStopped ? 'force_stopped' : 'graceful' }, {
        terminalReason: forceStopped ? 'worker did not stop within the grace period' : 'operator cancelled',
        summary,
      })
      return
    }
    this.store.transitionRun(run.id, 'complete', 'run_completed', { summary }, { summary })
  }

  private async runAttempt(run: Run, testCase: CaseDef): Promise<AttemptStatus | 'force_stopped'> {
    const profile = run.contract.agent
    const adapter = this.options.adapters(profile)
    const lease = this.store.createAttempt(run.id, testCase.id, this.workerId, adapter.id)
    const controller = new AbortController()
    if (this.active) {
      this.active.lease = lease
      this.active.controller = controller
    }

    const tools = new ToolBelt({
      store: this.store,
      evidence: this.options.evidence,
      lease,
      env: run.contract.environment,
      testCase,
      signal: controller.signal,
      fetchImpl: this.options.fetchImpl,
    })
    const assignment: Assignment = {
      assignmentId: lease.attemptId,
      runId: run.id,
      caseId: testCase.id,
      attempt: this.store.getAttempt(lease.attemptId).attemptNumber,
      buildRevision: run.contract.buildRevision,
      environment: run.contract.environment,
      testCase,
      deadlineSeconds: testCase.timeoutSeconds,
      model: profile.model,
      builtinTools: profile.builtinTools,
    }

    const heartbeat = setInterval(() => {
      try {
        this.store.workerAppend(lease, 'worker_heartbeat', { worker_id: this.workerId, status: 'executing' })
      } catch {
        // Lease revoked or attempt closed; the attempt outcome is recorded elsewhere.
      }
    }, this.heartbeatMs)
    heartbeat.unref?.()
    const deadline = setTimeout(() => controller.abort('timeout'), testCase.timeoutSeconds * 1000)
    deadline.unref?.()

    const execution = adapter
      .execute(assignment, { tools, signal: controller.signal, checkpoint: () => this.checkpoint(run.id) })
      .catch((err): AgentOutcome => {
        if (err instanceof CancelledError || controller.signal.aborted) return { kind: 'cancelled', reason: String(controller.signal.reason ?? 'cancelled') }
        return { kind: 'error', reason: `adapter threw: ${err instanceof Error ? err.message : String(err)}` }
      })

    // Once cancellation is requested, the worker gets a bounded grace period.
    const forced = new Promise<'force'>((resolve) => {
      const onAbort = () => {
        if (controller.signal.reason === 'timeout') return
        const timer = setTimeout(() => resolve('force'), this.cancelGraceMs)
        timer.unref?.()
      }
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    // A deadline also gets a grace period before the attempt is closed.
    const deadlineForced = new Promise<'deadline'>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          if (controller.signal.reason !== 'timeout') return
          const timer = setTimeout(() => resolve('deadline'), this.cancelGraceMs)
          timer.unref?.()
        },
        { once: true },
      )
    })

    try {
      const outcome = await Promise.race([execution, forced, deadlineForced])
      if (outcome === 'force') {
        this.store.revokeAttempt(lease.attemptId, 'cancelled', 'force stopped: worker did not acknowledge cancellation')
        return 'force_stopped'
      }
      if (outcome === 'deadline') {
        this.store.revokeAttempt(lease.attemptId, 'error', `timeout after ${testCase.timeoutSeconds}s (adapter did not stop)`)
        return 'error'
      }
      return this.concludeAttempt(lease, testCase, tools, outcome, controller.signal.reason)
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadline)
    }
  }

  private concludeAttempt(lease: Lease, testCase: CaseDef, tools: ToolBelt, outcome: AgentOutcome, abortReason: unknown): AttemptStatus {
    const extra = {
      adapter_outcome: outcome.kind,
      exit_code: outcome.exitCode ?? null,
      usage: outcome.usage ?? null,
      diagnostics: outcome.diagnostics ? bounded(outcome.diagnostics, 2000) : null,
    }
    try {
      if (abortReason === 'timeout') {
        return this.store.finishAttempt(lease, 'error', `timeout after ${testCase.timeoutSeconds}s`, extra).status
      }
      if (outcome.kind === 'cancelled') {
        return this.store.finishAttempt(lease, 'cancelled', outcome.reason, extra).status
      }
      if (outcome.kind === 'error') {
        return this.store.finishAttempt(lease, 'error', outcome.reason, extra).status
      }

      // Deterministic assertions are the authority. They run even when the
      // agent reported itself blocked, so the record shows exactly which
      // checks had evidence.
      const statuses = testCase.assertions.map((def) => {
        const evaluation = evaluateAssertion(def, tools.observations.get(def.stepId))
        this.store.recordAssertion(lease, {
          assertionId: def.id,
          kind: def.kind,
          expected: evaluation.expected,
          actual: evaluation.actual,
          status: evaluation.status,
          artifactIds: evaluation.artifactIds,
        })
        return evaluation.status
      })

      let status: Exclude<AttemptStatus, 'running'>
      let reason: string
      if (statuses.includes('failed')) {
        status = 'failed'
        reason = `${statuses.filter((s) => s === 'failed').length} of ${statuses.length} assertion(s) failed`
      } else if (outcome.kind === 'blocked' || tools.blockedReason) {
        status = 'blocked'
        reason = `agent blocked: ${tools.blockedReason ?? outcome.reason}`
      } else if (statuses.length === 0) {
        status = 'blocked'
        reason = 'case has no assertions; nothing can establish a pass'
      } else if (statuses.includes('blocked')) {
        status = 'blocked'
        reason = `${statuses.filter((s) => s === 'blocked').length} assertion(s) had no evidence`
      } else {
        status = 'passed'
        reason = `${statuses.length} assertion(s) passed`
      }
      return this.store.finishAttempt(lease, status, reason, extra).status
    } catch (err) {
      if (err instanceof StaleOwnershipError) return this.store.getAttempt(lease.attemptId).status
      throw err
    }
  }
}
