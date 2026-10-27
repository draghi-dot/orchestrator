import { createInterface } from 'node:readline'
const kind = process.env.QA_FAKE_KIND
const scenario = process.env.QA_FAKE_SCENARIO ?? 'success'
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
if (scenario === 'hang') setInterval(() => {}, 1000)
else if (kind === 'omp') {
  emit({ type: 'ready' })
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line)
    if (m.type === 'set_host_tools') emit({ type: 'response', id: m.id, success: true })
    if (m.type === 'prompt') {
      emit({ type: 'response', id: m.id, success: true })
      emit({ type: 'prompt_result', id: m.id, status: scenario === 'success' ? 'completed' : 'error', error: { message: 'fixture failure' } })
    }
    if (m.type === 'get_session_stats') emit({ type: 'response', id: m.id, success: true, data: { turns: 1 } })
  })
} else {
  process.stdin.resume()
  process.stdin.on('end', () => {
    if (scenario === 'empty') return
    if (scenario === 'malformed') { process.stdout.write('not-json\nnull\n'); return }
    if (kind === 'claude') {
      emit({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'qa', status: scenario === 'bridge-error' ? 'failed' : 'connected' }] })
      emit({ type: 'result', subtype: scenario === 'failure' ? 'error' : 'success', is_error: scenario === 'failure', result: 'fixture result' })
    } else {
      emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Fixture worker finished.' } })
      emit(scenario === 'failure' ? { type: 'turn.failed', error: { message: 'fixture failure' } } : { type: 'turn.completed', usage: { input_tokens: 1 } })
    }
    if (scenario === 'nonzero') process.exitCode = 1
  })
}
