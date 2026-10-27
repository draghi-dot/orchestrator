/**
 * Offline workers: deterministic, no model, no account. They use the same
 * tools as model-backed workers, so a run with them exercises the whole
 * arena. Their testing is shallow on purpose: they check the rules an app
 * states about percentages, which is enough to show the loop end to end.
 */

import type { Check, Role } from '../../shared/domain'
import { evaluateCheck } from '../../shared/verdict'
import type { ToolCallResult } from '../tools'
import type { AgentRuntime, Assignment, Outcome, RuntimeContext } from './types'
import { sleep } from './types'

interface StatedRule {
  code: string
  percent: number
}

const RULE = /\b([A-Z][A-Z0-9]{2,})\b[^.\n<]{0,40}?\b(\d{1,2})\s?%/g
const SOURCE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|php|java|kt|rs)$/i

export function statedRules(text: string): StatedRule[] {
  const found = new Map<string, number>()
  for (const m of text.matchAll(RULE)) if (!found.has(m[1])) found.set(m[1], Number(m[2]))
  return [...found.entries()].map(([code, percent]) => ({ code, percent }))
}

const stripTags = (html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

interface Form {
  action: string
  method: string
  inputs: string[]
}

export function parseForms(html: string): Form[] {
  const forms: Form[] = []
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1]
    const action = /action=["']([^"']+)["']/i.exec(attrs)?.[1] ?? '/'
    const method = (/method=["']([^"']+)["']/i.exec(attrs)?.[1] ?? 'get').toUpperCase()
    const inputs = [...m[2].matchAll(/<input\b[^>]*name=["']([^"']+)["'][^>]*>/gi)].map((i) => i[1])
    forms.push({ action, method, inputs })
  }
  return forms
}

const round2 = (n: number) => Math.round(n * 100) / 100
const data = (r: ToolCallResult) => r.data as Record<string, unknown> | string | undefined

export class OfflineRuntime implements AgentRuntime {
  readonly id = 'offline' as const

  constructor(private readonly options: { stepDelayMs?: number } = {}) {}

