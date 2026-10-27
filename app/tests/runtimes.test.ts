import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { ClaudeRuntime, claudeArgs } from '../src/main/runtimes/claude'
import { CodexRuntime, codexArgs } from '../src/main/runtimes/codex'
import { OmpRuntime } from '../src/main/runtimes/omp'
import type { Assignment, RuntimeContext } from '../src/main/runtimes/types'
import { makeHarness, type Harness } from './helpers'
const fixtures: Harness[] = []
afterEach(async () => { for (const h of fixtures.splice(0)) await h.close() })
async function context() {
  const h = await makeHarness(); fixtures.push(h)
  const { tools, run, controller } = h.makeTools()
  const a: Assignment = { taskId: tools.lease.taskId, runId: run.id, role: 'researcher', phase: 'research', mode: 'white', model: '', systemPrompt: 'Use QA tools.', prompt: 'Inspect the fixture.', deadlineSeconds: 5, context: { targetName: 'fixture', stack: h.target.latestSnapshot!.stack, appUrl: null, finalReport: false } }
  const ctx: RuntimeContext = { tools, signal: controller.signal, checkpoint: async () => {}, scratchDir: h.dir, bridge: { command: process.execPath, args: ['bridge.cjs'], env: { QA_GATEWAY_TOKEN: 'fixture-only' } } }
  return { a, ctx, controller }
}
const options = (kind: string, scenario: string) => ({ command: process.execPath, argsPrefix: [resolve('tests/fixtures/fake-runtime.mjs')], env: { ...process.env, QA_FAKE_KIND: kind, QA_FAKE_SCENARIO: scenario }, killGraceMs: 10 })
describe('runtime protocol boundaries', () => {
  for (const [name, Runtime] of [['claude', ClaudeRuntime], ['codex', CodexRuntime], ['omp', OmpRuntime]] as const) {
    it(`${name}: recognizes its completion frame`, async () => {
      const { a, ctx } = await context()
      expect((await new Runtime(options(name, 'success')).execute(a, ctx)).kind).toBe('finished')
    })
    it(`${name}: preserves worker errors`, async () => {
      const { a, ctx } = await context()
      expect((await new Runtime(options(name, 'failure')).execute(a, ctx)).kind).toBe('error')
    })
    it(`${name}: cancels a process that does not finish`, async () => {
      const { a, ctx, controller } = await context()
      const result = new Runtime(options(name, 'hang')).execute(a, ctx)
      setTimeout(() => controller.abort('test cancellation'), 30)
      expect((await result).kind).toBe('cancelled')
    })
  }
  for (const [name, Runtime] of [['claude', ClaudeRuntime], ['codex', CodexRuntime]] as const) {
    it.each(['empty', 'malformed', 'nonzero'])(`${name}: refuses %s output as success`, async (scenario) => {
      const { a, ctx } = await context()
      expect((await new Runtime(options(name, scenario)).execute(a, ctx)).kind).toBe('error')
    })
  }
  it('Codex reports an error when every QA tool call was refused', async () => {
    const { a, ctx } = await context()
    const outcome = await new CodexRuntime(options('codex', 'tools-refused')).execute(a, ctx)
    expect(outcome.kind).toBe('error')
    expect(outcome.reason).toContain('could not use the QA tools')
  })
  it('lets Codex call QA tools without an approval prompt', async () => {
    const { a, ctx } = await context()
    expect(codexArgs(a, ctx)).toContain('mcp_servers.qa.default_tools_approval_mode="approve"')
  })
  it('Claude refuses a disconnected QA tool bridge', async () => {
    const { a, ctx } = await context()
    expect((await new ClaudeRuntime(options('claude', 'bridge-error')).execute(a, ctx)).kind).toBe('error')
  })
  it('keeps command tools disabled and confines the configured MCP surface', async () => {
    const { a, ctx } = await context()
    expect(claudeArgs(a, ctx)).toContain('--strict-mcp-config')
    expect(claudeArgs(a, ctx)).toContain('--restricted')
    expect(codexArgs(a, ctx)).toContain('features.shell_tool=false')
    expect(codexArgs(a, ctx)).toContain('--ignore-user-config')
    expect(codexArgs(a, ctx)).toContain('read-only')
  })
})
