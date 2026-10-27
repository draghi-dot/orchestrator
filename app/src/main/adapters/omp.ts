/**
 * oh-my-pi (`omp`) adapter over its NDJSON RPC mode
 * (https://github.com/can1357/oh-my-pi, docs/rpc.md).
 *
 * The agent process gets NO built-in tools by default (`--no-tools`). The QA
 * app registers its own host tools with `set_host_tools`, so every action the
 * model takes arrives here as a `host_tool_call` and runs through the
 * ToolBelt's origin/method policy. Built-in tools (e.g. `browser`) can be
 * enabled per run profile; their traffic is NOT policy-checked by this app,
 * and the UI says so.
 *
 * Completion authority is the `prompt_result` frame for our prompt id. A
 * process that exits, prints garbage, or reports `status: "error"` without a
 * completed prompt result yields an `error` outcome, never `finished`.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { bounded } from '../../shared/events'
import type { AgentAdapter, AgentContext, AgentOutcome, Assignment } from './types'

export interface OmpOptions {
  command: string
  /** Prepended to the omp arguments (tests run a fake omp through node). */
  argsPrefix?: string[]
  extraArgs?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
  maxMalformedLines?: number
}

const HOST_TOOLS = [
  {
    name: 'qa_step',
    label: 'QA step',
    description: 'Mark a test step as started, finished, failed, or skipped. Call with status "started" before working on a step.',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        status: { type: 'string', enum: ['started', 'finished', 'failed', 'skipped'] },
      },
      required: ['step_id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'qa_http_request',
    label: 'QA HTTP request',
    description:
      'Perform an HTTP request against the application under test for a given step. URLs may be relative to the base URL. Only allowed origins are reachable. The response is recorded as evidence.',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        url: { type: 'string' },
        body: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['step_id', 'method', 'url'],
      additionalProperties: false,
    },
  },
  {
    name: 'qa_note',
    label: 'QA note',
    description: 'Record a short observation for the operator. Notes are context, not results.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'qa_report_blocked',
    label: 'QA blocked',
    description: 'Report that the case cannot be executed as written, with the reason. Stop after calling this.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
]

export const QA_SYSTEM_PROMPT = [
  'You are a QA test executor working for an operator.',
  'Act ONLY through the qa_* tools. Execute the assigned test case in order:',
  'for each step call qa_step(status "started"), perform it (normally with qa_http_request using that step_id),',
  'then call qa_step with "finished", "failed", or "skipped".',
  'You do not decide whether the test passed. Deterministic assertions run on the recorded responses after you finish.',
  'If a step cannot be performed as written, call qa_report_blocked with the reason and stop.',
  'Never invent or paraphrase responses. Requests outside the allowed origins are rejected by the host.',
].join(' ')

export function buildPrompt(a: Assignment): string {
  const brief = {
    assignment_id: a.assignmentId,
    run_id: a.runId,
    case_id: a.caseId,
    attempt: a.attempt,
    build_revision: a.buildRevision,
    environment: { name: a.environment.name, base_url: a.environment.baseUrl, allowed_origins: a.environment.allowedOrigins },
    case: {
      title: a.testCase.title,
      preconditions: a.testCase.preconditions,
      steps: a.testCase.steps.map((s) => ({ step_id: s.id, title: s.title, instruction: s.instruction, request_hint: s.request ?? null })),
      checks_run_after_you_finish: a.testCase.assertions.map((x) => ({ step_id: x.stepId, description: x.description })),
    },
    deadline_seconds: a.deadlineSeconds,
  }
  return `Execute this QA assignment.\n\n${JSON.stringify(brief, null, 2)}`
}

export function ompArgs(a: Assignment, options: Pick<OmpOptions, 'argsPrefix' | 'extraArgs'>): string[] {
  return [
    ...(options.argsPrefix ?? []),
    '--mode',
    'rpc',
    '--no-session',
    '--no-title',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-context-files',
    '--no-lsp',
    ...(a.builtinTools.length > 0 ? ['--tools', a.builtinTools.join(',')] : ['--no-tools']),
    ...(a.model ? ['--model', a.model] : []),
    '--append-system-prompt',
    QA_SYSTEM_PROMPT,
    ...(options.extraArgs ?? []),
  ]
}

type Frame = Record<string, unknown>

function assistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const m = message as { role?: unknown; content?: unknown }
  if (m.role !== 'assistant' || !Array.isArray(m.content)) return ''
  return m.content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as Frame).type === 'text' && typeof (b as Frame).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

export class OmpAgent implements AgentAdapter {
  readonly id = 'omp' as const

  constructor(private readonly options: OmpOptions) {}

