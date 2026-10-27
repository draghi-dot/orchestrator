import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { SHARED_FACT_EVENTS, type Envelope } from '../../../shared/events'
import { applyRunEvent, initialRunView, type RunView } from '../../../shared/fold'
import { query } from './api'
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

function openStream(runId: string | null, cursor: () => number,
  batch: (events: Envelope[], history: boolean, window?: { highWaterSeq: number; complete: boolean }) => void,
  status: (value: ConnectionStatus) => void) {
  let closed = false, subId: string | null = null, timer: ReturnType<typeof setTimeout> | null = null
  let failures = 0
  const connect = async () => {
    let catchingUp = true
    const buffered: Envelope[] = []
    try {
      const result = await window.qa.subscribe(runId, cursor(), (events) => {
        if (closed) return
        if (catchingUp) buffered.push(...events)
        else batch(events, false)
      })
      subId = result.subId
      if (closed) { await window.qa.unsubscribe(subId); return }
      let page = result.window
      while (!closed) {
        batch(page.events, true, page)
        if (page.complete) break
        const last = page.events.at(-1)?.seq
        if (last === undefined) throw new Error('Incomplete event history without a cursor')
        page = await query('events', { runId, afterSeq: last })
      }
      catchingUp = false
      if (closed) return
      if (buffered.length) batch(buffered.sort((a, b) => a.seq - b.seq), false)
      failures = 0; status('live')
    } catch {
      if (subId) { void window.qa.unsubscribe(subId).catch(() => {}); subId = null }
      if (!closed) { failures++; status(failures > 2 ? 'disconnected' : 'reconnecting'); timer = setTimeout(connect, 2000) }
    }
  }
  status('connecting'); void connect()
  return () => { closed = true; if (timer) clearTimeout(timer); if (subId) void window.qa.unsubscribe(subId).catch(() => {}) }
}

export interface RunStream { view: RunView; events: Envelope[]; status: ConnectionStatus; replayComplete: boolean | null }
export function useRunStream(runId: string): RunStream {
  const [state, setState] = useState<RunStream>({ view: initialRunView, events: [], status: 'connecting', replayComplete: null })
  const current = useRef(initialRunView)
  useEffect(() => {
    current.current = initialRunView
    setState({ view: initialRunView, events: [], status: 'connecting', replayComplete: null })
    return openStream(runId, () => current.current.seq, (events, history, page) => {
      const fresh = events.filter((e) => e.runId === runId && e.seq > current.current.seq).sort((a, b) => a.seq - b.seq)
      const view = fresh.reduce(applyRunEvent, current.current)
      current.current = view
      setState((s) => ({ ...s, view, events: [...s.events, ...fresh], replayComplete: history && page ? page.complete : s.replayComplete }))
    }, (status) => setState((s) => ({ ...s, status })))
  }, [runId])
  return state
}
const LiveContext = createContext({ status: 'connecting' as ConnectionStatus, version: 0 })
export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState({ status: 'connecting' as ConnectionStatus, version: 0 })
  const cursor = useRef<number | null>(null)
  useEffect(() => openStream(null, () => cursor.current ?? Number.MAX_SAFE_INTEGER, (events, history, page) => {
    if (history && cursor.current === null && page) {
      cursor.current = page.highWaterSeq
      setState((s) => ({ ...s, version: s.version + 1 }))
    }
    const fresh = events.filter((e) => e.seq > (cursor.current ?? 0)).sort((a, b) => a.seq - b.seq)
    if (!fresh.length) return
    cursor.current = fresh.at(-1)!.seq
    if (fresh.some((e) => SHARED_FACT_EVENTS.has(e.type))) setState((s) => ({ ...s, version: s.version + 1 }))
  }, (status) => setState((s) => ({ ...s, status }))), [])
  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>
}
export const useLive = () => useContext(LiveContext)
