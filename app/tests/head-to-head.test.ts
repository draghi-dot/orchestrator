import { afterEach, describe, expect, it } from 'vitest'
import { OfflineRuntime } from '../src/main/runtimes/offline'
import type { AgentRuntime, Assignment, Outcome, RuntimeContext } from '../src/main/runtimes/types'
import type { ToolCallResult } from '../src/main/tools'
import type { WorkerProfile } from '../src/shared/domain'
import { applyRunEvent, arenaMetrics, contest, initialRunView } from '../src/shared/fold'
import { makeHarness, type Harness } from './helpers'
const fixtures: Harness[] = []
const setup = async (options?: Parameters<typeof makeHarness>[0]) => { const h = await makeHarness(options); fixtures.push(h); return h }
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close() })

const CONTENDERS: WorkerProfile[] = [{ runtime: 'claude', model: '' }, { runtime: 'codex', model: '' }]
type Execute = (a: Assignment, ctx: RuntimeContext) => Promise<Outcome>
/** Plays each contender with the offline worker, under the contender's runtime id. */
const contenders = (override?: (profile: WorkerProfile) => Execute | null) => (profile: WorkerProfile): AgentRuntime =>
  ({ id: profile.runtime, execute: override?.(profile) ?? ((a, ctx) => new OfflineRuntime().execute(a, ctx)) })

