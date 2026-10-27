import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { allowedLoginUrl } from '../src/main/accounts'
import { parseGithubUrl } from '../src/main/importer'
import { KnowledgeBase } from '../src/main/knowledge'
import { tokenize } from '../src/main/processes'
import { verifyClaim, writeRegressionTest } from '../src/main/verify'
import { performHttp } from '../src/main/tools'
import { DEFAULT_AUDIT } from '../src/shared/domain'
import { InvalidEventPayloadError, validateEvent } from '../src/shared/events'
import { nextRunState, nextTaskStatus } from '../src/shared/lifecycle'
import { buildQuestionnaire, setupFromAnswers } from '../src/shared/questionnaire'
import { settleClaim } from '../src/shared/verdict'
import { makeHarness, type Harness } from './helpers'
const fixtures: Harness[] = []
const setup = async () => { const h = await makeHarness(); fixtures.push(h); return h }
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close() })

describe('verdict and lifecycle rules', () => {
  it.each([
    ['reproduced', ['agree'], 'confirmed'], ['reproduced', ['dispute'], 'needs_review'],
    ['reproduced', [], 'needs_review'], ['not_reproduced', ['agree'], 'rejected'],
    ['code_verified', ['agree'], 'confirmed'], ['code_missing', ['agree'], 'rejected'],
    ['error', ['agree'], 'inconclusive'], ['no_evidence', ['agree'], 'inconclusive'],
  ] as const)('%s with %j becomes %s', (e, s, expected) => { expect(settleClaim(e, [...s]).status).toBe(expected) })
  it('latches cancellation and closes tasks once', () => {
    expect(nextRunState('cancel_requested', 'cancel')).toBe('cancelled')
    expect(() => nextRunState('cancel_requested', 'complete')).toThrow()
    expect(() => nextRunState('completed', 'start')).toThrow()
    expect(nextTaskStatus('running', 'finish')).toBe('done')
    expect(() => nextTaskStatus('done', 'finish')).toThrow()
    expect(() => validateEvent('claim_verdict', { claim_id: 'x' })).toThrow(InvalidEventPayloadError)
  })
})

