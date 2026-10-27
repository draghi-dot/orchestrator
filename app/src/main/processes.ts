/**
 * Runs the Builder's commands and the app under test.
 *
 * This executes the imported project's own scripts, so it is opt-in per run
 * (`allowCommands`). Commands run without a shell (no pipes, redirects, or
 * chaining), only for an allowlisted set of build tools, inside the run's
 * private working copy, with credentials stripped from the environment and
 * a hard timeout. Every process is started in its own process group so the
 * whole tree can be stopped.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolveCommand } from './settings'

export class CommandRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandRefused'
  }
}

export const ALLOWED_PROGRAMS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'node',
  'deno',
  'python',
  'python3',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'pytest',
  'go',
  'cargo',
  'make',
  'mvn',
  'gradle',
  './gradlew',
  './mvnw',
  'ruby',
  'bundle',
  'rake',
  'php',
  'composer',
  'dotnet',
  'java',
])

const SHELL_SYNTAX = /[|;&<>`$\\]|\$\(/

/** Split a command line into argv, honoring simple single/double quotes. */
export function tokenize(command: string): string[] {
  if (SHELL_SYNTAX.test(command)) throw new CommandRefused('Run one command at a time, without pipes, redirects, chaining, or variables')
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (quote) throw new CommandRefused('The command has an unclosed quote')
  if (started || current) out.push(current)
  if (out.length === 0) throw new CommandRefused('The command is empty')
  return out
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|_KEY$|^AWS_|^GH_|^GITHUB_|^ANTHROPIC|^OPENAI|^CODEX|^CLAUDE|^NPM_CONFIG__AUTH|^ELECTRON_)/i

export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_ENV.test(key)) env[key] = value
  return { ...env, CI: '1', NO_COLOR: '1', BROWSER: 'none', FORCE_COLOR: '0', ...extra }
}

export interface CommandResult {
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  durationMs: number
  output: string
  truncated: boolean
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

function prepare(command: string): { exe: string; args: string[] } {
  const argv = tokenize(command)
  const program = argv[0]
  if (!ALLOWED_PROGRAMS.has(program)) {
    throw new CommandRefused(`${program} is not an allowed build tool. Allowed: ${[...ALLOWED_PROGRAMS].join(', ')}`)
  }
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
    if (argv[1] === 'exec' || argv[1] === 'dlx' || argv[1] === 'x') throw new CommandRefused(`${program} ${argv[1]} downloads and runs arbitrary packages; use the project's own scripts`)
  }
  const exe = program.startsWith('./') ? program : resolveCommand(program)
  if (!exe) throw new CommandRefused(`${program} is not installed on this machine`)
  return { exe, args: argv.slice(1) }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

interface ManagedApp {
  child: ChildProcess
  url: string
  command: string
  log: string
}

export class ProcessManager {
  private readonly apps = new Map<string, ManagedApp>()
  private readonly running = new Set<ChildProcess>()

  constructor(private readonly options: { outputCap?: number; fetchImpl?: typeof fetch } = {}) {}

  run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
    const { exe, args } = prepare(command)
    const cap = this.options.outputCap ?? 256 * 1024
    return new Promise((resolve) => {
      const started = Date.now()
      let output = ''
      let truncated = false
      let timedOut = false
      const child = spawn(exe, args, { cwd, env: scrubbedEnv(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.running.add(child)
      const collect = (chunk: Buffer) => {
        if (output.length >= cap) {
          truncated = true
          return
        }
        output += chunk.toString('utf8')
        if (output.length > cap) {
          output = output.slice(0, cap)
          truncated = true
        }
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      const stop = () => {
        killTree(child, 'SIGTERM')
        setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref()
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      const onAbort = () => stop()
      signal.addEventListener('abort', onAbort, { once: true })
      const finish = (exitCode: number | null, sig: string | null) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.running.delete(child)
        resolve({ exitCode, signal: sig, timedOut, durationMs: Date.now() - started, output, truncated })
      }
      child.on('error', (err) => {
        output += `\n${err.message}`
        finish(null, null)
      })
      child.on('close', (code, sig) => finish(code, sig))
    })
  }

  /** Start the app under test and wait until something answers HTTP. */
  async startApp(
    key: string,
    command: string,
    cwd: string,
    options: { healthPath: string; readyTimeoutMs: number; signal: AbortSignal; env?: Record<string, string> },
  ): Promise<{ url: string; pid: number | undefined; log: string }> {
    const { exe, args } = prepare(command)
    await this.stopApp(key)
    const port = await freePort()
    const child = spawn(exe, args, {
      cwd,
      env: scrubbedEnv({ ...options.env, PORT: String(port), HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', NODE_ENV: 'development' }),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let startError: Error | null = null
    child.on('error', (error) => { startError = error })
    const app: ManagedApp = { child, url: `http://127.0.0.1:${port}`, command, log: '' }
    const append = (chunk: Buffer) => {
      app.log = (app.log + chunk.toString('utf8')).slice(-64 * 1024)
      for (const value of Object.values(options.env ?? {})) if (value) app.log = app.log.split(value).join('[redacted]')
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    this.apps.set(key, app)

    const fetchImpl = this.options.fetchImpl ?? fetch
    const deadline = Date.now() + options.readyTimeoutMs
    const candidates = () => {
      const urls = [`http://127.0.0.1:${port}`]
      for (const m of app.log.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g)) urls.push(`http://127.0.0.1:${m[1]}`)
      return [...new Set(urls)]
    }
    while (Date.now() < deadline) {
      if (options.signal.aborted) {
        await this.stopApp(key)
        throw new CommandRefused('Stopped before the app was ready')
      }
      if (startError) { this.apps.delete(key); throw new CommandRefused(`Could not start the app: ${String(startError)}`) }
      if (child.exitCode !== null || child.signalCode !== null) {
        this.apps.delete(key)
        throw new CommandRefused(`The app exited with code ${child.exitCode ?? child.signalCode} before it answered. Last output:\n${app.log.slice(-2000)}`)
      }
      for (const url of candidates()) {
        try {
          await fetchImpl(`${url}${options.healthPath}`, { signal: AbortSignal.timeout(1500), redirect: 'manual' })
          app.url = url
          return { url, pid: child.pid, log: app.log }
        } catch {
          // not up yet
        }
      }
      await new Promise((r) => setTimeout(r, 400))
    }
    await this.stopApp(key)
    throw new CommandRefused(`Nothing answered HTTP within ${Math.round(options.readyTimeoutMs / 1000)}s. Last output:\n${app.log.slice(-2000)}`)
  }

  appFor(key: string): { url: string; command: string } | null {
    const app = this.apps.get(key)
    return app ? { url: app.url, command: app.command } : null
  }

  async stopApp(key: string): Promise<string | null> {
    const app = this.apps.get(key)
    if (!app) return null
    this.apps.delete(key)
    killTree(app.child, 'SIGTERM')
    await new Promise<void>((resolve) => {
      if (app.child.exitCode !== null || app.child.signalCode !== null) return resolve()
      const timer = setTimeout(() => {
        killTree(app.child, 'SIGKILL')
        resolve()
      }, 3000)
      app.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return app.log
  }

  async stopAll(): Promise<void> {
    for (const child of this.running) killTree(child, 'SIGKILL')
    await Promise.all([...this.apps.keys()].map((k) => this.stopApp(k)))
  }
}
