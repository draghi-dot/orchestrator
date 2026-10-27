/** Electron composition root. The renderer receives a narrow, typed bridge. */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, type WebContents, app, dialog, ipcMain, session, shell, nativeTheme } from 'electron'
import type { WorkerProfile } from '../shared/domain'
import type { Envelope } from '../shared/events'
import type { Result } from '../shared/ipc'
import { AccountManager } from './accounts'
import { ControlPlaneApi } from './api'
import { openDatabase } from './db'
import { EvidenceStore } from './evidence'
import { ToolGateway } from './gateway'
import { Importer } from './importer'
import { KnowledgeBase } from './knowledge'
import { Orchestrator } from './orchestrator'
import { ProcessManager } from './processes'
import { ClaudeRuntime } from './runtimes/claude'
import { CodexRuntime } from './runtimes/codex'
import { OfflineRuntime } from './runtimes/offline'
import { OmpRuntime } from './runtimes/omp'
import type { AgentRuntime } from './runtimes/types'
import { seedArena } from './seed'
import { SettingsStore, resolveCommand } from './settings'
import { QaStore } from './store'

const DEV_URL = process.env.ELECTRON_RENDERER_URL
const RENDERER_FILE = join(__dirname, '../renderer/index.html')
app.setName('Baton')
if (process.env.QA_ARENA_TEST_DATA_DIR) app.setPath('userData', process.env.QA_ARENA_TEST_DATA_DIR)
let mainWindow: BrowserWindow | null = null
let orchestrator: Orchestrator | null = null
let accounts: AccountManager | null = null
let gateway: ToolGateway | null = null
let store: QaStore | null = null
const subscriptions = new Map<string, { contents: WebContents; runId: string | null }>()

const result = async <T>(fn: () => T | Promise<T>): Promise<Result<T>> => {
  try { return { ok: true, value: await fn() } }
  catch (err) { return { ok: false, error: { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err) } } }
}
function trustedUrl(raw: string): boolean {
  try { return DEV_URL ? new URL(raw).origin === new URL(DEV_URL).origin : raw.split('#')[0].split('?')[0] === pathToFileURL(RENDERER_FILE).href }
  catch { return false }
}
function trusted(contents: WebContents, frame: Electron.WebFrameMain | null): boolean {
  return !!mainWindow && contents.id === mainWindow.webContents.id && frame === contents.mainFrame && trustedUrl(frame.url)
}
function requireTrusted(contents: WebContents, frame: Electron.WebFrameMain | null): void {
  if (!trusted(contents, frame)) throw new Error('Untrusted IPC sender')
}

