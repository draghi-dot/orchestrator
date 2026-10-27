import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDatabase } from '../src/main/db'
import { EvidenceStore } from '../src/main/evidence'
import { Importer } from '../src/main/importer'
import { Orchestrator } from '../src/main/orchestrator'
import { ProcessManager } from '../src/main/processes'
import { OfflineRuntime } from '../src/main/runtimes/offline'
import type { AgentRuntime } from '../src/main/runtimes/types'
import { seedArena } from '../src/main/seed'
import { OFFLINE_ROSTER } from '../src/main/settings'
import { QaStore, type StartRunInput } from '../src/main/store'
import { TaskTools } from '../src/main/tools'
import { DEFAULT_AUDIT } from '../src/shared/domain'
import type { Role, WorkerProfile } from '../src/shared/domain'

export async function makeHarness(options: { runtimes?: (p: WorkerProfile) => AgentRuntime; grace?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qa-arena-test-'))
  const store = new QaStore(openDatabase(':memory:'))
  const evidence = new EvidenceStore(join(dir, 'evidence'))
  const importer = new Importer(store, join(dir, 'snapshots'))
  const target = seedArena(store, importer, resolve('resources/sample-shop'))
  const isolated = process.env.QA_TEST_NO_TCP === '1'
  const testEnv: Record<string, string> = isolated ? {
    NODE_OPTIONS: `--import=${resolve('tests/fixtures/sample-fetch.mjs')}`,
    QA_TEST_SHOP_PATH: join(target.latestSnapshot!.rootPath, 'server.mjs'),
    QA_SAMPLE_ALICE: store.testAccountHeader(target.id, 'alice')!.value,
    QA_SAMPLE_BOB: store.testAccountHeader(target.id, 'bob')!.value,
  } : {}
  let fetchImpl: typeof fetch | undefined
  class InProcessManager extends ProcessManager {
    private readonly ready = new Map<string, string>()
    override async startApp(key: string, command: string, cwd: string, options: Parameters<ProcessManager['startApp']>[3]) {
      // This executes the same app handler the real server uses, with an in-memory transport.
      const module = await import(resolve('tests/fixtures/sample-fetch.mjs'))
      fetchImpl = await module.makeShopFetch(join(cwd, 'server.mjs'), { alice: options.env?.QA_SAMPLE_ALICE, bob: options.env?.QA_SAMPLE_BOB })
      const url = 'http://127.0.0.1:43210'
      this.ready.set(key, url)
      return { url, pid: undefined, log: 'In-process test transport' }
    }
    override appFor(key: string) { const url = this.ready.get(key); return url ? { url, command: 'node server.mjs' } : null }
    override async stopApp(key: string) { const url = this.ready.get(key) ?? null; this.ready.delete(key); return url }
    override async stopAll() { this.ready.clear() }
  }
  const processes = isolated ? new InProcessManager() : new ProcessManager()
  const orchestrator = new Orchestrator({ store, evidence, processes, runRoot: join(dir, 'runs'),
    runtimes: options.runtimes ?? (() => new OfflineRuntime()),
    ...(isolated ? { fetchImpl: ((...args: Parameters<typeof fetch>) => fetchImpl!(...args)) as typeof fetch, node: { command: process.execPath, env: testEnv } } : {}),
    cancelGraceMs: options.grace ?? 30, heartbeatMs: 50,
  })
  let n = 0
  const startInput = (overrides: Partial<StartRunInput> = {}): StartRunInput => ({
    idempotencyKey: `test-${++n}`, targetId: target.id, mode: 'both', externalUrl: null, allowCommands: true,
    audit: { ...structuredClone(DEFAULT_AUDIT), accounts: ['alice', 'bob'] }, roster: structuredClone(OFFLINE_ROSTER), initiator: 'test', ...overrides,
  })
  const makeTools = (role: Role = 'researcher', overrides: Partial<StartRunInput> = {}, fetchImpl?: typeof fetch) => {
    const run = store.startRun(startInput(overrides)).run
    store.transitionRun(run.id, 'start', 'run_started')
    const lease = store.createTask(run.id, role, role === 'researcher' ? 'research' : role === 'thinker' ? 'challenge' : role === 'builder' ? 'build' : role === 'reporter' ? 'report' : 'improve', 0, 'offline', 'test')
    const controller = new AbortController()
    const tools = new TaskTools({ store, evidence, processes, run, lease, snapshotRoot: target.latestSnapshot!.rootPath,
      workdir: null, dna: store.currentDna(), signal: controller.signal, fetchImpl,
    })
    return { run, tools, lease, controller }
  }
  return { dir, store, evidence, importer, target, processes, orchestrator, startInput, makeTools, testEnv,
    close: async () => { await orchestrator.shutdown(); store.db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}
export type Harness = Awaited<ReturnType<typeof makeHarness>>
export async function waitFor(predicate: () => boolean, timeoutMs = 6000) {
  const start = Date.now()
  while (!predicate()) { if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition'); await new Promise((r) => setTimeout(r, 10)) }
}
