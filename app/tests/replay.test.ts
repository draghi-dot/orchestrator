import { afterEach, describe, expect, it } from 'vitest'
import { type RunView, applyRunEvent, foldRun, initialRunView } from '../src/shared/fold'
import type { Envelope } from '../src/shared/events'
import { type Harness, makeHarness } from './helpers'

let h: Harness
afterEach(async () => h?.close())

describe('live and replay agree', () => {
  it('produces the same view live (with redelivery) as from a cold replay', async () => {
    h = await makeHarness()
    const { run } = h.store.startRun(h.startInput())

    // "Live": fold events as they commit, delivering every batch twice to
    // simulate at-least-once delivery, and snapshot the view at each seq.
    let live: RunView = initialRunView
    const snapshots = new Map<number, RunView>()
    // run_created already committed before we subscribed: catch up first.
    for (const e of h.store.catchUp(0, run.id).events) live = applyRunEvent(live, e)
    snapshots.set(live.seq, live)
    const unsubscribe = h.store.onCommit((events) => {
      for (const e of [...events, ...events]) {
        if (e.runId !== run.id) continue
        live = applyRunEvent(live, e)
        snapshots.set(live.seq, live)
      }
    })
    h.orchestrator.kick()
    await h.orchestrator.idle()
    unsubscribe()

    const all = h.store.catchUp(0, run.id).events
    const replayed = foldRun(all)
    expect(replayed).toEqual(live)
    expect(replayed.state).toBe('completed')
    expect(replayed.summary.failed).toBe(1)

    // Scrubbing replay to any playhead equals what live showed at that seq.
    for (const [seq, view] of snapshots) expect(foldRun(all, seq)).toEqual(view)
  })

  it('resumes from the last applied seq without missing or double-applying', async () => {
    h = await makeHarness()
    const { run } = h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()
    const all = h.store.catchUp(0, run.id).events

    const cut = Math.floor(all.length / 2)
    let view = foldRun(all.slice(0, cut))
    // Reconnect: ask only for what comes after the applied cursor, then also
    // receive an overlapping duplicate window.
    const resumed = h.store.catchUp(view.seq, run.id).events
    const overlap: Envelope[] = [...all.slice(cut - 3, cut), ...resumed]
    for (const e of overlap) view = applyRunEvent(view, e)
    expect(view).toEqual(foldRun(all))
  })

  it('reports the global high-water mark so a filtered replay knows it is complete', async () => {
    h = await makeHarness()
    const a = h.orchestrator.start(h.startInput()).run
    h.orchestrator.start(h.startInput())
    await h.orchestrator.idle()
    const window = h.store.catchUp(0, a.id)
    expect(window.complete).toBe(true)
    expect(window.highWaterSeq).toBe(h.store.latestSeq())
    expect(window.events.every((e) => e.runId === a.id)).toBe(true)
    expect(window.events.at(-1)!.seq).toBeLessThan(window.highWaterSeq)
  })
})
