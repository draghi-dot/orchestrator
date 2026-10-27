import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { OfflineRuntime } from '../src/main/runtimes/offline'
import type { AgentRuntime, RuntimeContext } from '../src/main/runtimes/types'
import { StaleOwnershipError } from '../src/main/store'
import { DEFAULT_LIMITS } from '../src/shared/domain'
import { applyRunEvent, initialRunView, arenaMetrics, scoreboard } from '../src/shared/fold'
import { makeHarness, waitFor, type Harness } from './helpers'
const fixtures: Harness[] = []
const setup = async (options?: Parameters<typeof makeHarness>[0]) => { const h = await makeHarness(options); fixtures.push(h); return h }
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close() })

describe('five-phase audit', () => {
  it('proves four sample bugs, rejects the decoy, and produces tests that pass after repairs', async () => {
    const h = await setup()
    const { run } = h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()
    const finished = h.store.getRun(run.id)
    expect(finished.terminalReason, JSON.stringify(h.store.listTasks(run.id).map((t) => t.terminalReason))).toBeNull()
    expect(finished.state).toBe('completed')
    expect(finished.summary).toMatchObject({ claims: 5, confirmed: 4, rejected: 1, needs_review: 0, inconclusive: 0 })
    const claims = h.store.listClaims(run.id)
    const confirmed = claims.filter((c) => c.status === 'confirmed')
    expect(confirmed.every((c) => !!c.regressionTestArtifactId)).toBe(true)
    const events = h.store.catchUp(0, run.id).events
    expect(events.filter((e) => e.type === 'phase_started').map((e) => e.payload.phase)).toEqual(['build', 'research', 'challenge', 'report', 'improve'])
    expect(events.filter((e) => e.type === 'regression_test_written').every((e) => e.payload.fails_now === true)).toBe(true)
    expect(h.store.latestReport(run.id)?.markdown).toContain('4 confirmed, 1 rejected')
    const reports = h.store.listReports(run.id)
    expect(reports).toHaveLength(2)
    expect(reports[0].markdown).toContain('Final report')
    expect(reports[1].markdown).toContain('Interim report')
    expect(reports[1].markdown).toContain('0 confirmed, 0 rejected, 5 open')
    expect(h.store.listRuleChanges({ runId: run.id }).every((r) => r.status === 'proposed')).toBe(true)
    expect(h.store.currentDna().version).toBe(1)
    expect(h.processes.appFor(run.id)).toBeNull()
    const serialized = JSON.stringify(events)
    for (const account of ['alice', 'bob']) expect(serialized).not.toContain(h.store.testAccountHeader(h.target.id, account)!.value)
    const view = events.reduce(applyRunEvent, initialRunView)
    expect(arenaMetrics(view)).toMatchObject({ confirmed: 4, rejected: 1, regressionTests: 4 })
    expect(scoreboard(view).find((s) => s.role === 'thinker')).toMatchObject({ challengesRight: 5, challengesWrong: 0 })
    expect(events.reduce(applyRunEvent, view)).toEqual(view)

    const work = join(h.dir, 'runs', run.id, 'app')
    const file = join(work, 'server.mjs')
    writeFileSync(file, readFileSync(file, 'utf8').replace('SAVE20: 0.15', 'SAVE20: 0.20').replace('subtotal > 100', 'subtotal >= 100').replace('!Number.isInteger(quantity) || quantity > 99', '!Number.isInteger(quantity) || quantity < 1 || quantity > 99').replace('const order = orders[orderId]', "const order = orders[orderId]\n      if (order && order.owner !== user) return json(403, { error: 'forbidden' })"))
    const env = {
      QA_SAMPLE_ALICE: h.store.testAccountHeader(h.target.id, 'alice')!.value,
      QA_SAMPLE_BOB: h.store.testAccountHeader(h.target.id, 'bob')!.value,
    }
    const app = await h.processes.startApp('repaired', 'node server.mjs', work, { healthPath: '/', readyTimeoutMs: 6000, signal: new AbortController().signal, env })
    for (const claim of confirmed) {
      const artifact = h.evidence.get(h.store.getArtifact(claim.regressionTestArtifactId!).sha256)
      const testFile = join(h.dir, `${claim.id}.test.mjs`)
      writeFileSync(testFile, artifact)
      const res = await promisify(execFile)(process.execPath, ['--test', testFile], { env: { ...process.env, ...h.testEnv, ...(h.testEnv.QA_TEST_SHOP_PATH ? { QA_TEST_SHOP_PATH: file } : {}), APP_URL: app.url, QA_ACCOUNT_ALICE_HEADER: 'Authorization', QA_ACCOUNT_ALICE_VALUE: env.QA_SAMPLE_ALICE }, timeout: 5000 })
      expect(res.stdout).toContain('pass 1')
    }
  }, 20000)

  it('runs source-only audits without starting a process', async () => {
    const h = await setup()
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    expect(h.store.listClaims(run.id).filter((c) => c.status === 'confirmed')).toHaveLength(4)
    expect(h.store.catchUp(0, run.id).events.some((e) => e.type === 'app_started')).toBe(false)
  })

  it('writes a final host fallback when the reporter stops after its interim report', async () => {
    const h = await setup({ runtimes: () => ({ id: 'offline', execute: async (assignment, context) => {
      if (assignment.role === 'reporter' && assignment.context.finalReport) {
        await context.tools.call('blocked-final', 'report_blocked', { reason: 'The reporter cannot finish.' })
        return { kind: 'blocked', reason: 'The reporter cannot finish.' }
      }
      return new OfflineRuntime().execute(assignment, context)
    } }) })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    const reports = h.store.listReports(run.id)
    expect(reports).toHaveLength(2)
    expect(reports[1].markdown).toContain('Interim report')
    expect(reports[0]).toMatchObject({ author: 'QA Arena host' })
    expect(reports[0].markdown).toContain('Reporter produced no report')
    const phase = h.store.catchUp(0, run.id).events.find((e) => e.type === 'phase_finished' && e.payload.phase === 'report')
    expect(phase?.payload.status).toBe('blocked')
  })

  it('amends contested evidence and uses only the new round’s challenge for settlement', async () => {
    let first = true
    const h = await setup({ runtimes: () => ({ id: 'offline', execute: async (a, ctx) => {
      if (a.role === 'thinker' && first) {
        first = false
        const result = await ctx.tools.call('claims', 'list_claims', {})
        for (const c of result.data as { claim_id: string }[]) await ctx.tools.call(c.claim_id, 'challenge_claim', { claim_id: c.claim_id, stance: 'unsure', reasoning: 'Please clarify the evidence in a second round.' })
        return { kind: 'finished', reason: 'Requested clarification' }
      }
      return new OfflineRuntime().execute(a, ctx)
    } }) })
    const { run } = h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    expect(h.store.listClaims(run.id).filter((c) => c.status === 'confirmed')).toHaveLength(4)
    expect(h.store.catchUp(0, run.id).events.filter((e) => e.type === 'round_started').map((e) => e.payload.round)).toEqual([1, 2])
    expect(h.store.listClaims(run.id).filter((c) => c.status === 'confirmed').every((c) => c.round === 2)).toBe(true)
  }, 20000)

  it('keeps an idempotent request single and rejects a changed contract', async () => {
    const h = await setup()
    const input = h.startInput({ mode: 'white', allowCommands: false })
    const first = h.orchestrator.start(input)
    expect(h.orchestrator.start(input)).toMatchObject({ created: false, run: { id: first.run.id } })
    expect(() => h.orchestrator.start({ ...input, audit: { ...input.audit, depth: 'deep' } })).toThrow(/different run/)
    await h.orchestrator.idle()
    expect(h.store.listRuns()).toHaveLength(1)
  })
})

