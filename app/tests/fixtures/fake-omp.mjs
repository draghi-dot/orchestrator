#!/usr/bin/env node
// A stand-in for `omp --mode rpc` that speaks the documented NDJSON frames
// (ready, response, host_tool_call, message_end, agent_end, prompt_result).
// FAKE_OMP_MODE selects behavior: ok | malformed | crash | error | hang | blocked.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'

const mode = process.env.FAKE_OMP_MODE ?? 'ok'
if (process.env.FAKE_OMP_ARGV_FILE) writeFileSync(process.env.FAKE_OMP_ARGV_FILE, JSON.stringify(process.argv.slice(2)))

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const pending = new Map()
let hostSeq = 0

function hostCall(toolName, args) {
  const id = `host_${++hostSeq}`
  return new Promise((resolve) => {
    pending.set(id, resolve)
    out({ type: 'host_tool_call', id, toolCallId: `toolu_${hostSeq}`, toolName, arguments: args })
  })
}

async function runPrompt(id, message) {
  if (mode === 'malformed') {
    process.stdout.write('this is not json\n{"half": \n')
    process.exit(0)
  }
  if (mode === 'crash') {
    process.stderr.write('segfault-ish failure\n')
    process.exit(3)
  }
  if (mode === 'hang') return
  out({ type: 'agent_start' })
  if (mode === 'error') {
    out({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
    out({ type: 'prompt_result', id, agentInvoked: true, status: 'error', error: { message: '429 rate limited', retryable: true }, sessionSettled: true })
    return
  }
  const brief = JSON.parse(message.slice(message.indexOf('{')))
  if (mode === 'blocked') {
    await hostCall('qa_report_blocked', { reason: 'login wall not described in the case' })
  } else {
    for (const step of brief.case.steps) {
      await hostCall('qa_step', { step_id: step.step_id, status: 'started' })
      const hint = step.request_hint ?? { method: 'GET', url: '/' }
      await hostCall('qa_http_request', { step_id: step.step_id, method: hint.method, url: hint.url })
      await hostCall('qa_step', { step_id: step.step_id, status: 'finished' })
    }
  }
  out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'I think every check passed.' }] } })
  out({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
  out({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true })
  out({ type: 'session_settled' })
}

out({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 })

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const frame = JSON.parse(line)
  if (frame.type === 'host_tool_result') {
    pending.get(frame.id)?.(frame)
    pending.delete(frame.id)
    return
  }
  switch (frame.type) {
    case 'set_host_tools':
      out({ id: frame.id, type: 'response', command: 'set_host_tools', success: true, data: { toolNames: frame.tools.map((t) => t.name) } })
      break
    case 'prompt':
      out({ id: frame.id, type: 'response', command: 'prompt', success: true })
      void runPrompt(frame.id, frame.message)
      break
    case 'get_session_stats':
      out({ id: frame.id, type: 'response', command: 'get_session_stats', success: true, data: { tokens: { input: 1200, output: 340 } } })
      break
    case 'abort':
      out({ id: frame.id, type: 'response', command: 'abort', success: true })
      break
    default:
      out({ id: frame.id, type: 'response', command: frame.type, success: false, error: 'unknown command' })
  }
})
rl.on('close', () => process.exit(0))
