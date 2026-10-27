import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { OmpAgent } from '../src/main/adapters/omp'
import type { AgentProfile } from '../src/shared/domain'
import { type Harness, eventTypes, makeHarness, waitFor } from './helpers'

const FAKE_OMP = fileURLToPath(new URL('./fixtures/fake-omp.mjs', import.meta.url))
const OMP_PROFILE: AgentProfile = { adapter: 'omp', model: 'fake-model', builtinTools: [] }

let h: Harness
afterEach(async () => h?.close())

async function harnessFor(mode: string, extraEnv: Record<string, string> = {}) {
  h = await makeHarness({
    adapter: () =>
      new OmpAgent({
        command: process.execPath,
        argsPrefix: [FAKE_OMP],
        cwd: h.dir,
        env: { ...process.env, FAKE_OMP_MODE: mode, ...extraEnv },
        killGraceMs: 200,
      }),
  })
  return h
}

describe('oh-my-pi RPC adapter', () => {
  it('drives the case through QA host tools and code decides the verdict', async () => {
    const argvFile = join(tmpdir(), `fake-omp-argv-${process.pid}.json`)
    await harnessFor('ok', { FAKE_OMP_ARGV_FILE: argvFile })
    const { run } = h.orchestrator.start(h.startInput({ agent: OMP_PROFILE }))
    await h.orchestrator.idle()

    const final = h.store.getRun(run.id)
    expect(final.state).toBe('completed')
    // Same planted defect, found through the model adapter path.
    expect(final.summary).toMatchObject({ passed: 3, failed: 1, error: 0 })
    const types = eventTypes(h.store, run.id)
    expect(types).toContain('agent_message')
    expect(types).toContain('artifact_saved')

    const argv: string[] = JSON.parse(readFileSync(argvFile, 'utf8'))
    expect(argv).toEqual(expect.arrayContaining(['--mode', 'rpc', '--no-session', '--no-tools', '--model', 'fake-model']))

    const attempt = h.store.listAttempts(run.id)[0]
    const finished = h.store.catchUp(0, run.id).events.find((e) => e.type === 'attempt_finished' && e.attemptId === attempt.id)!
    expect(finished.payload.usage).toEqual({ tokens: { input: 1200, output: 340 } })
  })

  it.each([
    ['malformed', 'without a prompt result'],
    ['crash', 'code 3'],
    ['error', '429 rate limited'],
  ])('records %s output as an error, never a pass', async (mode, reasonFragment) => {
    await harnessFor(mode)
    const { run } = h.orchestrator.start(h.startInput({ agent: OMP_PROFILE, caseIds: ['checkout-discount-10'] }))
    await h.orchestrator.idle()
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('error')
    expect(attempt.terminalReason).toContain(reasonFragment)
    expect(h.store.listAssertionResults(attempt.id)).toHaveLength(0)
  })

  it('maps qa_report_blocked to a blocked attempt', async () => {
    await harnessFor('blocked')
    const { run } = h.orchestrator.start(h.startInput({ agent: OMP_PROFILE, caseIds: ['checkout-discount-10'] }))
    await h.orchestrator.idle()
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('blocked')
    expect(attempt.terminalReason).toContain('login wall')
  })

  it('cancels a hung agent process', async () => {
    await harnessFor('hang')
    const { run } = h.orchestrator.start(h.startInput({ agent: OMP_PROFILE }))
    await waitFor(() => eventTypes(h.store, run.id).includes('attempt_started'))
    await new Promise((r) => setTimeout(r, 100))
    h.orchestrator.requestCancel(run.id, 'operator')
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('cancelled')
    expect(h.store.listAttempts(run.id)[0].status).toBe('cancelled')
  })
})