describe('head-to-head audit', () => {
  it('runs one lane per contender, and each contender reviews only the other’s findings', async () => {
    const h = await setup({ runtimes: contenders() })
    const { run } = h.orchestrator.start(h.startInput({ contenders: CONTENDERS }))
    await h.orchestrator.idle()
    const finished = h.store.getRun(run.id)
    expect(finished.terminalReason, JSON.stringify(h.store.listTasks(run.id).map((t) => t.terminalReason))).toBeNull()
    expect(finished.state).toBe('completed')
    expect(finished.contract.contenders).toEqual(CONTENDERS)
    expect(finished.summary).toMatchObject({ claims: 10, confirmed: 8, rejected: 2 })

    const tasks = h.store.listTasks(run.id)
    const lanesOf = (role: string, phase: string) => tasks.filter((t) => t.role === role && t.phase === phase).map((t) => [t.lane, t.runtime])
    expect(lanesOf('researcher', 'research')).toEqual([[0, 'claude'], [1, 'codex']])
    expect(lanesOf('thinker', 'challenge')).toEqual([[0, 'claude'], [1, 'codex']])
    expect(lanesOf('reporter', 'research')).toEqual([[0, 'offline']])

    const claims = h.store.listClaims(run.id)
    expect(claims.filter((c) => c.lane === 0)).toHaveLength(5)
    expect(claims.filter((c) => c.lane === 1).every((c) => c.runtime === 'codex')).toBe(true)
    for (const claim of claims) {
      const challenges = h.store.listChallenges(claim.id)
      expect(challenges.length).toBeGreaterThan(0)
      expect(challenges.every((ch) => h.store.getTask(ch.taskId).lane !== claim.lane)).toBe(true)
    }

    const events = h.store.catchUp(0, run.id).events
    const view = events.reduce(applyRunEvent, initialRunView)
    expect(view.contenders).toEqual(CONTENDERS)
    const standings = contest(view)
    expect(standings).toHaveLength(2)
    for (const s of standings) expect(s).toMatchObject({ findings: 5, held: 4, fell: 1, rightCalls: 5, wrongCalls: 0, caught: 1, points: 12 })
    expect(arenaMetrics(view)).toMatchObject({ confirmed: 8, rejected: 2, caughtByReview: 2 })
    expect(events.reduce(applyRunEvent, view)).toEqual(view)

    const report = h.store.latestReport(run.id)!.markdown
    expect(report).toContain('## Head to head')
    expect(report).toContain('Contender A (Claude)**: 12 points')
  }, 30000)

  it('scores the contender whose review catches a false positive', async () => {
    // Contender B agrees with everything it reviews, including A's decoy.
    const yes: Execute = async (a, ctx) => {
      if (a.role !== 'thinker') return new OfflineRuntime().execute(a, ctx)
      const listed = await ctx.tools.call('list', 'list_claims', {})
      for (const c of listed.data as { claim_id: string }[]) await ctx.tools.call(c.claim_id, 'challenge_claim', { claim_id: c.claim_id, stance: 'agree', reasoning: 'Looks like a real defect to me.' })
      return { kind: 'finished', reason: 'Agreed with everything' }
    }
    const h = await setup({ runtimes: contenders((p) => (p.runtime === 'codex' ? yes : null)) })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false, contenders: CONTENDERS }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    const [a, b] = contest(h.store.catchUp(0, run.id).events.reduce(applyRunEvent, initialRunView))
    expect(a).toMatchObject({ rightCalls: 5, wrongCalls: 0, caught: 1 })
    expect(b).toMatchObject({ rightCalls: 4, wrongCalls: 1, caught: 0 })
    expect(a.points - b.points).toBe(2)
  }, 30000)

  it('keeps going when one contender cannot work, without confirming unreviewed findings', async () => {
    const broken: Execute = async () => ({ kind: 'error', reason: 'Codex is not signed in' })
    const h = await setup({ runtimes: contenders((p) => (p.runtime === 'codex' ? broken : null)) })
    const { run } = h.orchestrator.start(h.startInput({ contenders: CONTENDERS }))
    await h.orchestrator.idle()
    const finished = h.store.getRun(run.id)
    expect(finished.state).toBe('completed')
    expect(finished.summary).toMatchObject({ claims: 5, confirmed: 0, needs_review: 4, rejected: 1 })
    const research = h.store.catchUp(0, run.id).events.find((e) => e.type === 'phase_finished' && e.payload.phase === 'research')
    expect(research?.payload).toMatchObject({ status: 'blocked', note: expect.stringContaining('Codex is not signed in') })
    const [, b] = contest(h.store.catchUp(0, run.id).events.reduce(applyRunEvent, initialRunView))
    expect(b).toMatchObject({ findings: 0, rulings: 0, points: 0 })
  }, 30000)

  it('fails when neither contender can test the app', async () => {
    const h = await setup({ runtimes: contenders((p) => (p.runtime === 'offline' ? null : async () => ({ kind: 'error', reason: `${p.runtime} is not signed in` }))) })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false, contenders: CONTENDERS }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'failed', terminalReason: expect.stringContaining('Neither contender finished testing') })
  })

  it('refuses rulings on your own lane and revisions of the other lane', async () => {
    const seen: { own: ToolCallResult; listedLanes: number[]; revise: ToolCallResult } = {} as never
    let h!: Harness
    const probe: Execute = async (a, ctx) => {
      const lane = ctx.tools.lease.lane
      if (a.role === 'thinker' && a.prompt.includes('Debate round: 1.')) {
        if (lane === 0) {
          const own = h.store.listClaims(a.runId).find((c) => c.lane === 0)!
          seen.own = await ctx.tools.call('own', 'challenge_claim', { claim_id: own.id, stance: 'agree', reasoning: 'My own finding is certainly right.' })
        }
        const listed = (await ctx.tools.call('list', 'list_claims', {})).data as { claim_id: string }[]
        if (lane === 0) seen.listedLanes = listed.map((c) => h.store.getClaim(c.claim_id).lane)
        // Unsure about everything in round 1, so both lanes revise in round 2.
        for (const c of listed) await ctx.tools.call(c.claim_id, 'challenge_claim', { claim_id: c.claim_id, stance: 'unsure', reasoning: 'I could not check this one yet.' })
        return { kind: 'finished', reason: 'Unsure' }
      }
      if (a.role === 'researcher' && ctx.tools.purpose === 'revise' && lane === 1) {
        const rival = h.store.listClaims(a.runId).find((c) => c.lane === 0 && !c.withdrawn)!
        seen.revise = await ctx.tools.call('rival', 'revise_claim', { claim_id: rival.id, action: 'withdraw' })
      }
      return new OfflineRuntime().execute(a, ctx)
    }
    h = await setup({ runtimes: contenders(() => probe) })
    const { run } = h.orchestrator.start(h.startInput({ mode: 'white', allowCommands: false, contenders: CONTENDERS }))
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    expect(seen.own).toMatchObject({ ok: false, summary: expect.stringContaining('other contender') })
    expect(seen.listedLanes.length).toBeGreaterThan(0)
    expect(seen.listedLanes.every((lane) => lane === 1)).toBe(true)
    expect(seen.revise).toMatchObject({ ok: false, summary: expect.stringContaining('your own findings') })
    expect(h.store.listTasks(run.id).filter((t) => t.role === 'researcher' && t.phase === 'challenge').map((t) => t.lane)).toEqual([0, 1])
    expect(h.store.getRun(run.id).summary).toMatchObject({ confirmed: 8, rejected: 2 })
  }, 30000)

  it('validates the contenders', async () => {
    const h = await setup()
    expect(() => h.store.startRun(h.startInput({ contenders: [CONTENDERS[0]] }))).toThrow(/exactly two/)
    expect(() => h.store.startRun(h.startInput({ contenders: [CONTENDERS[0], { ...CONTENDERS[0] }] }))).toThrow(/two different/)
    expect(() => h.store.startRun(h.startInput({ contenders: [CONTENDERS[0], { runtime: 'gpt' as never, model: '' }] }))).toThrow(/exactly two/)
    expect(h.store.startRun(h.startInput({ contenders: [CONTENDERS[0], { runtime: 'claude', model: 'haiku' }] })).run.contract.contenders).toHaveLength(2)
    expect(h.store.startRun(h.startInput()).run.contract.contenders).toEqual([])
  })
})