  execute(assignment: Assignment, ctx: AgentContext): Promise<AgentOutcome> {
    const { tools, signal } = ctx
    const killGraceMs = this.options.killGraceMs ?? 1500
    const maxMalformed = this.options.maxMalformedLines ?? 20

    return new Promise<AgentOutcome>((resolve) => {
      let settled = false
      let stderr = ''
      let malformed = 0
      let promptResult: AgentOutcome | null = null
      let usage: Record<string, unknown> | undefined
      const cancelledHostCalls = new Set<string>()
      const timers: ReturnType<typeof setTimeout>[] = []

      if (signal.aborted) return resolve({ kind: 'cancelled', reason: String(signal.reason ?? 'aborted') })

      const child = spawn(this.options.command, ompArgs(assignment, this.options), {
        cwd: this.options.cwd,
        env: { ...(this.options.env ?? process.env), PI_NO_TITLE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const diagnostics = () => bounded([malformed > 0 ? `${malformed} malformed stdout line(s)` : '', stderr.trim()].filter(Boolean).join('\n'), 4000)

      const send = (frame: Frame) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`)
      }

      const finish = (outcome: AgentOutcome) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        for (const t of timers) clearTimeout(t)
        resolve({ ...outcome, exitCode: outcome.exitCode ?? child.exitCode, usage: outcome.usage ?? usage, diagnostics: diagnostics() })
        // Let the process drain and exit on stdin EOF; escalate if it does not.
        child.stdin.end()
        const term = setTimeout(() => child.exitCode === null && child.kill('SIGTERM'), killGraceMs)
        const kill = setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), killGraceMs * 2)
        term.unref?.()
        kill.unref?.()
      }

      const onAbort = () => {
        send({ id: 'abort', type: 'abort' })
        finish({ kind: 'cancelled', reason: String(signal.reason ?? 'aborted') })
      }
      signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        finish({ kind: 'error', reason: `could not start omp (${this.options.command}): ${err.message}` })
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8000)
      })
      child.on('exit', (code, sig) => {
        if (promptResult) return finish({ ...promptResult, exitCode: code })
        const firstLine = stderr.split('\n').map((l) => l.trim()).find(Boolean)
        const detail = firstLine ? `: ${bounded(firstLine, 300)}` : ''
        finish({ kind: 'error', reason: `omp exited (code ${code ?? 'null'}${sig ? `, signal ${sig}` : ''}) without a prompt result${detail}`, exitCode: code })
      })

      const handleHostToolCall = async (frame: Frame) => {
        const id = String(frame.id ?? '')
        const toolName = String(frame.toolName ?? '')
        const callId = String(frame.toolCallId ?? id)
        const args = frame.arguments && typeof frame.arguments === 'object' ? (frame.arguments as Record<string, unknown>) : {}
        const qaTool = toolName.startsWith('qa_') ? toolName.slice(3) : `unregistered:${toolName}`
        try {
          const result = await tools.call(callId, qaTool, args)
          if (cancelledHostCalls.has(id) || settled) return
          send({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] }, ...(result.ok ? {} : { isError: true }) })
        } catch (err) {
          if (settled) return
          send({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text: `host error: ${err instanceof Error ? err.message : String(err)}` }] }, isError: true })
        }
      }

      const lines = createInterface({ input: child.stdout })
      lines.on('line', (line) => {
        if (settled || !line.trim()) return
        let frame: Frame
        try {
          const parsed: unknown = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
          frame = parsed as Frame
        } catch {
          malformed += 1
          if (malformed > maxMalformed) finish({ kind: 'error', reason: 'omp produced too many malformed protocol lines' })
          return
        }

        switch (frame.type) {
          case 'ready':
            send({ id: 'tools', type: 'set_host_tools', tools: HOST_TOOLS })
            break
          case 'response':
            if (frame.id === 'tools') {
              if (frame.success !== true) return finish({ kind: 'error', reason: `set_host_tools failed: ${bounded(String(frame.error ?? 'unknown'), 500)}` })
              send({ id: 'prompt', type: 'prompt', message: buildPrompt(assignment) })
            } else if (frame.id === 'prompt') {
              if (frame.success !== true) return finish({ kind: 'error', reason: `prompt rejected: ${bounded(String(frame.error ?? 'unknown'), 500)}` })
              const data = frame.data as Frame | undefined
              if (data && data.agentInvoked === false) return finish({ kind: 'error', reason: 'prompt finished locally without invoking the agent' })
            } else if (frame.id === 'stats') {
              if (frame.success === true && frame.data && typeof frame.data === 'object') {
                const raw = JSON.stringify(frame.data)
                usage = raw.length <= 2000 ? (frame.data as Record<string, unknown>) : { truncated: true, preview: bounded(raw, 1000) }
              }
              if (promptResult) finish(promptResult)
            }
            break
          case 'host_tool_call':
            void handleHostToolCall(frame)
            break
          case 'host_tool_cancel':
            cancelledHostCalls.add(String(frame.targetId ?? ''))
            break
          case 'message_end': {
            const text = assistantText(frame.message)
            if (text) tools.recordAgentMessage(text)
            break
          }
          case 'prompt_result': {
            if (frame.id !== 'prompt') break
            const status = String(frame.status ?? '')
            if (status === 'completed') {
              promptResult = tools.blockedReason
                ? { kind: 'blocked', reason: tools.blockedReason }
                : { kind: 'finished', reason: 'agent yielded' }
            } else if (status === 'aborted') {
              promptResult = { kind: 'cancelled', reason: 'agent run aborted' }
            } else {
              const err = frame.error as Frame | undefined
              promptResult = { kind: 'error', reason: `agent error: ${bounded(String(err?.message ?? status ?? 'unknown'), 500)}` }
            }
            // Ask for usage, but never wait long for it.
            send({ id: 'stats', type: 'get_session_stats' })
            const result = promptResult
            timers.push(setTimeout(() => finish(result), 1500))
            break
          }
          default:
            break
        }
      })
    })
  }
}
