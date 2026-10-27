/**
 * The host's own evidence check for a finding (the "judge" inputs in build
 * plan section 08). Nothing here asks an agent anything:
 *
 *  - a reproduction is replayed request by request against the app, and the
 *    last response is checked against what the finding says a correct app
 *    returns;
 *  - a code finding's quoted lines are looked up at the cited location in
 *    the immutable snapshot;
 *  - a confirmed finding with a reproduction becomes a runnable regression
 *    test, which is run once to show it fails on this build.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import type { Claim, EvidenceOutcome, Run } from '../shared/domain'
import { bounded } from '../shared/events'
import { evaluateCheck, normalizeCode } from '../shared/verdict'
import type { EvidenceStore } from './evidence'
import type { QaStore } from './store'
import { type AccountHeader, performHttp } from './tools'

export interface VerifyDeps {
  store: QaStore
  evidence: EvidenceStore
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

export interface VerifyResult {
  outcome: EvidenceOutcome
  expected: string | null
  actual: string | null
  detail: string
  artifactId: string | null
}

function appTargets(store: QaStore, run: Run) {
  const local = store.getRun(run.id).appUrl
  const external = run.contract.externalUrl
  return { base: local ?? external, local: local ? new URL(local).origin : null, external }
}

function accountFor(store: QaStore, run: Run, name: string | undefined): AccountHeader | null {
  if (!name) return null
  if (!run.contract.audit.accounts.includes(name)) throw new Error(`${name} is not an approved test account`)
  const header = store.testAccountHeader(run.contract.targetId, name)
  if (!header) throw new Error(`${name} has no credentials set up`)
  return { account: name, name: header.name, value: header.value }
}

export async function verifyClaim(deps: VerifyDeps, run: Run, claim: Claim): Promise<VerifyResult> {
  if (claim.reproduction) return replay(deps, run, claim)
  if (claim.evidenceQuote && claim.location) return checkQuote(deps.store, run, claim)
  return { outcome: 'no_evidence', expected: null, actual: null, detail: 'The finding has no reproduction or code quote to check.', artifactId: null }
}

async function replay(deps: VerifyDeps, run: Run, claim: Claim): Promise<VerifyResult> {
  const repro = claim.reproduction!
  const targets = appTargets(deps.store, run)
  if (!targets.base) return { outcome: 'error', expected: null, actual: null, detail: 'No app was running to replay against.', artifactId: null }
  let last: { status: number; bodyText: string; artifactId: string } | null = null
  try {
    for (const step of repro.steps) {
      const result = await performHttp(
        { store: deps.store, evidence: deps.evidence, fetchImpl: deps.fetchImpl, signal: deps.signal, runId: run.id, lease: null, ...targets },
        { method: step.method, path: step.path, body: step.body, account: accountFor(deps.store, run, step.as) },
      )
      last = { status: result.status, bodyText: result.bodyText, artifactId: result.artifactId }
    }
  } catch (err) {
    return { outcome: 'error', expected: null, actual: null, detail: `Replay failed: ${bounded(err instanceof Error ? err.message : String(err), 300)}`, artifactId: last?.artifactId ?? null }
  }
  const result = evaluateCheck(repro.check, last!)
  return result.passed
    ? { outcome: 'not_reproduced', expected: result.expected, actual: result.actual, detail: `The app returned ${result.actual}, which is what a correct app returns.`, artifactId: last!.artifactId }
    : { outcome: 'reproduced', expected: result.expected, actual: result.actual, detail: `Expected ${result.expected}, got ${result.actual}.`, artifactId: last!.artifactId }
}

/** Parse "path/to/file.js:12" or "path/to/file.js:12-18". */
export function parseLocation(location: string): { file: string; line: number | null } | null {
  const m = /^(.+?)(?::(\d+)(?:-\d+)?)?$/.exec(location.trim())
  if (!m || /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.test(location.trim())) return null
  return { file: m[1].replace(/^\.?\/+/, ''), line: m[2] ? Number(m[2]) : null }
}

function checkQuote(store: QaStore, run: Run, claim: Claim): VerifyResult {
  const loc = parseLocation(claim.location ?? '')
  const quote = normalizeCode(claim.evidenceQuote ?? '')
  if (!loc || !quote) return { outcome: 'no_evidence', expected: null, actual: null, detail: 'The location is not a file:line.', artifactId: null }
  const root = store.getSnapshot(run.contract.snapshotId).rootPath
  const abs = normalize(join(root, loc.file))
  if (!abs.startsWith(root + sep) || !existsSync(abs)) {
    return { outcome: 'code_missing', expected: `quoted code in ${loc.file}`, actual: `${loc.file} does not exist in the snapshot`, detail: 'The cited file is not in the app.', artifactId: null }
  }
  const lines = readFileSync(abs, 'utf8').split('\n')
  const near = (from: number, to: number) => normalizeCode(lines.slice(Math.max(0, from), Math.min(lines.length, to)).join('\n'))
  if (loc.line !== null && near(loc.line - 6, loc.line + 6 + claim.evidenceQuote!.split('\n').length).includes(quote)) {
    return { outcome: 'code_verified', expected: 'quoted code at the cited line', actual: `found at ${loc.file}:${loc.line}`, detail: 'The quoted code is at the cited location.', artifactId: null }
  }
  if (normalizeCode(lines.join('\n')).includes(quote)) {
    const at = lines.findIndex((l) => normalizeCode(l) !== '' && quote.startsWith(normalizeCode(l)))
    return {
      outcome: 'code_verified',
      expected: 'quoted code at the cited line',
      actual: `found in ${loc.file}${at >= 0 ? ` at line ${at + 1}` : ''}, not at line ${loc.line ?? '?'}`,
      detail: 'The quoted code exists in the cited file, a few lines from the cited place.',
      artifactId: null,
    }
  }
  return { outcome: 'code_missing', expected: 'quoted code in the cited file', actual: `not found in ${loc.file}`, detail: 'The quoted code is not in the cited file.', artifactId: null }
}

