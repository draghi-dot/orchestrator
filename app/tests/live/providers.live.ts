/** Explicit opt-in: uses installed, signed-in provider CLIs and may consume model usage. */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ToolGateway } from '../../src/main/gateway'
import { ClaudeRuntime } from '../../src/main/runtimes/claude'
import { CodexRuntime } from '../../src/main/runtimes/codex'
import type { Assignment } from '../../src/main/runtimes/types'
import { resolveCommand } from '../../src/main/settings'
import { makeHarness } from '../helpers'
for (const [name, Runtime] of [['claude', ClaudeRuntime], ['codex', CodexRuntime]] as const) {
  it(`${name} connects the real MCP bridge and records a host tool call`, async () => {
    const h = await makeHarness(); const gateway = new ToolGateway()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await gateway.start()
      const { tools, run, controller } = h.makeTools('researcher', { mode: 'white', allowCommands: false })
      const token = gateway.register(tools)
      const scratchDir = join(h.dir, 'worker'); mkdirSync(scratchDir)
      const executable = resolveCommand(name)
      expect(executable, `${name} must be installed and signed in`).not.toBeNull()
      const a: Assignment = { taskId: tools.lease.taskId, runId: run.id, role: 'researcher', phase: 'research', mode: 'white', model: '', systemPrompt: 'Use the supplied QA tools only. This is a tool connectivity check.', prompt: 'Call the QA note tool once with text QA_LIVE_BRIDGE_OK. Then finish. Do not inspect any files or do other work.', deadlineSeconds: 45, context: { targetName: 'connectivity check', stack: h.target.latestSnapshot!.stack, appUrl: null, finalReport: false } }
      timer = setTimeout(() => controller.abort('Live connectivity check timed out'), 45_000)
      const outcome = await new Runtime({ command: executable! }).execute(a, { tools, signal: controller.signal, checkpoint: async () => {}, scratchDir,
        bridge: { command: process.execPath, args: [resolve('resources/qa-mcp-bridge.cjs')], env: { QA_GATEWAY_URL: gateway.url, QA_GATEWAY_TOKEN: token } },
      })
      expect(outcome.kind, outcome.reason).toBe('finished')
      const events = h.store.catchUp(0, run.id).events
      expect(events.some((e) => e.type === 'tool_called' && e.payload.tool === 'note')).toBe(true)
      expect(events.some((e) => e.type === 'agent_message' && e.payload.text === 'QA_LIVE_BRIDGE_OK')).toBe(true)
    } finally { if (timer) clearTimeout(timer); await gateway.stop(); await h.close() }
  })
}
