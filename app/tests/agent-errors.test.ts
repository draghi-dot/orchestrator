import { afterEach, describe, expect, it } from 'vitest'
import type { AgentAdapter } from '../src/main/adapters/types'
import { EvidenceIntegrityError } from '../src/main/evidence'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Harness, eventTypes, makeHarness } from './helpers'

let h: Harness
afterEach(async () => h?.close())

const only = (caseId: string) => ({ caseIds: [caseId] })

describe('agent failures never become passes', () => {
  it('records an adapter exception as an error attempt', async () => {
    h = await makeHarness({ adapter: () => ({ id: 'scripted', execute: async () => { throw new Error('provider exploded') } }) })
    const { run } = h.orchestrator.start(h.startInput(only('checkout-discount-10')))
    await h.orchestrator.idle()
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('error')
    expect(attempt.terminalReason).toContain('provider exploded')
    expect(h.store.getRun(run.id).state).toBe('completed')
    expect(h.store.listAssertionResults(attempt.id)).toHaveLength(0)
  })

  it('blocks when the agent claims success but recorded no evidence', async () => {
    const liar: AgentAdapter = {
      id: 'scripted',
      execute: async (_a, ctx) => {
        ctx.tools.recordAgentMessage('All assertions passed. The total was $96.')
        return { kind: 'finished', reason: 'claimed success' }
      },
    }
    h = await makeHarness({ adapter: () => liar })
    const { run } = h.orchestrator.start(h.startInput(only('checkout-discount-20')))
    await h.orchestrator.idle()
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('blocked')
    expect(h.store.listAssertionResults(attempt.id).every((r) => r.status === 'blocked')).toBe(true)
  })

  it('turns a deadline into an error attempt', async () => {
    const slow: AgentAdapter = {
      id: 'scripted',
      execute: (_a, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ kind: 'cancelled', reason: String(ctx.signal.reason) }))),
    }
    h = await makeHarness({ adapter: () => slow })
    const version = h.store.getSuiteVersion(h.suiteVersionId)
    const tight = h.store.addSuiteVersion({
      suiteId: version.suiteId,
      sourceRevision: 'tight-timeout',
      cases: version.cases.map((c) => ({ ...c, timeoutSeconds: 0.1 })),
    })
    const { run } = h.orchestrator.start(h.startInput({ suiteVersionId: tight.id, ...only('storefront-loads') }))
    await h.orchestrator.idle()
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('error')
    expect(attempt.terminalReason).toContain('timeout')
  })
})

describe('tool policy', () => {
  it('rejects requests outside the allowed origins', async () => {
    const wanderer: AgentAdapter = {
      id: 'scripted',
      execute: async (a, ctx) => {
        const r = await ctx.tools.call('t1', 'http_request', { step_id: a.testCase.steps[0].id, method: 'GET', url: 'https://example.com/' })
        expect(r.ok).toBe(false)
        return { kind: 'finished', reason: 'done' }
      },
    }
    h = await makeHarness({ adapter: () => wanderer })
    const { run } = h.orchestrator.start(h.startInput(only('storefront-loads')))
    await h.orchestrator.idle()
    expect(eventTypes(h.store, run.id)).toContain('tool_rejected')
    expect(h.store.listAttempts(run.id)[0].status).toBe('blocked')
  })

  it('refuses mutating methods and credential headers by default', async () => {
    const results: boolean[] = []
    const pusher: AgentAdapter = {
      id: 'scripted',
      execute: async (a, ctx) => {
        const step = a.testCase.steps[0].id
        results.push((await ctx.tools.call('p1', 'http_request', { step_id: step, method: 'POST', url: '/api/cart' })).ok)
        results.push((await ctx.tools.call('p2', 'http_request', { step_id: step, method: 'GET', url: '/', headers: { Authorization: 'x' } })).ok)
        results.push((await ctx.tools.call('p3', 'delete_database', {})).ok)
        return { kind: 'finished', reason: 'done' }
      },
    }
    h = await makeHarness({ adapter: () => pusher })
    const { run } = h.orchestrator.start(h.startInput(only('storefront-loads')))
    await h.orchestrator.idle()
    expect(results).toEqual([false, false, false])
    expect(eventTypes(h.store, run.id).filter((t) => t === 'tool_rejected')).toHaveLength(3)
  })

  it('executes a redelivered tool call id once', async () => {
    let hits = 0
    const counting: typeof fetch = async (input, init) => {
      hits += 1
      return fetch(input, init)
    }
    const repeater: AgentAdapter = {
      id: 'scripted',
      execute: async (a, ctx) => {
        const args = { step_id: a.testCase.steps[0].id, method: 'GET', url: '/' }
        const first = await ctx.tools.call('same-id', 'http_request', args)
        const second = await ctx.tools.call('same-id', 'http_request', args)
        expect(second).toEqual(first)
        return { kind: 'finished', reason: 'done' }
      },
    }
    h = await makeHarness({ adapter: () => repeater })
    // Swap in a counting fetch through a fresh orchestrator on the same store.
    const { Orchestrator } = await import('../src/main/orchestrator')
    const counted = new Orchestrator({ store: h.store, evidence: h.evidence, adapters: () => repeater, fetchImpl: counting, cancelGraceMs: 200 })
    const { run } = counted.start(h.startInput(only('storefront-loads')))
    await counted.idle()
    expect(hits).toBe(1)
    expect(eventTypes(h.store, run.id).filter((t) => t === 'tool_called')).toHaveLength(1)
    expect(h.store.listAttempts(run.id)[0].status).toBe('passed')
  })
})

describe('evidence integrity', () => {
  it('refuses to serve bytes that no longer match their hash', async () => {
    h = await makeHarness()
    const digest = h.evidence.put(new TextEncoder().encode('original'))
    writeFileSync(join(h.evidence.root, digest), 'tampered')
    expect(() => h.evidence.get(digest)).toThrow(EvidenceIntegrityError)
  })
})
