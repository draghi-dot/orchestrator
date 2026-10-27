/**
 * oh-my-pi worker over its NDJSON RPC mode
 * (https://github.com/can1357/oh-my-pi, docs/rpc.md).
 *
 * Built-in tools are off (`--no-tools`). The QA tools are registered as host
 * tools with `set_host_tools`, so every action arrives here as a
 * `host_tool_call` and runs through TaskTools policy. Completion authority
 * is the `prompt_result` frame for our prompt id.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { bounded } from '../../shared/events'
import type { AgentRuntime, Assignment, Outcome, RuntimeContext } from './types'
import { stopChild } from './types'

export interface OmpOptions {
  command: string
  argsPrefix?: string[]
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
  maxMalformedLines?: number
}

type Frame = Record<string, unknown>

export function ompArgs(a: Assignment, prefix: string[] = []): string[] {
  return [
    ...prefix,
    '--mode',
    'rpc',
    '--no-session',
    '--no-title',
    '--no-extensions',
    '--no-skills',
    '--no-rules',
    '--no-context-files',
    '--no-lsp',
    '--no-tools',
    ...(a.model ? ['--model', a.model] : []),
    '--append-system-prompt',
    a.systemPrompt,
  ]
}

function assistantText(message: unknown): string {
  const m = message as { role?: unknown; content?: unknown } | undefined
  if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) return ''
  return m.content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as Frame).type === 'text' && typeof (b as Frame).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

export class OmpRuntime implements AgentRuntime {
  readonly id = 'omp' as const

  constructor(private readonly options: OmpOptions) {}

  execute(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    const maxMalformed = this.options.maxMalformedLines ?? 20
    return new Promise<Outcome>((resolve) => {
      if (ctx.signal.aborted) return resolve({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      let settled = false
      let stderr = ''
      let malformed = 0
      let promptResult: Outcome | null = null
      let usage: Record<string, unknown> | undefined
      const cancelledCalls = new Set<string>()
      const timers: ReturnType<typeof setTimeout>[] = []

      const child = spawn(this.options.command, ompArgs(a, this.options.argsPrefix), {
        cwd: ctx.scratchDir,
        env: { ...(this.options.env ?? process.env), PI_NO_TITLE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })
      child.stdin.on('error', () => {})
      const send = (frame: Frame) => {
        if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`)
      }
      const finish = (outcome: Outcome) => {
        if (settled) return
        settled = true
        ctx.signal.removeEventListener('abort', onAbort)
        for (const t of timers) clearTimeout(t)
        const diagnostics = bounded([malformed ? `${malformed} malformed stdout line(s)` : '', stderr.trim()].filter(Boolean).join('\n'), 4000)
        resolve({ ...outcome, exitCode: outcome.exitCode ?? child.exitCode, usage: outcome.usage ?? usage, diagnostics })
        child.stdin.end()
        stopChild(child, this.options.killGraceMs ?? 1500)
      }
      const onAbort = () => {
        send({ id: 'abort', type: 'abort' })
        finish({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      }
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => finish({ kind: 'error', reason: `could not start oh-my-pi (${this.options.command}): ${err.message}` }))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8000)
      })
      child.on('close', (code, sig) => {
        if (promptResult) return finish({ ...promptResult, exitCode: code })
        const first = stderr.split('\n').map((l) => l.trim()).find(Boolean)
        finish({ kind: 'error', reason: `oh-my-pi exited (code ${code ?? 'null'}${sig ? `, signal ${sig}` : ''}) without a prompt result${first ? `: ${bounded(first, 300)}` : ''}`, exitCode: code })
      })

      const handleHostToolCall = async (frame: Frame) => {
        const id = String(frame.id ?? '')
        const toolName = String(frame.toolName ?? '')
        const name = toolName.startsWith('qa_') ? toolName.slice(3) : `unregistered:${toolName}`
        try {
          const result = await ctx.tools.call(String(frame.toolCallId ?? id), name, frame.arguments)
          if (cancelledCalls.has(id) || settled) return
          const text = [result.summary, result.data === undefined ? '' : typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2)].filter(Boolean).join('\n\n')
          send({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text }] }, ...(result.ok ? {} : { isError: true }) })
        } catch (err) {
          if (settled) return
          send({ type: 'host_tool_result', id, result: { content: [{ type: 'text', text: `host error: ${err instanceof Error ? err.message : String(err)}` }] }, isError: true })
        }
      }

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (settled || !line.trim()) return
        let frame: Frame
        try {
          const parsed: unknown = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
          frame = parsed as Frame
        } catch {
          malformed += 1
          if (malformed > maxMalformed) finish({ kind: 'error', reason: 'oh-my-pi produced too many malformed protocol lines' })
          return
        }
        switch (frame.type) {
          case 'ready':
            send({
              id: 'tools',
              type: 'set_host_tools',
              tools: ctx.tools.definitions().map((d) => ({ name: `qa_${d.name}`, label: d.name, description: d.description, parameters: d.inputSchema })),
            })
            break
          case 'response':
            if (frame.id === 'tools') {
              if (frame.success !== true) return finish({ kind: 'error', reason: `set_host_tools failed: ${bounded(String(frame.error ?? 'unknown'), 300)}` })
              send({ id: 'prompt', type: 'prompt', message: a.prompt })
            } else if (frame.id === 'prompt') {
              if (frame.success !== true) return finish({ kind: 'error', reason: `prompt rejected: ${bounded(String(frame.error ?? 'unknown'), 300)}` })
              if ((frame.data as Frame | undefined)?.agentInvoked === false) return finish({ kind: 'error', reason: 'prompt finished locally without invoking the agent' })
            } else if (frame.id === 'stats') {
              if (frame.success === true && frame.data && typeof frame.data === 'object') {
                const raw = JSON.stringify(frame.data)
                usage = raw.length <= 2000 ? (frame.data as Record<string, unknown>) : { truncated: true }
              }
              if (promptResult) finish(promptResult)
            }
            break
          case 'host_tool_call':
            void handleHostToolCall(frame)
            break
          case 'host_tool_cancel':
            cancelledCalls.add(String(frame.targetId ?? ''))
            break
          case 'message_end': {
            const text = assistantText(frame.message)
            if (text) ctx.tools.recordAgentMessage(text)
            break
          }
          case 'prompt_result': {
            if (frame.id !== 'prompt') break
            const status = String(frame.status ?? '')
            if (status === 'completed') {
              promptResult = ctx.tools.blockedReason ? { kind: 'blocked', reason: ctx.tools.blockedReason } : { kind: 'finished', reason: 'worker finished' }
            } else if (status === 'aborted') {
              promptResult = { kind: 'cancelled', reason: 'agent run aborted' }
            } else {
              const err = frame.error as Frame | undefined
              promptResult = { kind: 'error', reason: `agent error: ${bounded(String(err?.message ?? status ?? 'unknown'), 300)}` }
            }
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
