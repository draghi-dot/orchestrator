/**
 * The agent seam (after Kestrel's run_harness/invoker.py). Provider specifics
 * stay behind a runtime. Runtimes never decide anything about the app: they
 * act through TaskTools and report how the invocation ended. An empty,
 * malformed, or crashed invocation must come back as `error`, never as
 * `finished`.
 */

import type { Phase, Role, RuntimeId, StackInfo, TestMode } from '../../shared/domain'
import type { TaskTools } from '../tools'

export interface Assignment {
  taskId: string
  runId: string
  role: Role
  phase: Phase
  mode: TestMode
  model: string
  systemPrompt: string
  prompt: string
  deadlineSeconds: number
  /** Facts the deterministic Offline runtime uses; model runtimes get them in the prompt. */
  context: { targetName: string; stack: StackInfo; appUrl: string | null; finalReport: boolean }
}

/** How an agent CLI should launch the QA MCP bridge for this task. */
export interface BridgeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface RuntimeContext {
  tools: TaskTools
  signal: AbortSignal
  /** Await at a safe boundary; throws if the run is being cancelled. */
  checkpoint(): Promise<void>
  bridge: BridgeLaunch | null
  /** An empty scratch folder to use as the agent process's working directory. */
  scratchDir: string
}

export type OutcomeKind = 'finished' | 'blocked' | 'error' | 'cancelled'

export interface Outcome {
  kind: OutcomeKind
  reason: string
  exitCode?: number | null
  usage?: Record<string, unknown>
  /** Bounded stderr / protocol diagnostics. Never shown as a result. */
  diagnostics?: string
}

export interface AgentRuntime {
  readonly id: RuntimeId
  execute(assignment: Assignment, ctx: RuntimeContext): Promise<Outcome>
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

/** Kill a child process tree politely, then firmly. */
export function stopChild(child: { pid?: number; exitCode: number | null; kill(signal?: NodeJS.Signals): boolean }, graceMs: number): void {
  const kill = (sig: NodeJS.Signals) => {
    if (child.exitCode !== null) return
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig)
      else child.kill(sig)
    } catch {
      try {
        child.kill(sig)
      } catch {
        // already gone
      }
    }
  }
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), graceMs).unref()
}
