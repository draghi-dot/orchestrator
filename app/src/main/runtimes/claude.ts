/**
 * Claude worker: runs the official Claude Code CLI headless (`claude -p`),
 * signed in with whatever account the operator signed in with in the CLI.
 * The app never reads that credential.
 *
 * The worker gets NO built-in tools (`--tools ""`) and runs `--restricted`,
 * so user and project settings and hooks are ignored. Its whole action
 * surface is the QA MCP server (`--strict-mcp-config`), and only those tools
 * are pre-approved (`--permission-mode dontAsk`). The working directory is
 * an empty scratch folder, never the imported repo.
 *
 * Completion authority is the single `result` frame of stream-json output.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { bounded } from '../../shared/events'
import type { AgentRuntime, Assignment, Outcome, RuntimeContext } from './types'
import { stopChild } from './types'

export interface ClaudeOptions {
  command: string
  argsPrefix?: string[]
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
}

type Frame = Record<string, unknown>

export function claudeArgs(a: Assignment, ctx: RuntimeContext, prefix: string[] = []): string[] {
  if (!ctx.bridge) throw new Error('Claude workers need the QA tool bridge')
  const mcp = { mcpServers: { qa: { type: 'stdio', command: ctx.bridge.command, args: ctx.bridge.args, env: ctx.bridge.env } } }
  const allowed = ctx.tools.definitions().map((d) => `mcp__qa__${d.name}`)
  return [
    ...prefix,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--system-prompt',
    a.systemPrompt,
    '--tools',
    '',
    '--restricted',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcp),
    '--allowedTools',
    allowed.join(','),
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    ...(a.model ? ['--model', a.model] : []),
  ]
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as Frame).type === 'text' && typeof (b as Frame).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude' as const

  constructor(private readonly options: ClaudeOptions) {}

  execute(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      if (ctx.signal.aborted) return resolve({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      let settled = false
      let stderr = ''
      let malformed = 0
      let result: Outcome | null = null

      const child = spawn(this.options.command, claudeArgs(a, ctx, this.options.argsPrefix), {
        cwd: ctx.scratchDir,
        env: { ...(this.options.env ?? process.env), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })

      const finish = (outcome: Outcome) => {
        if (settled) return
        settled = true
        ctx.signal.removeEventListener('abort', onAbort)
        const diagnostics = bounded([malformed ? `${malformed} malformed output line(s)` : '', stderr.trim()].filter(Boolean).join('\n'), 4000)
        resolve({ ...outcome, exitCode: outcome.exitCode ?? child.exitCode, diagnostics })
        stopChild(child, this.options.killGraceMs ?? 2000)
      }
      const onAbort = () => finish({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => finish({ kind: 'error', reason: `could not start Claude Code (${this.options.command}): ${err.message}` }))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8000)
      })
      child.on('exit', (code) => {
        if (result) return finish({ ...result, exitCode: code })
        const first = stderr.split('\n').map((l) => l.trim()).find(Boolean)
        finish({ kind: 'error', reason: `Claude Code exited (code ${code ?? 'null'}) without a result${first ? `: ${bounded(first, 300)}` : ''}`, exitCode: code })
      })

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (settled || !line.trim()) return
        let frame: Frame
        try {
          frame = JSON.parse(line) as Frame
        } catch {
          malformed += 1
          return
        }
        if (frame.type === 'system' && frame.subtype === 'init') {
          const servers = Array.isArray(frame.mcp_servers) ? (frame.mcp_servers as { name?: string; status?: string }[]) : []
          const qa = servers.find((s) => s.name === 'qa')
          if (!qa || qa.status !== 'connected') finish({ kind: 'error', reason: `QA tools did not connect to Claude Code (status: ${qa?.status ?? 'missing'})` })
        } else if (frame.type === 'assistant') {
          const text = assistantText(frame.message)
          if (text) ctx.tools.recordAgentMessage(text)
        } else if (frame.type === 'result') {
          const usage = frame.usage && typeof frame.usage === 'object' ? (frame.usage as Record<string, unknown>) : undefined
          const meta = { ...(usage ?? {}), num_turns: frame.num_turns ?? null, duration_ms: frame.duration_ms ?? null }
          if (frame.is_error === true || frame.subtype !== 'success') {
            result = { kind: 'error', reason: `Claude Code ended with ${String(frame.subtype)}: ${bounded(String(frame.result ?? ''), 300)}`, usage: meta }
          } else {
            result = ctx.tools.blockedReason ? { kind: 'blocked', reason: ctx.tools.blockedReason, usage: meta } : { kind: 'finished', reason: 'worker finished', usage: meta }
          }
        }
      })

      child.stdin.end(a.prompt)
    })
  }
}
