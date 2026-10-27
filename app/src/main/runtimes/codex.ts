/**
 * Codex worker: runs the official Codex CLI headless (`codex exec --json`),
 * signed in with whatever account the operator signed in with in the CLI.
 * The app never reads that credential.
 *
 * Shell, web search, and AGENTS.md loading are off, the sandbox is
 * read-only, user config and execpolicy rules are ignored, and the working
 * directory is an empty scratch folder. The QA MCP server is the worker's
 * whole action surface. Completion authority is `turn.completed`.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { bounded } from '../../shared/events'
import type { AgentRuntime, Assignment, Outcome, RuntimeContext } from './types'
import { stopChild } from './types'

export interface CodexOptions {
  command: string
  argsPrefix?: string[]
  env?: NodeJS.ProcessEnv
  killGraceMs?: number
}

type Frame = Record<string, unknown>

const toml = (value: string) => JSON.stringify(value)
const tomlArray = (values: string[]) => `[${values.map(toml).join(', ')}]`
const tomlTable = (values: Record<string, string>) => `{ ${Object.entries(values).map(([k, v]) => `${k} = ${toml(v)}`).join(', ')} }`

export function codexArgs(a: Assignment, ctx: RuntimeContext, prefix: string[] = []): string[] {
  if (!ctx.bridge) throw new Error('Codex workers need the QA tool bridge')
  const config = [
    'approval_policy="never"',
    'features.shell_tool=false',
    'web_search="disabled"',
    'project_doc_max_bytes=0',
    `mcp_servers.qa.command=${toml(ctx.bridge.command)}`,
    `mcp_servers.qa.args=${tomlArray(ctx.bridge.args)}`,
    `mcp_servers.qa.env=${tomlTable(ctx.bridge.env)}`,
    'mcp_servers.qa.required=true',
    'mcp_servers.qa.startup_timeout_sec=30',
    'mcp_servers.qa.tool_timeout_sec=900',
  ]
  return [
    ...prefix,
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    ctx.scratchDir,
    ...config.flatMap((c) => ['-c', c]),
    ...(a.model ? ['-m', a.model] : []),
    '-',
  ]
}

export class CodexRuntime implements AgentRuntime {
  readonly id = 'codex' as const

  constructor(private readonly options: CodexOptions) {}

  execute(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      if (ctx.signal.aborted) return resolve({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      let settled = false
      let stderr = ''
      let malformed = 0
      let lastError: string | null = null
      let result: Outcome | null = null

      const child = spawn(this.options.command, codexArgs(a, ctx, this.options.argsPrefix), {
        cwd: ctx.scratchDir,
        env: this.options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      })

      const finish = (outcome: Outcome) => {
        if (settled) return
        settled = true
        ctx.signal.removeEventListener('abort', onAbort)
        const diagnostics = bounded([malformed ? `${malformed} malformed output line(s)` : '', lastError ?? '', stderr.trim()].filter(Boolean).join('\n'), 4000)
        resolve({ ...outcome, exitCode: outcome.exitCode ?? child.exitCode, diagnostics })
        stopChild(child, this.options.killGraceMs ?? 2000)
      }
      const onAbort = () => finish({ kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') })
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => finish({ kind: 'error', reason: `could not start Codex (${this.options.command}): ${err.message}` }))
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8000)
      })
      child.on('exit', (code) => {
        if (result) return finish({ ...result, exitCode: code })
        const first = lastError ?? stderr.split('\n').map((l) => l.trim()).find(Boolean)
        finish({ kind: 'error', reason: `Codex exited (code ${code ?? 'null'}) without finishing its turn${first ? `: ${bounded(first, 300)}` : ''}`, exitCode: code })
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
        const item = frame.item as Frame | undefined
        switch (frame.type) {
          case 'item.completed':
            if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) ctx.tools.recordAgentMessage(item.text)
            if (item?.type === 'error' && typeof item.message === 'string') lastError = item.message
            break
          case 'error':
            lastError = typeof frame.message === 'string' ? frame.message : JSON.stringify(frame)
            break
          case 'turn.failed': {
            const err = frame.error as Frame | undefined
            result = { kind: 'error', reason: `Codex turn failed: ${bounded(String(err?.message ?? lastError ?? 'unknown error'), 300)}` }
            break
          }
          case 'turn.completed': {
            const usage = frame.usage && typeof frame.usage === 'object' ? (frame.usage as Record<string, unknown>) : undefined
            result = ctx.tools.blockedReason ? { kind: 'blocked', reason: ctx.tools.blockedReason, usage } : { kind: 'finished', reason: 'worker finished', usage }
            break
          }
          default:
            break
        }
      })

      child.stdin.end(`${a.systemPrompt}\n\n---\n\n${a.prompt}`)
    })
  }
}
