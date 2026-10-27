/**
 * Composition root for the desktop app (after Kestrel's apps/api/main.py and
 * apps/engine/main.py, collapsed into one process for phase 1). Concrete
 * stores, the orchestrator, and agent adapters are wired here and nowhere
 * else.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, type WebContents, app, ipcMain, session, shell } from 'electron'
import type { AgentProfile } from '../shared/domain'
import type { Envelope } from '../shared/events'
import type { Result } from '../shared/ipc'
import { OmpAgent } from './adapters/omp'
import { ScriptedAgent } from './adapters/scripted'
import type { AgentAdapter } from './adapters/types'
import { ControlPlaneApi } from './api'
import { openDatabase } from './db'
import { type DemoApp, startDemoApp } from './demo-app'
import { EvidenceStore } from './evidence'
import { Orchestrator } from './orchestrator'
import { seedDemo } from './seed'
import { SettingsStore, resolveCommand } from './settings'
import { QaStore } from './store'

const DEV_URL = process.env.ELECTRON_RENDERER_URL
const DEMO_PORT = 4870

let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null
let demo: DemoApp | null = null

interface Subscription {
  contents: WebContents
  runId: string | null
}

function toResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  return fn().then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({
      ok: false as const,
      error: { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) },
    }),
  )
}

function isTrustedSender(contents: WebContents, frameUrl: string | undefined): boolean {
  if (!mainWindow || contents.id !== mainWindow.webContents.id || !frameUrl) return false
  return DEV_URL ? frameUrl.startsWith(DEV_URL) : frameUrl.startsWith('file://')
}

async function boot(): Promise<void> {
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true })
  const store = new QaStore(openDatabase(join(dataDir, 'kestrel-qa.sqlite')))
  const evidence = new EvidenceStore(join(dataDir, 'evidence'))
  const settings = new SettingsStore(dataDir)
  const workRoot = join(dataDir, 'agent-work')
  mkdirSync(workRoot, { recursive: true })

  store.recoverOrphans('app restarted while the run was active; no worker owns it any more')

  demo = await startDemoApp(DEMO_PORT).catch(() => startDemoApp(0))
  seedDemo(store, demo.origin)

  const adapters = (profile: AgentProfile): AgentAdapter => {
    if (profile.adapter === 'omp') {
      const configured = settings.get().ompCommand
      const cwd = join(workRoot, randomUUID())
      mkdirSync(cwd, { recursive: true })
      return new OmpAgent({ command: resolveCommand(configured) ?? configured, cwd })
    }
    // A short delay per step so the live view is watchable; tests use 0.
    return new ScriptedAgent({ stepDelayMs: 700 })
  }
  orchestrator = new Orchestrator({ store, evidence, adapters, workerId: `worker-${process.pid}` })
  const api = new ControlPlaneApi({ store, evidence, orchestrator, settings, operator: userInfo().username })

  // ---- IPC: queries and commands
  ipcMain.handle('qa:query', (event, name: string, args: unknown) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) return { ok: false, error: { name: 'Forbidden', message: 'untrusted sender' } }
    return toResult(() => api.query(name as never, args as never))
  })
  ipcMain.handle('qa:command', (event, command: unknown) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) return { ok: false, error: { name: 'Forbidden', message: 'untrusted sender' } }
    return toResult(() => api.command(command as never))
  })

  // ---- IPC: event stream (catch-up + live push)
  const subscriptions = new Map<string, Subscription>()
  store.onCommit((events: Envelope[]) => {
    for (const [subId, sub] of subscriptions) {
      if (sub.contents.isDestroyed()) {
        subscriptions.delete(subId)
        continue
      }
      const matching = sub.runId === null ? events : events.filter((e) => e.runId === sub.runId)
      if (matching.length > 0) sub.contents.send('qa:events', subId, matching)
    }
  })
  ipcMain.handle('qa:subscribe', (event, runId: string | null, afterSeq: number) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) throw new Error('untrusted sender')
    // Register and read in the same synchronous tick: store commits are
    // synchronous, so no event can land between the catch-up read and the
    // live registration.
    const subId = randomUUID()
    subscriptions.set(subId, { contents: event.sender, runId })
    const window = store.catchUp(Math.max(0, Number(afterSeq) || 0), runId)
    return { subId, window }
  })
  ipcMain.handle('qa:unsubscribe', (_event, subId: string) => {
    subscriptions.delete(subId)
  })

  createWindow()
  mainWindow?.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      for (const [subId, sub] of subscriptions) if (sub.contents === mainWindow?.webContents) subscriptions.delete(subId)
    }
  })

  // Drain anything left queued from a previous session.
  orchestrator.kick()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f3f3f3',
    title: 'Kestrel QA',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 22 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  if (DEV_URL) void mainWindow.loadURL(DEV_URL)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })
})

app.whenReady().then(async () => {
  if (!DEV_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'",
          ],
        },
      })
    })
  }
  await boot()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  void Promise.all([orchestrator?.shutdown(), demo?.close()]).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