async function boot(): Promise<void> {
  const dataDir = app.getPath('userData')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const database = join(dataDir, 'baton.sqlite')
  store = new QaStore(openDatabase(database))
  chmodSync(database, 0o600)
  const evidence = new EvidenceStore(join(dataDir, 'evidence'))
  const settings = new SettingsStore(dataDir)
  const localLibrary = join(__dirname, '..', '..', '..', 'ctf-important-writeups')
  if (!existsSync(join(dataDir, 'runtime-settings.json')) && existsSync(localLibrary)) settings.save({ knowledgePath: localLibrary })
  const importer = new Importer(store, join(dataDir, 'snapshots'))
  const resources = app.isPackaged ? join(process.resourcesPath, 'qa-resources') : join(__dirname, '..', '..', 'resources')
  seedArena(store, importer, join(resources, 'sample-shop'))
  store.recoverOrphans('Application restarted; the previous worker no longer owns this run')
  const processes = new ProcessManager()
  accounts = new AccountManager(() => settings.get(), dataDir)
  gateway = new ToolGateway()
  await gateway.start()
  let libraryPath: string | null = null
  let library: KnowledgeBase | null = null
  const knowledge = () => {
    const path = settings.get().knowledgePath
    if (path !== libraryPath) {
      libraryPath = path
      try { library = KnowledgeBase.load(path) } catch { library = null }
    }
    return library
  }
  const runtimes = (profile: WorkerProfile): AgentRuntime => {
    if (profile.runtime === 'offline') return new OfflineRuntime({ stepDelayMs: process.env.QA_ARENA_FAST === '1' ? 0 : 180 })
    const configured = settings.get()[`${profile.runtime}Command`]
    const options = { command: resolveCommand(configured) ?? configured }
    if (profile.runtime === 'claude') return new ClaudeRuntime(options)
    if (profile.runtime === 'codex') return new CodexRuntime(options)
    return new OmpRuntime(options)
  }
  orchestrator = new Orchestrator({ store, evidence, processes, runtimes, gateway,
    runRoot: join(dataDir, 'runs'), bridgePath: join(resources, 'qa-mcp-bridge.cjs'),
    node: { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }, knowledge,
  })
  const api = new ControlPlaneApi({ store, evidence, orchestrator, settings, importer, accounts,
    operator: userInfo().username, knowledge,
    chooseZip: async () => {
      const selected = await dialog.showOpenDialog({ title: 'Import a project ZIP', filters: [{ name: 'ZIP archive', extensions: ['zip'] }], properties: ['openFile'] })
      const file = selected.filePaths[0]
      return selected.canceled || !file ? null : { fileName: basename(file), data: readFileSync(file) }
    },
    saveFile: async (name, data) => {
      const selected = await dialog.showSaveDialog({ defaultPath: name })
      if (selected.canceled || !selected.filePath) return null
      writeFileSync(selected.filePath, data)
      return selected.filePath
    },
    openUrl: (url) => shell.openExternal(url),
  })
  ipcMain.handle('qa:query', (event, name: string, args: unknown) => result(() => {
    requireTrusted(event.sender, event.senderFrame)
    return api.query(name as never, args as never)
  }))
  ipcMain.handle('qa:command', (event, command: unknown) => result(() => {
    requireTrusted(event.sender, event.senderFrame)
    return api.command(command as never)
  }))
  store.onCommit((events: Envelope[]) => {
    for (const [id, sub] of subscriptions) {
      if (sub.contents.isDestroyed()) { subscriptions.delete(id); continue }
      const matching = sub.runId === null ? events : events.filter((e) => e.runId === sub.runId)
      if (matching.length) sub.contents.send('qa:events', id, matching)
    }
  })
  accounts.onUpdate((update) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('qa:login', update) })
  ipcMain.handle('qa:subscribe', (event, runId: string | null, afterSeq: number) => {
    requireTrusted(event.sender, event.senderFrame)
    if (runId !== null) store!.getRun(runId)
    const subId = randomUUID()
    subscriptions.set(subId, { contents: event.sender, runId })
    return { subId, window: store!.catchUp(Math.max(0, Number(afterSeq) || 0), runId, 2000) }
  })
  ipcMain.handle('qa:unsubscribe', (event, subId: string) => {
    requireTrusted(event.sender, event.senderFrame)
    if (subscriptions.get(subId)?.contents === event.sender) subscriptions.delete(subId)
  })
  createWindow()
  orchestrator.kick()
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 1050, minHeight: 700, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161615' : '#fbfbfa', title: 'Baton',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default', trafficLightPosition: { x: 20, y: 22 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  mainWindow = window
  window.once('ready-to-show', () => window.show())
  const clear = () => { for (const [id, sub] of subscriptions) if (sub.contents === window.webContents) subscriptions.delete(id) }
  window.webContents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) clear() })
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  window.webContents.on('destroyed', clear)
  if (DEV_URL) void window.loadURL(DEV_URL)
  else void window.loadFile(RENDERER_FILE)
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' && !u.username && !u.password) void shell.openExternal(u.href) } catch { /* invalid URL */ }
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => { if (!trustedUrl(url)) event.preventDefault() })
})
app.whenReady().then(async () => {
  if (!DEV_URL) session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: {
    ...details.responseHeaders,
    'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'"],
  } }))
  await boot()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
}).catch((err) => { console.error('Baton startup failed:', err); app.quit() })
let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  accounts?.close()
  void (async () => { await orchestrator?.shutdown(); await gateway?.stop(); store?.db.close() })().finally(() => app.quit())
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
