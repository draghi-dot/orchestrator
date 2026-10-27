/**
 * Loopback tool gateway (after Kestrel's tool_belt_mcp server). Agent CLIs
 * (Claude Code, Codex) spawn the stdio MCP bridge in resources/, and the
 * bridge forwards every tool call here with the task's bearer token. The
 * token is the task's identity: when the task ends or is revoked the token
 * stops working, so a lingering agent process cannot keep acting.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StaleOwnershipError } from './store'
import type { TaskTools } from './tools'

interface Registration {
  tools: TaskTools
  nonce: string
}

export class ToolGateway {
  private server: Server | null = null
  private readonly registrations = new Map<string, Registration>()
  private origin = ''

  async start(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }) })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    const { port } = this.server.address() as AddressInfo
    this.origin = `http://127.0.0.1:${port}`
  }

  get url(): string {
    if (!this.origin) throw new Error('tool gateway is not started')
    return this.origin
  }

  register(tools: TaskTools): string {
    const token = randomBytes(32).toString('hex')
    this.registrations.set(token, { tools, nonce: randomBytes(4).toString('hex') })
    return token
  }

  unregister(token: string): void {
    this.registrations.delete(token)
  }

  async stop(): Promise<void> {
    this.registrations.clear()
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  private find(req: IncomingMessage): Registration | null {
    const header = req.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!/^[a-f0-9]{64}$/.test(presented)) return null
    for (const [token, reg] of this.registrations) {
      if (timingSafeEqual(Buffer.from(token), Buffer.from(presented))) return reg
    }
    return null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') return send(405, { error: 'POST only' })
    const reg = this.find(req)
    if (!reg) return send(401, { error: 'This task is no longer active.' })
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 2 * 1024 * 1024) return send(413, { error: 'request too large' })
    }
    let body: { id?: unknown; name?: unknown; arguments?: unknown } = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      return send(400, { error: 'invalid JSON' })
    }
    if (req.url === '/tools') {
      return send(200, { tools: reg.tools.definitions(), rules: reg.tools.rules() })
    }
    if (req.url === '/call') {
      const name = typeof body.name === 'string' ? body.name : ''
      const callId = `${reg.nonce}-${String(body.id ?? '')}`
      try {
        const result = await reg.tools.call(callId, name, body.arguments)
        return send(200, result)
      } catch (err) {
        if (err instanceof StaleOwnershipError) return send(410, { error: 'This task is no longer active.' })
        return send(500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
    send(404, { error: 'unknown route' })
  }
}
