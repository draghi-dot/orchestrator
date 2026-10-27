import { afterEach, describe, expect, it } from 'vitest'
import { AuthorizationConflictError } from '../src/main/store'
import { type Harness, eventTypes, makeHarness } from './helpers'

let h: Harness
afterEach(async () => h?.close())

describe('start idempotency', () => {
  it('returns the same run for a repeated key and writes one run_created', async () => {
    h = await makeHarness()
    const input = h.startInput({ idempotencyKey: 'double-click' })
    const first = h.store.startRun(input)
    const second = h.store.startRun(input)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.run.id).toBe(first.run.id)
    expect(h.store.listRuns()).toHaveLength(1)
    expect(eventTypes(h.store, first.run.id).filter((t) => t === 'run_created')).toHaveLength(1)
  })

  it('rejects a reused key with a different contract', async () => {
    h = await makeHarness()
    h.store.startRun(h.startInput({ idempotencyKey: 'k' }))
    expect(() => h.store.startRun(h.startInput({ idempotencyKey: 'k', buildRevision: 'other-build' }))).toThrow(AuthorizationConflictError)
    expect(h.store.listRuns()).toHaveLength(1)
  })

  it('rejects cases outside the suite version', async () => {
    h = await makeHarness()
    expect(() => h.store.startRun(h.startInput({ caseIds: ['not-a-case'] }))).toThrow(AuthorizationConflictError)
  })

  it('freezes the environment into the contract', async () => {
    h = await makeHarness()
    const { run } = h.store.startRun(h.startInput())
    h.store.updateEnvironmentBaseUrl('env_demo_local', 'http://127.0.0.1:1', ['http://127.0.0.1:1'])
    expect(h.store.getRun(run.id).contract.environment.baseUrl).toBe(h.demo.origin)
    expect(JSON.stringify(h.store.getRun(run.id).contract)).not.toContain('keychain://')
  })
})

describe('demo suite run', () => {
  it('completes with a real failing assertion from the planted defect', async () => {
    h = await makeHarness()
    const { run } = h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()

    const final = h.store.getRun(run.id)
    expect(final.state).toBe('completed')
    expect(final.summary).toEqual({ passed: 3, failed: 1, blocked: 0, error: 0, cancelled: 0, total: 4 })

    const failed = h.store.listAttempts(run.id).find((a) => a.caseId === 'checkout-discount-20')!
    expect(failed.status).toBe('failed')
    const results = h.store.listAssertionResults(failed.id)
    const total = results.find((r) => r.assertionId === 'save20-total')!
    expect(total.status).toBe('failed')
    expect(total.expected).toBe('total == 96')
    expect(total.actual).toBe('total == 90')
    expect(total.artifactIds).toHaveLength(1)
  })

  it('stores artifacts whose bytes match their hash, with cookies redacted', async () => {
    h = await makeHarness()
    const { run } = h.orchestrator.start(h.startInput({ caseIds: ['checkout-discount-10'] }))
    await h.orchestrator.idle()
    const saved = h.store.catchUp(0, run.id).events.filter((e) => e.type === 'artifact_saved')
    expect(saved).toHaveLength(1)
    const artifact = h.store.getArtifact(String(saved[0].payload.artifact_id))
    const bytes = h.evidence.get(artifact.sha256)
    expect(bytes.byteLength).toBe(artifact.bytes)
    expect(artifact.redaction).toBe('headers_redacted')
    expect(bytes.toString('utf8')).toContain('set-cookie: [redacted]')
    expect(bytes.toString('utf8')).not.toContain('demo-session')
  })

  it('keeps the event log gap-free and ordered', async () => {
    h = await makeHarness()
    h.orchestrator.start(h.startInput())
    h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()
    const seqs = h.store.catchUp(0).events.map((e) => e.seq)
    expect(seqs).toEqual(seqs.map((_, i) => i + 1))
  })
})
