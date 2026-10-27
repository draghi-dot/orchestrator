/**
 * Deterministic, model-free agent. It follows each step's literal `request`
 * through the same ToolBelt a model-backed agent uses, so phase 1 exercises
 * the whole lifecycle without any provider account.
 */

import type { AgentAdapter, AgentContext, AgentOutcome, Assignment } from './types'
import { sleep } from './types'

export class ScriptedAgent implements AgentAdapter {
  readonly id = 'scripted' as const

  constructor(private readonly options: { stepDelayMs?: number } = {}) {}

  async execute(assignment: Assignment, ctx: AgentContext): Promise<AgentOutcome> {
    const { tools, signal } = ctx
    const delay = this.options.stepDelayMs ?? 0
    try {
      for (const step of assignment.testCase.steps) {
        await ctx.checkpoint()
        const base = `${assignment.assignmentId}:${step.id}`
        await tools.call(`${base}:start`, 'step', { step_id: step.id, status: 'started' })
        if (delay > 0) await sleep(delay, signal)
        if (step.request) {
          const result = await tools.call(`${base}:request`, 'http_request', {
            step_id: step.id,
            method: step.request.method,
            url: step.request.url,
            body: step.request.body,
            headers: step.request.headers,
          })
          if (!result.ok) {
            await tools.call(`${base}:end`, 'step', { step_id: step.id, status: 'failed' })
            await tools.call(`${base}:blocked`, 'report_blocked', { reason: `step ${step.id}: ${result.summary}` })
            return { kind: 'blocked', reason: result.summary }
          }
        } else {
          await tools.call(`${base}:note`, 'note', { text: `No literal request for "${step.title}"; scripted agent skips it.` })
        }
        await tools.call(`${base}:end`, 'step', { step_id: step.id, status: step.request ? 'finished' : 'skipped' })
      }
      return { kind: 'finished', reason: 'all steps executed' }
    } catch (err) {
      if (signal.aborted) return { kind: 'cancelled', reason: String(signal.reason ?? 'aborted') }
      return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
    }
  }
}
