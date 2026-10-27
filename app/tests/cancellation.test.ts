import { afterEach, describe, expect, it } from 'vitest'
import { ScriptedAgent } from '../src/main/adapters/scripted'
import type { AgentAdapter } from '../src/main/adapters/types'
import { StaleOwnershipError } from '../src/main/store'
import { type Harness, eventTypes, makeHarness, waitFor } from './helpers'

let h: Harness
afterEach(async () => h?.close())

describe('cancellation', () => {
  it('cancels a queued run without starting it', async () => {
    h = await makeHarness()
    const { run } = h.store.startRun(h.startInput())
    h.orchestrator.requestCancel(run.id, 'operator')
    h.orchestrator.kick()
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('cancelled')
    expect(h.store.listAttempts(run.id)).toHaveLength(0)
  })

  it('stops gracefully at the next boundary and records a durable result', async () => {
    h = await makeHarness({ adapter: () => new ScriptedAgent({ stepDelayMs: 200 }) })
    const { run } = h.orchestrator.start(h.startInput())
    await waitFor(() => eventTypes(h.store, run.id).includes('step_started'))
    const ack = h.orchestrator.requestCancel(run.id, 'operator')
    // The command only records intent.
    expect(ack.state).toBe('cancel_requested')
    await h.orchestrator.idle()

    const final = h.store.getRun(run.id)
    expect(final.state).toBe('cancelled')
    const types = eventTypes(h.store, run.id)
    expect(types).toContain('run_cancel_requested')
    expect(types.at(-1)).toBe('run_cancelled')
    expect(h.store.catchUp(0, run.id).events.at(-1)!.payload.mode).toBe('graceful')
    const attempts = h.store.listAttempts(run.id)
    expect(attempts).toHaveLength(1)
    expect(attempts[0].status).toBe('cancelled')
  })

  it('force-stops a worker that ignores cancellation and rejects its late writes', async () => {
    let release: (() => void) | null = null
    let staleWrite: (() => void) | null = null
    const stubborn: AgentAdapter = {
      id: 'scripted',
      execute: (assignment, ctx) =>
        new Promise((resolve) => {
          staleWrite = () => ctx.tools.recordAgentMessage('still here')
          release = () => resolve({ kind: 'finished', reason: 'ignored the abort' })
          void assignment
        }),
    }
    h = await makeHarness({ adapter: () => stubborn, cancelGraceMs: 100 })
    const { run } = h.orchestrator.start(h.startInput())
    await waitFor(() => eventTypes(h.store, run.id).includes('attempt_started'))
    h.orchestrator.requestCancel(run.id, 'operator')
    await h.orchestrator.idle()

    const final = h.store.getRun(run.id)
    expect(final.state).toBe('cancelled')
    expect(h.store.catchUp(0, run.id).events.at(-1)!.payload.mode).toBe('force_stopped')
    const [attempt] = h.store.listAttempts(run.id)
    expect(attempt.status).toBe('cancelled')
    expect(attempt.ownerGeneration).toBe(2)

    expect(() => staleWrite!()).toThrow(StaleOwnershipError)
    release!()
  })

  it('pauses at a boundary, then resumes and completes', async () => {
    h = await makeHarness({ adapter: () => new ScriptedAgent({ stepDelayMs: 50 }) })
    const { run } = h.orchestrator.start(h.startInput())
    await waitFor(() => eventTypes(h.store, run.id).includes('step_started'))
    expect(h.orchestrator.requestPause(run.id, 'operator').state).toBe('pause_requested')
    await waitFor(() => h.store.getRun(run.id).state === 'paused')
    const startedWhilePaused = eventTypes(h.store, run.id).filter((t) => t === 'attempt_started').length
    await new Promise((r) => setTimeout(r, 150))
    expect(eventTypes(h.store, run.id).filter((t) => t === 'attempt_started').length).toBe(startedWhilePaused)

    h.orchestrator.resume(run.id, 'operator')
    await h.orchestrator.idle()
    expect(h.store.getRun(run.id).state).toBe('completed')
    expect(eventTypes(h.store, run.id)).toEqual(expect.arrayContaining(['run_pause_requested', 'run_paused', 'run_resumed']))
  })

  it('marks orphaned runs explicitly after a restart', async () => {
    h = await makeHarness()
    const { run } = h.store.startRun(h.startInput())
    h.store.transitionRun(run.id, 'start', 'run_started', {})
    const lease = h.store.createAttempt(run.id, 'storefront-loads', 'old-worker', 'scripted')
    expect(h.store.recoverOrphans('app restarted')).toEqual([run.id])
    expect(h.store.getRun(run.id).state).toBe('failed')
    expect(h.store.getAttempt(lease.attemptId).status).toBe('error')
    expect(() => h.store.workerAppend(lease, 'agent_message', { text: 'late' })).toThrow(StaleOwnershipError)
  })
})
