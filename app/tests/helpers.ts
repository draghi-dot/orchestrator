import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProfile } from '../src/shared/domain'
import type { AgentAdapter } from '../src/main/adapters/types'
import { ScriptedAgent } from '../src/main/adapters/scripted'
import { openDatabase } from '../src/main/db'
import { type DemoApp, startDemoApp } from '../src/main/demo-app'
import { EvidenceStore } from '../src/main/evidence'
import { Orchestrator } from '../src/main/orchestrator'
import { DEMO_IDS, seedDemo } from '../src/main/seed'
import { QaStore, type StartRunInput } from '../src/main/store'

export interface Harness {
  store: QaStore
  evidence: EvidenceStore
  orchestrator: Orchestrator
  demo: DemoApp
  dir: string
  suiteVersionId: string
  startInput(overrides?: Partial<StartRunInput>): StartRunInput
  close(): Promise<void>
}

export const SCRIPTED: AgentProfile = { adapter: 'scripted', model: '', builtinTools: [] }

export async function makeHarness(
  options: { adapter?: (profile: AgentProfile) => AgentAdapter; cancelGraceMs?: number; heartbeatMs?: number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'kestrel-qa-test-'))
  const store = new QaStore(openDatabase(':memory:'))
  const evidence = new EvidenceStore(join(dir, 'evidence'))
  const demo = await startDemoApp(0)
  seedDemo(store, demo.origin)
  const orchestrator = new Orchestrator({
    store,
    evidence,
    adapters: options.adapter ?? (() => new ScriptedAgent()),
    workerId: 'worker-test',
    cancelGraceMs: options.cancelGraceMs ?? 300,
    heartbeatMs: options.heartbeatMs ?? 60_000,
  })
  const suiteVersionId = store.listSuiteVersions(DEMO_IDS.suite)[0].id
  let n = 0
  return {
    store,
    evidence,
    orchestrator,
    demo,
    dir,
    suiteVersionId,
    startInput: (overrides = {}) => ({
      idempotencyKey: `key-${++n}`,
      suiteVersionId,
      environmentId: DEMO_IDS.environment,
      buildRevision: 'build-123',
      agent: SCRIPTED,
      initiator: 'tester',
      ...overrides,
    }),
    close: async () => {
      await orchestrator.shutdown()
      await demo.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const eventTypes = (store: QaStore, runId: string): string[] => store.catchUp(0, runId).events.map((e) => e.type)