describe('scope and local tools', () => {
  it('enforces black-box access and excluded paths, including symlinks', async () => {
    const h = await setup()
    const black = h.makeTools('researcher', { mode: 'black' })
    expect((await black.tools.call('read', 'read_file', { path: 'server.mjs' })).ok).toBe(false)
    const white = h.makeTools('researcher', { mode: 'white', audit: { ...DEFAULT_AUDIT, excludedPaths: ['server.mjs'] } })
    expect((await white.tools.call('read', 'read_file', { path: 'server.mjs' })).ok).toBe(false)
    expect((await white.tools.call('traverse', 'read_file', { path: '../outside.txt' })).ok).toBe(false)
    symlinkSync('/etc/hosts', join(h.target.latestSnapshot!.rootPath, 'escape.txt'))
    expect((await white.tools.call('link', 'read_file', { path: 'escape.txt' })).ok).toBe(false)
    expect(String((await white.tools.call('list', 'list_files', {})).data)).not.toContain('server.mjs')
  })

  it('executes a repeated concurrent tool call only once', async () => {
    const h = await setup(); const { tools, run } = h.makeTools()
    await Promise.all([tools.call('same', 'note', { text: 'only once' }), tools.call('same', 'note', { text: 'only once' })])
    expect(h.store.catchUp(0, run.id).events.filter((e) => e.type === 'agent_message' && e.payload.text === 'only once')).toHaveLength(1)
  })

  it('refuses writes against external deployments and cross-origin requests', async () => {
    const h = await setup(); const { run } = h.makeTools('researcher', { externalUrl: 'https://staging.example.com' })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const deps = { store: h.store, evidence: h.evidence, signal: new AbortController().signal, runId: run.id, lease: null, base: 'https://staging.example.com', local: null, external: 'https://staging.example.com', fetchImpl }
    await expect(performHttp(deps, { method: 'POST', path: '/' })).rejects.toThrow(/refused/)
    await expect(performHttp(deps, { method: 'GET', path: 'https://other.example.com/' })).rejects.toThrow(/not the app/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('injects approved credentials, redacts echoed values, and never follows redirects', async () => {
    const h = await setup(); const { run } = h.makeTools('researcher', { externalUrl: 'https://staging.example.com' })
    const secret = h.store.testAccountHeader(h.target.id, 'alice')!.value
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).Authorization).toBe(secret)
      expect(init!.redirect).toBe('manual')
      return new Response(JSON.stringify({ echoed: secret }), { headers: { 'set-cookie': secret, 'x-echo': secret } })
    })
    const response = await performHttp({ store: h.store, evidence: h.evidence, signal: new AbortController().signal, runId: run.id, lease: null, base: 'https://staging.example.com', local: null, external: 'https://staging.example.com', fetchImpl: fetchMock as typeof fetch }, { method: 'GET', path: '/', account: { account: 'alice', name: 'Authorization', value: secret } })
    expect(response.bodyText).not.toContain(secret)
    expect(response.bodyText).toContain('[redacted]')
    const artifact = h.store.getArtifact(response.artifactId)
    expect(h.evidence.get(artifact.sha256).toString()).not.toContain(secret)
  })

  it('matches code quotes at their exact location and rejects a wrong line', async () => {
    const h = await setup(); const { run, lease } = h.makeTools('researcher', { mode: 'white' })
    const quote = 'const rates = { SAVE10: 0.10, SAVE20: 0.15 }'
    const line = readFileSync(join(h.target.latestSnapshot!.rootPath, 'server.mjs'), 'utf8').split('\n').indexOf(quote) + 1
    const claim = h.store.proposeClaim(lease, { title: 'Discount is incorrect', detail: 'The README promises twenty percent.', category: 'business_logic', severity: 'high', severityRationale: 'Incorrect customer billing', area: 'white', location: `server.mjs:${line}`, evidenceQuote: quote, reproduction: null, suggestedFix: 'Use the correct rate' }, 10)
    const deps = { store: h.store, evidence: h.evidence, signal: new AbortController().signal }
    expect((await verifyClaim(deps, run, claim)).outcome).toBe('code_verified')
    expect((await verifyClaim(deps, run, { ...claim, location: 'server.mjs:100' })).outcome).toBe('code_missing')
  })

  it('preserves JSON reproduction headers through proposal and host replay', async () => {
    const h = await setup(); const { run, tools } = h.makeTools()
    h.store.setAppUrl(run.id, 'http://127.0.0.1:43210')
    const input = { title: 'Quantity validation', detail: 'Negative quantities must return 422.', category: 'input_validation', severity: 'medium', severity_rationale: 'Incorrect totals', suggested_fix: 'Reject nonpositive quantities', reproduction: { steps: [{ method: 'POST', path: '/cart', headers: { 'content-type': 'application/json' }, body: '{"quantity":-1}' }], check: { kind: 'status_equals', expected: 422 } } }
    expect((await tools.call('json', 'propose_claim', input)).ok).toBe(true)
    const claim = h.store.listClaims(run.id)[0]
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init!.headers).toMatchObject({ 'content-type': 'application/json' })
      expect(init!.body).toBe('{"quantity":-1}')
      return new Response('{"total":-60}', { status: 200 })
    }) as unknown as typeof fetch
    expect((await verifyClaim({ store: h.store, evidence: h.evidence, signal: new AbortController().signal, fetchImpl }, run, claim)).outcome).toBe('reproduced')
    for (const [id, step] of Object.entries({ foreign: { method: 'GET', path: '//other.example/cart' }, credential: { method: 'POST', path: '/cart', headers: { Authorization: 'secret' } }, getBody: { method: 'GET', path: '/cart', body: '{}' } })) {
      const result = await tools.call(id, 'propose_claim', { ...input, reproduction: { ...input.reproduction, steps: [step] } })
      expect(result.ok, id).toBe(false)
    }
  })

  it('does not mistake assertion words in a network error for a failing regression assertion', async () => {
    const h = await setup(); const { run, lease, controller } = h.makeTools()
    h.store.setAppUrl(run.id, 'http://127.0.0.1:43210')
    const claim = h.store.proposeClaim(lease, { title: 'ERR_ASSERTION in an untrusted claim title', detail: 'A connectivity error is not defect evidence.', category: 'api_contract', severity: 'medium', severityRationale: 'Check did not execute', area: 'black', location: null, evidenceQuote: null, reproduction: { steps: [{ method: 'GET', path: '/never-reached' }], check: { kind: 'status_equals', expected: 200 } }, suggestedFix: null }, 10)
    const failingFetch = join(h.dir, 'failing-fetch.mjs')
    writeFileSync(failingFetch, "globalThis.fetch = async () => { throw new Error('ERR_ASSERTION: misleading network failure') }")
    const result = await writeRegressionTest({ store: h.store, evidence: h.evidence, signal: controller.signal, runDir: join(h.dir, 'regression-run'), node: { command: process.execPath, env: { NODE_OPTIONS: `--import=${resolve(failingFetch)}` } } }, run, claim)
    expect(result).toMatchObject({ failsNow: false, execution: 'error' })
  })

  it('detects tampered evidence by hash', async () => {
    const h = await setup(); const hash = h.evidence.put(new TextEncoder().encode('original'))
    expect(h.evidence.get(hash).toString()).toBe('original')
    // Evidence uses content-addressed paths; find the stored blob without assuming layout.
    const { readdirSync } = await import('node:fs')
    const find = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? find(join(dir, e.name)) : [join(dir, e.name)])
    writeFileSync(find(join(h.dir, 'evidence'))[0], 'tampered')
    expect(() => h.evidence.get(hash)).toThrow(/integrity|hash/i)
  })

  it('requires meaningful run settings and configured accounts', async () => {
    const h = await setup()
    expect(() => h.store.startRun(h.startInput({ audit: { ...DEFAULT_AUDIT, focus: [] } }))).toThrow(/focus/)
    expect(() => h.store.startRun(h.startInput({ audit: { ...DEFAULT_AUDIT, accounts: ['missing'] } }))).toThrow(/not set up/)
    expect(() => h.store.startRun(h.startInput({ externalUrl: 'https://user:password@example.com' }))).toThrow(/credentials/)
  })
})

