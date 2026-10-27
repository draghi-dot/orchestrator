import { contextBridge, ipcRenderer } from 'electron'
import type { Envelope } from '../shared/events'
import type { QaBridge, StreamWindow } from '../shared/ipc'

const listeners = new Map<string, (events: Envelope[]) => void>()
// Live events that arrive for a subscription before its id is known locally.
const early = new Map<string, Envelope[][]>()
let pendingSubscriptions = 0

ipcRenderer.on('qa:events', (_event, subId: string, events: Envelope[]) => {
  const listener = listeners.get(subId)
  if (listener) listener(events)
  else if (pendingSubscriptions > 0) early.set(subId, [...(early.get(subId) ?? []), events])
})

const bridge: QaBridge = {
  query: (name, args) => ipcRenderer.invoke('qa:query', name, args),
  command: (command) => ipcRenderer.invoke('qa:command', command),
  async subscribe(runId, afterSeq, onEvents) {
    pendingSubscriptions++
    let response: { subId: string; window: StreamWindow }
    try { response = await ipcRenderer.invoke('qa:subscribe', runId, afterSeq) }
    finally { pendingSubscriptions-- }
    const { subId, window } = response
    listeners.set(subId, onEvents)
    // Pushes that raced ahead of this reply were committed after the
    // catch-up read; let the renderer buffer them until pagination finishes.
    const buffered = (early.get(subId) ?? []).flat()
    early.delete(subId)
    if (buffered.length) queueMicrotask(() => onEvents(buffered))
    return { subId, window }
  },
  async unsubscribe(subId) {
    listeners.delete(subId)
    early.delete(subId)
    await ipcRenderer.invoke('qa:unsubscribe', subId)
  },
  onLoginUpdate(listener) {
    const handler = (_event: Electron.IpcRendererEvent, update: import('../shared/ipc').LoginUpdate) => listener(update)
    ipcRenderer.on('qa:login', handler)
    return () => { ipcRenderer.removeListener('qa:login', handler) }
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('qa', bridge)
