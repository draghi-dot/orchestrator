import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPlaneApi } from '../src/main/api'
import { AccountManager } from '../src/main/accounts'
import { SettingsStore } from '../src/main/settings'
import { applyRunEvent, initialRunView } from '../src/shared/fold'
import { makeHarness, type Harness } from './helpers'
const fixtures: Harness[] = []
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close() })
async function setup() {
  const h = await makeHarness(); fixtures.push(h)
  const settings = new SettingsStore(h.dir); const accounts = new AccountManager(() => settings.get(), h.dir)
  const saveFile = vi.fn(async (_name: string, _data: Uint8Array) => '/tmp/exported-report.md')
  const api = new ControlPlaneApi({ store: h.store, evidence: h.evidence, orchestrator: h.orchestrator, importer: h.importer, settings, accounts,
    operator: 'reviewer', knowledge: () => null, chooseZip: async () => null, saveFile, openUrl: async () => {},
  })
  return { ...h, api, saveFile, accounts }
}
describe('operator API', () => {
  it('keeps account values host-only and prevents mutation during an active run', async () => {
    const h = await setup(); const secret = h.store.testAccountHeader(h.target.id, 'alice')!.value
    const data = await h.api.query('targetSetup', { targetId: h.target.id })
    expect(JSON.stringify(data)).not.toContain(secret)
    expect(data.accounts[0]).toMatchObject({ name: 'alice', configured: true })
    const { run } = h.makeTools()
    await expect(h.api.command({ type: 'setTestAccount', targetId: h.target.id, name: 'alice', headerName: 'Authorization', headerValue: 'changed' })).rejects.toThrow(/Finish or cancel/)
    await expect(h.api.command({ type: 'removeTestAccount', targetId: h.target.id, name: 'alice' })).rejects.toThrow(/Finish or cancel/)
    h.store.recoverOrphans('test ended')
    await h.api.command({ type: 'setTestAccount', targetId: h.target.id, name: 'alice', headerName: 'Authorization', headerValue: 'changed' })
    expect(h.store.getRun(run.id).state).toBe('failed')
    expect(h.store.testAccountHeader(h.target.id, 'alice')!.value).toBe('changed')
    await h.api.command({ type: 'removeTestAccount', targetId: h.target.id, name: 'alice' })
    expect(h.store.testAccountHeader(h.target.id, 'alice')).toBeNull()
  })

  it('records a reasoned review once, after the run, without rewriting host evidence', async () => {
    const h = await setup(); const { run, lease } = h.makeTools('researcher', { mode: 'white' })
    const claim = h.store.proposeClaim(lease, { title: 'Unresolved edge case', detail: 'The specification needs a decision.', category: 'business_logic', severity: 'medium', severityRationale: 'Affects pricing', area: 'white', location: null, evidenceQuote: null, reproduction: null, suggestedFix: null }, 10)
    h.store.settleClaim(claim.id, 'needs_review', 'Challenger disputes the specification')
    const review = { type: 'reviewClaim' as const, claimId: claim.id, decision: 'accepted' as const, reason: 'The product rule explicitly requires this behavior.' }
    await expect(h.api.command(review)).rejects.toThrow(/finish/)
    h.store.recoverOrphans('test ended')
    await expect(h.api.command({ ...review, reason: '  ' })).rejects.toThrow(/reason/)
    await h.api.command(review)
    await expect(h.api.command(review)).rejects.toThrow(/already decided/)
    const detail = await h.api.query('runDetail', { runId: run.id })
    expect(detail.claims[0]).toMatchObject({ status: 'needs_review', verdictReason: 'Challenger disputes the specification', review: { decision: 'accepted', reviewer: 'reviewer' } })
    expect(await h.api.query('reviewQueue', undefined)).toEqual([])
  })

  it('versions accepted DNA only and preserves existing run contracts', async () => {
    const h = await setup(); const { run, lease } = h.makeTools('improver')
    const initial = h.store.currentDna()
    const change = h.store.proposeRuleChange(lease, { op: 'add', role: 'researcher', ruleId: null, text: 'Check the exact threshold as well as values around it.', rationale: 'Boundary comparisons were missed.' })
    await expect(h.api.command({ type: 'decideRuleChange', changeId: change.id, decision: 'accepted', reason: '' })).rejects.toThrow(/reason/)
    await h.api.command({ type: 'decideRuleChange', changeId: change.id, decision: 'accepted', reason: 'Useful and specific.' })
    expect(h.store.currentDna().version).toBe(initial.version + 1)
    expect(h.store.getRun(run.id).contract.dnaVersionId).toBe(initial.id)
    await expect(h.api.command({ type: 'decideRuleChange', changeId: change.id, decision: 'accepted', reason: 'Again' })).rejects.toThrow(/already/)
    const second = h.store.proposeRuleChange(lease, { op: 'add', role: 'all', ruleId: null, text: 'Duplicate advice', rationale: 'Not useful' })
    await h.api.command({ type: 'decideRuleChange', changeId: second.id, decision: 'rejected', reason: 'Already covered.' })
    expect(h.store.currentDna().version).toBe(initial.version + 1)
  })

  it('exports the real saved report and honors cancelled import dialogs', async () => {
    const h = await setup(); const { run } = h.makeTools()
    await expect(h.api.command({ type: 'exportReport', runId: run.id })).rejects.toThrow(/No report/)
    h.store.writeReport(run.id, null, 'test', '# Actual report\n\nEvidence linked here.\n')
    expect(await h.api.command({ type: 'exportReport', runId: run.id })).toEqual({ path: '/tmp/exported-report.md' })
    expect(new TextDecoder().decode(h.saveFile.mock.calls[0]![1] as Uint8Array)).toBe('# Actual report\n\nEvidence linked here.\n')
    expect(await h.api.command({ type: 'chooseZip' })).toEqual({ targetId: null })
  })

  it('catches up a long event history in ordered pages and folds duplicate delivery safely', async () => {
    const h = await setup(); const { run, lease } = h.makeTools()
    for (let i = 0; i < 2100; i++) h.store.workerAppend(lease, 'agent_message', { text: `event ${i}` })
    const first = await h.api.query('events', { runId: run.id, afterSeq: 0 })
    expect(first.events).toHaveLength(2000); expect(first.complete).toBe(false)
    const next = await h.api.query('events', { runId: run.id, afterSeq: first.events.at(-1)!.seq })
    expect(next.complete).toBe(true)
    const all = [...first.events, ...next.events]
    const folded = all.reduce(applyRunEvent, initialRunView)
    expect(folded.seq).toBe(h.store.latestSeq())
    expect([...all, ...all].reduce(applyRunEvent, initialRunView)).toEqual(folded)
    expect(h.store.catchUp(0, run.id).events.reduce(applyRunEvent, initialRunView)).toEqual(folded)
  })
})
