/**
 * Event stream client (after Kestrel's sse.ts), over Electron IPC.
 *
 * Every incoming event goes through the one shared fold (`applyRunEvent`).
 * On (re)subscribe the cursor is the seq of the last *applied* event, so a
 * reconnect replays exactly what is missing; duplicates fold to no-ops.
 */

import { type ReactNode, createContext, useContext, useEffect, useRef, useState } from 'react'
import { RUN_LEVEL_EVENT_TYPES, type Envelope } from '../../../shared/events'
import { type RunView, applyRunEvent, initialRunView } from '../../../shared/fold'

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

const RETRY_MS = 2000
const RED_AFTER_FAILURES = 3

interface Handle {
  close(): void
}

function openStream(
  runId: string | null,
  startAfter: () => number,
  onBatch: (events: Envelope[], fromCatchUp: boolean, window?: { highWaterSeq: number; complete: boolean }) => void,
  onStatus: (s: ConnectionStatus) => void,
): Handle {
  let closed = false
  let subId: string | null = null
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const connect = async () => {
    if (closed) return
    try {
      const result = await window.kestrel.subscribe(runId, startAfter(), (events) => {
        if (!closed) onBatch(events, false)
      })
      if (closed) {
        void window.kestrel.unsubscribe(result.subId)
        return
      }
      subId = result.subId
      failures = 0
      onBatch(result.window.events, true, { highWaterSeq: result.window.highWaterSeq, complete: result.window.complete })
      onStatus('live')
    } catch {
      failures += 1
      onStatus(failures >= RED_AFTER_FAILURES ? 'disconnected' : 'reconnecting')
      timer = setTimeout(connect, RETRY_MS)
    }
  }
  onStatus('connecting')
  void connect()
  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      if (subId) void window.kestrel.unsubscribe(subId)
    },
  }
}

export interface RunStream {
  view: RunView
  events: Envelope[]
  status: ConnectionStatus
  replayComplete: boolean | null
}

/** A run's ordered history plus its live fold. */
export function useRunStream(runId: string): RunStream {
  const [state, setState] = useState<RunStream>({ view: initialRunView, events: [], status: 'connecting', replayComplete: null })
  const viewRef = useRef<RunView>(initialRunView)

  useEffect(() => {
    viewRef.current = initialRunView
    setState({ view: initialRunView, events: [], status: 'connecting', replayComplete: null })
    const handle = openStream(
      runId,
      () => viewRef.current.seq,
      (batch, fromCatchUp, window) => {
        const fresh = batch.filter((e) => e.runId === runId && e.seq > viewRef.current.seq).sort((a, b) => a.seq - b.seq)
        let view = viewRef.current
        for (const e of fresh) view = applyRunEvent(view, e)
        viewRef.current = view
        setState((prev) => ({
          ...prev,
          view,
          events: fresh.length > 0 ? [...prev.events, ...fresh] : prev.events,
          replayComplete: fromCatchUp && window ? window.complete : prev.replayComplete,
        }))
      },
      (status) => setState((prev) => ({ ...prev, status })),
    )
    return () => handle.close()
  }, [runId])

  return state
}

interface LiveContextValue {
  status: ConnectionStatus
  /** Bumped when a run-level fact commits; screens refetch on change. */
  version: number
  lastEvent: Envelope | null
}

const LiveContext = createContext<LiveContextValue>({ status: 'connecting', version: 0, lastEvent: null })

export function LiveProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<LiveContextValue>({ status: 'connecting', version: 0, lastEvent: null })
  const cursor = useRef<number | null>(null)

  useEffect(() => {
    const handle = openStream(
      null,
      // The global feed only needs what happens from now on; the first
      // connect asks for the tail position, later reconnects resume.
      () => cursor.current ?? Number.MAX_SAFE_INTEGER,
      (batch, fromCatchUp, window) => {
        if (fromCatchUp && cursor.current === null && window) {
          cursor.current = Math.max(window.highWaterSeq, ...batch.map((e) => e.seq))
          setValue((v) => ({ ...v, version: v.version + 1 }))
          return
        }
        const fresh = batch.filter((e) => e.seq > (cursor.current ?? 0))
        if (fresh.length === 0) return
        cursor.current = fresh[fresh.length - 1].seq
        const relevant = fresh.some((e) => RUN_LEVEL_EVENT_TYPES.has(e.type))
        setValue((v) => ({ ...v, lastEvent: fresh[fresh.length - 1], version: relevant ? v.version + 1 : v.version }))
      },
      (status) => setValue((v) => ({ ...v, status })),
    )
    return () => handle.close()
  }, [])

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

export const useLive = () => useContext(LiveContext)