describe('imports, questionnaire, and knowledge', () => {
  it('imports ZIPs without executing source and rejects traversal', async () => {
    const h = await setup()
    const imported = h.importer.importZip('hello.zip', zipSync({ 'hello/package.json': strToU8('{"scripts":{"start":"node server.js"}}'), 'hello/server.js': strToU8('throw new Error("must not execute during import")') }))
    expect(imported.latestSnapshot!.fileCount).toBe(2)
    expect(() => h.importer.importZip('bad.zip', zipSync({ '../escape': strToU8('bad') }))).toThrow(/escapes/)
    expect(() => parseGithubUrl('https://example.com/user/repo')).toThrow()
  })

  it('defaults imported projects to source-only and the sample to approved local testing', async () => {
    const h = await setup(); const stack = h.target.latestSnapshot!.stack
    const external = buildQuestionnaire({ stack, accounts: ['alice'], trusted: false, knowledgeDocs: 0 })
    expect(setupFromAnswers(external.defaults)).toMatchObject({ mode: 'white', allowCommands: false })
    const sample = buildQuestionnaire({ stack, accounts: ['alice', 'bob'], trusted: true, knowledgeDocs: 120 })
    expect(setupFromAnswers(sample.defaults)).toMatchObject({ mode: 'both', allowCommands: true, audit: { accounts: ['alice', 'bob'], useKnowledge: true } })
  })

  it('ranks relevant background and retains source attribution', () => {
    const kb = new KnowledgeBase([
      { id: 'a', title: 'Object ownership', source: 'Test CTF', topic: 'authorization', url: 'https://example.com/a', summary: 'Check object ownership', path: 'a.md', text: 'Authorization checks prevent users accessing another account’s orders.' },
      { id: 'b', title: 'RSA', source: 'Test CTF', topic: 'crypto', url: null, summary: 'Prime factorization', path: 'b.md', text: 'RSA uses large prime factors.' },
    ])
    expect(kb.search('authorization ownership orders')[0]).toMatchObject({ title: 'Object ownership', url: 'https://example.com/a' })
  })

  it('never treats shell operators as command arguments', () => {
    expect(tokenize('node "server file.mjs"')).toEqual(['node', 'server file.mjs'])
    expect(() => tokenize('npm start && curl example.com')).toThrow()
    expect(() => tokenize('node $(whoami)')).toThrow()
  })

  it('restricts sign-in links to the expected provider', () => {
    expect(allowedLoginUrl('https://auth.openai.com/device', 'codex')).toContain('auth.openai.com')
    expect(allowedLoginUrl('https://auth.openai.com.evil.example/device', 'codex')).toBeNull()
    expect(allowedLoginUrl('file:///etc/hosts', 'claude')).toBeNull()
    expect(allowedLoginUrl('https://claude.ai/oauth/authorize', 'claude')).toContain('claude.ai')
  })
})
