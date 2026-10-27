/**
 * The agent seam (after Kestrel's run_harness/invoker.py). Provider specifics
 * stay behind an adapter. Adapters never decide pass/fail: they act through
 * the ToolBelt and report how the invocation ended. An empty, malformed, or
 * crashed invocation must come back as `error`, never as `finished`.
 */

import type { AdapterId, CaseDef, EnvironmentSnapshot } from '../../shared/domain'
import type { ToolBelt } from '../toolbelt'

export interface Assignment {
  assignmentId: string
  runId: string
  caseId: string
  attempt: number
  buildRevision: string
  environment: EnvironmentSnapshot
  testCase: CaseDef
  deadlineSeconds: number
  model: string
  builtinTools: string[]
}

export type AgentOutcomeKind = 'finished' | 'blocked' | 'error' | 'cancelled'

export interface AgentOutcome {
  kind: AgentOutcomeKind
  reason: string
  exitCode?: number | null
  usage?: Record<string, unknown>
  /** Bounded stderr / protocol diagnostics. Never shown as a result. */
  diagnostics?: string
}

export interface AgentContext {
  tools: ToolBelt
  signal: AbortSignal
  /** Await at a safe boundary. Resolves when the run may continue; the
   * signal aborts if the run was cancelled while waiting. */
  checkpoint(): Promise<void>
}

export interface AgentAdapter {
  readonly id: AdapterId
  execute(assignment: Assignment, ctx: AgentContext): Promise<AgentOutcome>
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