  async execute(assignment: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    try {
      switch (assignment.role) {
        case 'builder':
          return await this.build(assignment, ctx)
        case 'researcher':
          return await this.research(assignment, ctx)
        case 'thinker':
          return await this.challenge(ctx)
        case 'reporter':
          return await this.report(assignment, ctx)
        case 'improver':
          return await this.improve(ctx)
      }
    } catch (err) {
      if (ctx.signal.aborted) return { kind: 'cancelled', reason: String(ctx.signal.reason ?? 'cancelled') }
      return { kind: 'error', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  private counter = 0
  private async call(ctx: RuntimeContext, tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    await ctx.checkpoint()
    if (this.options.stepDelayMs) await sleep(this.options.stepDelayMs, ctx.signal)
    this.counter += 1
    return ctx.tools.call(`${ctx.tools.lease.taskId}:${this.counter}:${tool}`, tool, args)
  }

  private blocked(reason: string): Outcome {
    return { kind: 'blocked', reason }
  }

  // ----------------------------------------------------------------- builder

  private async build(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    const stack = a.context.stack
    await this.call(ctx, 'list_files', { depth: 1 })
    const readme = stack.topLevel.find((f) => /^readme/i.test(f))
    if (readme) await this.call(ctx, 'read_file', { path: readme, end_line: 60 })
    if (!ctx.tools.access().commands) {
      await this.call(ctx, 'report_blocked', { reason: 'Commands are off for this run, so the app cannot be installed or started.' })
      return this.blocked('commands are off')
    }
    if (stack.commands.install) {
      const install = await this.call(ctx, 'run_command', { command: stack.commands.install, purpose: 'Install dependencies' })
      if (!install.ok) {
        await this.call(ctx, 'report_blocked', { reason: `${stack.commands.install} failed: ${install.summary}` })
        return this.blocked('install failed')
      }
    }
    if (!stack.commands.start) {
      await this.call(ctx, 'report_blocked', { reason: 'No start command found in package.json, requirements, or common entry files.' })
      return this.blocked('no start command')
    }
    const started = await this.call(ctx, 'start_app', { command: stack.commands.start, health_path: '/' })
    if (!started.ok) {
      await this.call(ctx, 'report_blocked', { reason: `${stack.commands.start} did not serve the app: ${started.summary}` })
      return this.blocked('app did not start')
    }
    await this.call(ctx, 'http_request', { method: 'GET', path: '/' })
    return { kind: 'finished', reason: 'app started' }
  }

  // -------------------------------------------------------------- researcher

  private async research(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    const access = ctx.tools.access()
    const rules = new Map<string, StatedRule & { source: string }>()
    const codeFindings: { code: string; percent: number; actual: number; location: string }[] = []

    if (access.code) {
      const listing = await this.call(ctx, 'list_files', { depth: 3 })
      const files = String(data(listing) ?? '')
        .split('\n')
        .map((l) => l.replace(/\s+\(\d+ B\)$/, '').trim())
        .filter((l) => l && !l.endsWith('/'))
      const readme = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f))
      const sources = files.filter((f) => SOURCE_EXT.test(f)).slice(0, 20)
      for (const file of [...(readme ? [readme] : []), ...sources]) {
        const read = await this.call(ctx, 'read_file', { path: file })
        if (!read.ok) continue
        const text = String(data(read) ?? '')
        if (file === readme) for (const r of statedRules(text)) rules.set(r.code, { ...r, source: file })
        if (file !== readme) await this.call(ctx, 'note_surface', { kind: 'file', name: file })
      }
      for (const rule of rules.values()) {
        await this.call(ctx, 'note_surface', { kind: 'rule', name: `${rule.code} gives ${rule.percent}% off`, detail: `Stated in ${rule.source}` })
        const hits = await this.call(ctx, 'search_code', { query: rule.code, case_sensitive: true })
        for (const line of String(data(hits) ?? '').split('\n')) {
          const m = /^(.+?):(\d+): .*?\b[A-Z][A-Z0-9]{2,}\b['"]?\s*[:=]\s*([0-9.]+)/.exec(line)
          if (!m || !line.includes(rule.code) || SOURCE_EXT.test(m[1]) === false) continue
          const value = Number(m[3])
          const actualPercent = value <= 1 ? round2(value * 100) : value
          if (actualPercent !== rule.percent) codeFindings.push({ code: rule.code, percent: rule.percent, actual: actualPercent, location: `${m[1]}:${m[2]}` })
        }
      }
    }

    const proved = new Set<string>()
    if (access.http) {
      const home = await this.call(ctx, 'http_request', { method: 'GET', path: '/' })
      const body = String((data(home) as Record<string, unknown> | undefined)?.body ?? '')
      await this.call(ctx, 'note_surface', { kind: 'page', name: 'GET /' })
      for (const r of statedRules(stripTags(body))) if (!rules.has(r.code)) rules.set(r.code, { ...r, source: 'the home page' })
      const forms = parseForms(body).filter((f) => f.method === 'GET' && f.inputs.length > 0)
      for (const form of forms) await this.call(ctx, 'note_surface', { kind: 'form', name: `GET ${form.action} (${form.inputs.join(', ')})` })
      for (const rule of rules.values()) {
        for (const form of forms) {
          const path = `${form.action}?${encodeURIComponent(form.inputs[0])}=${encodeURIComponent(rule.code)}`
          const res = await this.call(ctx, 'http_request', { method: 'GET', path })
          const payload = data(res) as Record<string, unknown> | undefined
          let parsed: Record<string, unknown> | null = null
          try {
            parsed = JSON.parse(String(payload?.body ?? ''))
          } catch {
            parsed = null
          }
          if (!parsed || typeof parsed.subtotal !== 'number' || typeof parsed.total !== 'number') continue
          await this.call(ctx, 'note_surface', { kind: 'endpoint', name: `GET ${form.action}`, detail: 'Returns subtotal and total' })
          const expected = round2(parsed.subtotal * (1 - rule.percent / 100))
          if (round2(parsed.total) === expected) {
            await this.call(ctx, 'note', { text: `${rule.code}: total ${parsed.total} matches the stated ${rule.percent}% off.` })
            continue
          }
          const finding = codeFindings.find((f) => f.code === rule.code)
          const check: Check = { kind: 'json_equals', path: 'total', expected }
          await this.call(ctx, 'propose_claim', {
            title: `${rule.code} does not take ${rule.percent}% off the cart`,
            detail: `${rule.source} says ${rule.code} gives ${rule.percent}% off. For subtotal ${parsed.subtotal} the total should be ${expected}, but the app returned ${parsed.total}.`,
            severity: 'high',
            location: finding?.location ?? `GET ${form.action}`,
            reproduction: { steps: [{ method: 'GET', path }], check },
          })
          proved.add(rule.code)
        }
      }
    }

    for (const f of codeFindings) {
      if (proved.has(f.code)) continue
      await this.call(ctx, 'propose_claim', {
        title: `${f.code} is coded as ${f.actual}% off, not ${f.percent}%`,
        detail: `The README states ${f.code} gives ${f.percent}% off, but ${f.location} sets it to ${f.actual}%.`,
        severity: 'high',
        location: f.location,
      })
    }
    if (rules.size === 0) await this.call(ctx, 'note', { text: 'Found no stated percentage rules to check. Offline workers only check those; use Claude or Codex for deeper testing.' })
    return { kind: 'finished', reason: 'research done' }
  }

  // ----------------------------------------------------------------- thinker

  private async challenge(ctx: RuntimeContext): Promise<Outcome> {
    const access = ctx.tools.access()
    const listed = await this.call(ctx, 'list_claims', {})
    const claims = (data(listed) as unknown as { claim_id: string; reproduction: { steps: { method: string; path: string; body?: string }[]; check: Check } | null; location: string | null }[]) ?? []
    for (const claim of claims) {
      if (claim.reproduction && access.http) {
        let last: Record<string, unknown> | undefined
        for (const step of claim.reproduction.steps) last = data(await this.call(ctx, 'http_request', step)) as Record<string, unknown> | undefined
        const result = evaluateCheck(claim.reproduction.check, { status: Number(last?.status ?? 0), bodyText: String(last?.body ?? '') })
        await this.call(ctx, 'challenge_claim', {
          claim_id: claim.claim_id,
          stance: result.passed ? 'dispute' : 'agree',
          reasoning: result.passed
            ? `I re-ran the requests and the app returned ${result.actual}, which is what the claim says a correct app returns.`
            : `I re-ran the requests: expected ${result.expected}, got ${result.actual}. The defect reproduces.`,
        })
      } else if (claim.location && access.code && /:\d+$/.test(claim.location)) {
        const [file, line] = [claim.location.replace(/:\d+$/, ''), Number(claim.location.split(':').pop())]
        const read = await this.call(ctx, 'read_file', { path: file, start_line: line, end_line: line })
        await this.call(ctx, 'challenge_claim', {
          claim_id: claim.claim_id,
          stance: read.ok ? 'agree' : 'unsure',
          reasoning: read.ok ? `The cited line still reads: ${String(data(read) ?? '').trim()}` : `I could not read ${claim.location}.`,
        })
      } else {
        await this.call(ctx, 'challenge_claim', { claim_id: claim.claim_id, stance: 'unsure', reasoning: 'There is no reproduction or code location I can check in this mode.' })
      }
    }
    return { kind: 'finished', reason: `challenged ${claims.length} claim(s)` }
  }

  // ---------------------------------------------------------------- reporter

  private async report(a: Assignment, ctx: RuntimeContext): Promise<Outcome> {
    const summary = data(await this.call(ctx, 'get_run_summary', {})) as unknown as {
      app: { name: string; mode: string; url: string | null }
      claims: { claim_id: string; title: string; severity: string; location: string | null; status: string; verdict_reason: string | null; proposed_by: string }[]
      surface_noted: string[]
      workers: { role: Role; runtime: string; status: string; reason: string | null }[]
    }
    const by = (status: string) => summary.claims.filter((c) => c.status === status)
    const confirmed = by('confirmed')
    const open = summary.claims.filter((c) => c.status === 'disputed' || c.status === 'unverified' || c.status === 'open')
    const refuted = by('refuted')
    const lines = [
      `# ${summary.app.name} QA report`,
      '',
      '## Summary',
      `${a.context.finalReport ? 'Final' : 'Interim'} report. Mode: ${summary.app.mode}. ${summary.claims.length} claim(s): ${confirmed.length} confirmed, ${refuted.length} refuted, ${open.length} open.`,
      '',
      '## Confirmed defects',
      ...(confirmed.length ? confirmed.map((c) => `- **${c.title}** (${c.severity}) at ${c.location ?? 'n/a'}, claim ${c.claim_id}`) : ['None yet.']),
      '',
      '## Disputed and unverified',
      ...(open.length ? open.map((c) => `- ${c.title}: ${c.verdict_reason ?? 'not settled yet'} (claim ${c.claim_id})`) : ['None.']),
      '',
      '## Refuted',
      ...(refuted.length ? refuted.map((c) => `- ${c.title} (claim ${c.claim_id})`) : ['None.']),
      '',
      '## Coverage',
      ...(summary.surface_noted.length ? summary.surface_noted.slice(0, 30).map((s) => `- ${s}`) : ['Nothing mapped.']),
      '',
      '## Next steps',
      confirmed.length ? '- Fix the confirmed defects, then run again to confirm the fixes.' : '- Run with Claude or Codex workers for deeper testing.',
    ]
    await this.call(ctx, 'write_report', { markdown: lines.join('\n') })
    return { kind: 'finished', reason: 'report written' }
  }

  // ---------------------------------------------------------------- improver

  private async improve(ctx: RuntimeContext): Promise<Outcome> {
    const summary = data(await this.call(ctx, 'get_run_summary', {})) as unknown as { claims: { status: string }[]; workers: { role: string; status: string }[] }
    const dna = data(await this.call(ctx, 'get_dna', {})) as unknown as { rules: { text: string }[] }
    const has = (text: string) => dna.rules.some((r) => r.text.toLowerCase() === text.toLowerCase())
    const proposals: { role: Role; text: string; rationale: string }[] = []
    const refuted = summary.claims.filter((c) => c.status === 'refuted').length
    const confirmed = summary.claims.filter((c) => c.status === 'confirmed').length
    if (refuted > 0) {
      proposals.push({ role: 'researcher', text: 'Re-run every reproduction once with http_request and compare the result to your check before you propose the claim.', rationale: `${refuted} claim(s) in this run were refuted when the host replayed them.` })
    }
    if (confirmed > 0) {
      proposals.push({ role: 'researcher', text: 'For every percentage, price, or limit the app states, request the endpoint that applies it and compare the numbers.', rationale: `${confirmed} confirmed defect(s) came from checking a stated rule against the returned totals.` })
    }
    if (summary.workers.some((w) => w.role === 'builder' && w.status === 'blocked')) {
      proposals.push({ role: 'builder', text: 'Read the README run instructions first and try the documented start command before guessing.', rationale: 'The Builder was blocked in this run.' })
    }
    for (const p of proposals.filter((p) => !has(p.text)).slice(0, 2)) await this.call(ctx, 'propose_rule_change', { op: 'add', ...p })
    return { kind: 'finished', reason: 'improvement review done' }
  }
}
