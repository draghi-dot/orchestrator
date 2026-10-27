/** Account commands stay in the host. Credentials are owned by the official CLIs. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountStatus, RuntimeId, RuntimeSettings } from '../shared/domain'
import type { LoginUpdate } from '../shared/ipc'
import { resolveCommand } from './settings'
import { stopChild } from './runtimes/types'

type Provider = Exclude<RuntimeId, 'offline'>
const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const redact = (s: string) => clean(s).replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
const commandFor = (settings: RuntimeSettings, runtime: Provider) => settings[`${runtime}Command`]

function capture(command: string, args: string[], cwd: string, timeout = 15_000): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve) => {
    let text = ''; let done = false
    const child = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, text: clean(text) }) }
    const timer = setTimeout(() => { stopChild(child, 500); text += '\nCommand timed out'; finish(null) }, timeout)
    child.stdout.on('data', (d: Buffer) => { text = (text + d.toString()).slice(-16000) })
    child.stderr.on('data', (d: Buffer) => { text = (text + d.toString()).slice(-16000) })
    child.on('error', (err) => { text += err.message; finish(null) })
    child.on('close', finish)
  })
}

export function allowedLoginUrl(raw: string, runtime: Provider): string | null {
  try {
    const u = new URL(raw)
    const hosts = runtime === 'codex' ? ['auth.openai.com', 'openai.com', 'chatgpt.com'] : ['claude.ai', 'console.anthropic.com', 'platform.claude.com', 'auth.anthropic.com']
    return u.protocol === 'https:' && !u.username && !u.password && hosts.includes(u.hostname) ? u.href : null
  } catch { return null }
}

interface LoginSession {
  child: ChildProcessWithoutNullStreams
  update: LoginUpdate
  timer: ReturnType<typeof setTimeout>
}

export class AccountManager {
  private readonly sessions = new Map<string, LoginSession>()
  private readonly listeners = new Set<(update: LoginUpdate) => void>()
  readonly cwd: string

  constructor(private readonly settings: () => RuntimeSettings, dataDir: string) {
    this.cwd = join(dataDir, 'account-commands')
    mkdirSync(this.cwd, { recursive: true })
  }

  onUpdate(listener: (update: LoginUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(s: LoginSession): void {
    for (const fn of this.listeners) fn(structuredClone(s.update))
  }

  async status(runtime: Provider): Promise<AccountStatus> {
    const path = resolveCommand(commandFor(this.settings(), runtime))
    const base: AccountStatus = { runtime, installed: !!path, path, version: null, signedIn: false, account: null, error: null }
    if (!path) return { ...base, error: 'CLI not found. Install it or set its executable path.' }
    const v = await capture(path, ['--version'], this.cwd)
    base.version = v.code === 0 ? redact(v.text.trim()).slice(0, 120) : null
    if (runtime === 'omp') return { ...base, error: 'oh-my-pi manages provider accounts in its own CLI. Use omp login to configure them.' }
    const result = await capture(path, runtime === 'codex' ? ['login', 'status'] : ['auth', 'status'], this.cwd)
    if (runtime === 'codex') {
      base.signedIn = result.code === 0 && /logged in/i.test(result.text)
      base.account = base.signedIn ? (/ChatGPT/i.test(result.text) ? 'ChatGPT account' : 'API credential') : null
    } else {
      try {
        const start = result.text.indexOf('{'); const end = result.text.lastIndexOf('}')
        const data = JSON.parse(result.text.slice(start, end + 1)) as { loggedIn?: boolean; authMethod?: string }
        base.signedIn = data.loggedIn === true
        base.account = base.signedIn ? `Claude (${data.authMethod ?? 'account'})` : null
      } catch { base.error = 'Could not read Claude account status' }
    }
    if (result.code === null) base.error = 'Account status command failed or timed out'
    return base
  }

  activeLogins(): LoginUpdate[] { return [...this.sessions.values()].map((s) => structuredClone(s.update)) }

  statuses(): Promise<AccountStatus[]> { return Promise.all((['claude', 'codex', 'omp'] as const).map((r) => this.status(r))) }

  start(runtime: Provider): string {
    if (runtime !== 'codex' && runtime !== 'claude') throw new Error('Use omp login in a terminal to manage oh-my-pi provider accounts')
    if ([...this.sessions.values()].some((s) => s.update.runtime === runtime && s.update.state === 'waiting')) throw new Error('A sign-in is already in progress for this provider')
    const path = resolveCommand(commandFor(this.settings(), runtime))
    if (!path) throw new Error(`${runtime} CLI is not installed`)
    const id = randomUUID()
    const child = spawn(path, runtime === 'codex' ? ['login', '--device-auth'] : ['auth', 'login', '--claudeai'], {
      cwd: this.cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: 'pipe', detached: true,
    })
    const session: LoginSession = {
      child, update: { sessionId: id, runtime, lines: [], url: null, state: 'waiting', message: 'Complete sign-in in your browser.' },
      timer: setTimeout(() => this.cancel(id, 'Sign-in timed out. Try again.'), 10 * 60 * 1000),
    }
    this.sessions.set(id, session)
    let output = ''
    const receive = (chunk: Buffer) => {
      if (session.update.state !== 'waiting') return
      output = (output + clean(chunk.toString())).slice(-16000)
      const urls = output.match(/https:\/\/[^\s<>"']+/g) ?? []
      for (const raw of urls) session.update.url = allowedLoginUrl(raw, runtime) ?? session.update.url
      session.update.lines = redact(output).split(/\r?\n/).filter(Boolean).slice(-60)
      this.publish(session)
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.stdin.on('error', () => {})
    const finish = async (code: number | null, error?: string) => {
      if (session.update.state !== 'waiting') return
      clearTimeout(session.timer)
      const status = code === 0 ? await this.status(runtime) : null
      if (session.update.state !== 'waiting') return
      session.update.state = status?.signedIn ? 'succeeded' : 'failed'
      session.update.message = status?.signedIn ? 'Signed in.' : error ?? 'Sign-in did not complete. Try again.'
      session.update.url = null
      session.update.lines = []
      this.publish(session)
      this.sessions.delete(id)
    }
    child.on('error', (err) => void finish(null, redact(err.message)))
    child.on('close', (code) => void finish(code))
    this.publish(session)
    return id
  }

  sendInput(id: string, text: string): boolean {
    const s = this.sessions.get(id)
    if (!s || s.update.state !== 'waiting') return false
    if (text.length > 4096 || /[\r\n\x00]/.test(text)) throw new Error('Enter a single sign-in code')
    return s.child.stdin.write(text + '\n')
  }

  loginUrl(id: string): string | null {
    const s = this.sessions.get(id)
    return s?.update.state === 'waiting' && s.update.url ? allowedLoginUrl(s.update.url, s.update.runtime) : null
  }

  cancel(id: string, message = 'Sign-in cancelled'): boolean {
    const s = this.sessions.get(id)
    if (!s || s.update.state !== 'waiting') return false
    clearTimeout(s.timer)
    s.update.state = 'cancelled'; s.update.message = message; s.update.lines = []; s.update.url = null
    stopChild(s.child, 1000)
    this.publish(s)
    this.sessions.delete(id)
    return true
  }

  async logout(runtime: Provider): Promise<AccountStatus> {
    if (runtime === 'omp') throw new Error('Manage oh-my-pi provider accounts in its CLI')
    for (const [id, s] of this.sessions) if (s.update.runtime === runtime) this.cancel(id)
    const path = resolveCommand(commandFor(this.settings(), runtime))
    if (!path) throw new Error(`${runtime} CLI is not installed`)
    const result = await capture(path, runtime === 'codex' ? ['logout'] : ['auth', 'logout'], this.cwd)
    if (result.code !== 0) throw new Error('Sign-out failed. Check the provider CLI.')
    return this.status(runtime)
  }

  close(): void { for (const id of this.sessions.keys()) this.cancel(id) }
}
