import { contextBridge, ipcRenderer } from 'electron'
import type { Envelope } from '../shared/events'
import type { KestrelBridge, StreamWindow } from '../shared/ipc'

const listeners = new Map<string, (events: Envelope[]) => void>()
// Live events that arrive for a subscription before its id is known locally.
const early = new Map<string, Envelope[][]>()

ipcRenderer.on('qa:events', (_event, subId: string, events: Envelope[]) => {
  const listener = listeners.get(subId)
  if (listener) listener(events)
  else early.set(subId, [...(early.get(subId) ?? []), events])
})

const bridge: KestrelBridge = {
  query: (name, args) => ipcRenderer.invoke('qa:query', name, args),
  command: (command) => ipcRenderer.invoke('qa:command', command),
  async subscribe(runId, afterSeq, onEvents) {
    const { subId, window } = (await ipcRenderer.invoke('qa:subscribe', runId, afterSeq)) as { subId: string; window: StreamWindow }
    listeners.set(subId, onEvents)
    // Pushes that raced ahead of this reply were committed after the
    // catch-up read; append them so the caller folds one ordered window.
    const buffered = (early.get(subId) ?? []).flat()
    early.delete(subId)
    const seen = new Set(window.events.map((e) => e.seq))
    const merged = [...window.events, ...buffered.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq)
    return { subId, window: { ...window, events: merged } }
  },
  async unsubscribe(subId) {
    listeners.delete(subId)
    early.delete(subId)
    await ipcRenderer.invoke('qa:unsubscribe', subId)
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('kestrel', bridge)