describe('worker control', () => {
  it('force-stops an uncooperative worker and rejects its late writes', async () => {
    let context: RuntimeContext | undefined
    const stuck: AgentRuntime = { id: 'offline', execute: async (_a, ctx) => { context = ctx; return new Promise(() => {}) } }
    const h = await setup({ runtimes: () => stuck, grace: 20 })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false }))
    await waitFor(() => !!context)
    h.orchestrator.requestCancel(run.id, 'test')
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('cancelled')
    expect(() => h.store.workerAppend(context!.tools.lease, 'agent_message', { text: 'late' })).toThrow(StaleOwnershipError)
  })

  it('times out an uncooperative worker without turning it into success', async () => {
    const h = await setup({ runtimes: () => ({ id: 'offline', execute: () => new Promise(() => {}) }), grace: 20 })
    const limits = structuredClone(DEFAULT_LIMITS); limits.taskTimeoutSeconds.researcher = 0.03
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false, limits }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'failed', terminalReason: expect.stringContaining('deadline') })
  })

  it('acknowledges pause at a checkpoint, then resumes to completion', async () => {
    let ctx: RuntimeContext | undefined; let release!: () => void
    const h = await setup({ runtimes: () => ({ id: 'offline', execute: async (a, c) => {
      if (a.role === 'researcher') { ctx = c; await new Promise<void>((r) => { release = r }); await c.checkpoint() }
      return new OfflineRuntime().execute(a, c)
    } }) })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false }))
    await waitFor(() => !!ctx)
    h.orchestrator.requestPause(run.id, 'test'); release()
    await waitFor(() => h.store.getRun(run.id).state === 'paused')
    h.orchestrator.resume(run.id, 'test')
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
  })

  it('recovers orphaned work without claiming completion', async () => {
    const h = await setup(); const { run, lease } = h.makeTools()
    expect(h.store.recoverOrphans('restart')).toContain(run.id)
    expect(h.store.getRun(run.id).state).toBe('failed')
    expect(() => h.store.assertOwner(lease)).toThrow(StaleOwnershipError)
  })
})