// ------------------------------------------------------------ regression tests

const lit = (v: unknown) => JSON.stringify(v)
const accountKey = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/** A self-contained node:test file that fails while the defect exists. All
 * values from the finding are embedded as JSON literals, never as code. */
export function regressionTestSource(claim: Claim, appUrl: string): string {
  const repro = claim.reproduction!
  const title = claim.title.replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /')
  const steps = repro.steps
    .map((step) => {
      const headers = step.as ? `account(${lit(step.as)})` : '{}'
      const body = step.body !== undefined ? `, body: ${lit(step.body)}` : ''
      return `  res = await fetch(new URL(${lit(step.path)}, BASE), { method: ${lit(step.method)}, headers: ${headers}${body}, redirect: 'manual' })`
    })
    .join('\n')
  const check = repro.check
  const assertion =
    check.kind === 'status_equals'
      ? `  assert.equal(res.status, ${lit(Number(check.expected))})`
      : check.kind === 'body_contains'
        ? `  const text = await res.text()\n  assert.ok(text.includes(${lit(String(check.expected))}), 'response should contain ' + ${lit(String(check.expected))})`
        : `  const json = JSON.parse(await res.text())\n  const value = ${lit((check.path ?? '').split('.').filter(Boolean))}.reduce((v, k) => (v == null ? v : v[k]), json)\n  assert.deepEqual(value, ${lit(check.expected)})`
  return `// Regression test for: ${title}
// Finding ${claim.id}, generated by QA Arena. It fails while the defect exists
// and passes once it is fixed.
// Run against a running copy of the app:
//   APP_URL=${appUrl} node --test ${claim.id}.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BASE = process.env.APP_URL ?? ${lit(appUrl)}

function account(name) {
  const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const header = process.env['QA_ACCOUNT_' + key + '_HEADER']
  const value = process.env['QA_ACCOUNT_' + key + '_VALUE']
  if (!header || !value) throw new Error('Set QA_ACCOUNT_' + key + '_HEADER and QA_ACCOUNT_' + key + '_VALUE to run this test as ' + name)
  return { [header]: value }
}

test(${lit(claim.title)}, async () => {
  let res
${steps}
${assertion}
})
`
}

export interface NodeRunner {
  command: string
  env: Record<string, string>
}

/** Write the regression test, run it once against the app, save both. */
export async function writeRegressionTest(
  deps: VerifyDeps & { runDir: string; node: NodeRunner },
  run: Run,
  claim: Claim,
): Promise<{ artifactId: string; failsNow: boolean } | null> {
  if (!claim.reproduction) return null
  const appUrl = appTargets(deps.store, run).base
  if (!appUrl) return null
  const source = regressionTestSource(claim, appUrl)
  const dir = join(deps.runDir, 'regression')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${claim.id}.test.mjs`)
  writeFileSync(file, source)

  const env: Record<string, string> = { ...deps.node.env, APP_URL: appUrl, PATH: process.env.PATH ?? '', NO_COLOR: '1' }
  for (const step of claim.reproduction.steps) {
    if (!step.as) continue
    const header = accountFor(deps.store, run, step.as)
    if (header) {
      env[`QA_ACCOUNT_${accountKey(step.as)}_HEADER`] = header.name
      env[`QA_ACCOUNT_${accountKey(step.as)}_VALUE`] = header.value
    }
  }
  const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
    let out = ''
    const child = spawn(deps.node.command, ['--test', file], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-8000)))
    child.stderr.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-8000)))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, output: err.message })
    })
    child.on('close', (c) => {
      clearTimeout(timer)
      resolve({ code: c, output: out })
    })
  })
  // Credentials were passed by environment only; keep them out of the log.
  let log = output
  for (const [k, v] of Object.entries(env)) if (k.endsWith('_VALUE') && v) log = log.split(v).join('[redacted]')
  const failsNow = code !== 0
  const text = `${source}\n// ---- run on ${new Date().toISOString()} against ${appUrl}: ${failsNow ? 'FAILS (defect present)' : 'PASSES'} (exit ${code})\n/*\n${log.replace(/\*\//g, '* /')}\n*/\n`
  const bytes = new TextEncoder().encode(text)
  const artifact = deps.store.recordArtifact(run.id, null, {
    sha256: deps.evidence.put(bytes),
    mime: 'text/javascript; charset=utf-8',
    bytes: bytes.byteLength,
    label: `Regression test for ${claim.id}`,
    redaction: 'none',
  })
  deps.store.setRegressionTest(claim.id, artifact.id, failsNow)
  return { artifactId: artifact.id, failsNow }
}
