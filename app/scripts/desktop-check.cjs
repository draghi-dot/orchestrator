/** Real Electron UI smoke check. Uses an isolated database; never changes provider sign-in. */
const { app } = require('electron')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const output = process.env.QA_DESKTOP_OUTPUT || mkdtempSync(join(tmpdir(), 'qa-arena-desktop-'))
mkdirSync(output, { recursive: true })
process.env.QA_ARENA_TEST_DATA_DIR = join(output, 'data')
process.env.QA_ARENA_FAST = '1'
const errors = []
let started = false
let completed = false
let failureWritten = false
app.on('before-quit', () => {
  if (!completed) {
    process.exitCode = 1
    if (!failureWritten) writeFileSync(join(output, 'result.json'), JSON.stringify({ ok: false, error: 'Application quit before the desktop check completed.' }, null, 2))
  }
})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.on('browser-window-created', (_event, window) => {
  if (started) return
  started = true
  const wc = window.webContents
  wc.on('render-process-gone', (_e, details) => errors.push(`Renderer exited: ${details.reason}`))
  wc.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
  const js = (code) => wc.executeJavaScript(code, true)
  async function until(code, label, timeout = 20_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await js(code)) return
      await delay(100)
    }
    throw new Error(`Timed out: ${label}`)
  }
  async function click(selector) {
    await until(`!!document.querySelector(${JSON.stringify(selector)})`, selector)
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`)
  }
  async function clickText(text) {
    const code = `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`
    await until(`!!(${code}) && !(${code}).disabled`, text)
    await js(`(${code}).click()`)
  }
  async function shot(name) {
    await delay(180)
    writeFileSync(join(output, `${name}.png`), (await wc.capturePage()).toPNG())
  }
  wc.once('did-finish-load', () => {
    void (async () => {
      await until("document.body.textContent.includes('Sample Shop')", 'seeded project')
      await shot('01-projects')
      await click('a[href^="#/setup/"]')
      await until("document.body.textContent.includes('Worker lineup')", 'setup loaded')
      await clickText('Use offline workers')
      await shot('02-setup')
      await clickText('Start audit')
      await until("location.hash.startsWith('#/arena/')", 'audit started')
      const runId = await js("location.hash.split('/')[2]")
      const detailCode = `(await window.qa.query('runDetail', {runId:${JSON.stringify(runId)}}))`
      await until(`(async () => {const r=${detailCode}; if(!r.ok) throw new Error(r.error.message); if(['failed','cancelled'].includes(r.value.run.state)) throw new Error(r.value.run.terminalReason); return r.value.run.state==='completed'})()`, 'audit completed', 60_000)
      const result = await js(`(async () => ${detailCode})()`)
      if (result.value.run.summary.confirmed !== 4 || result.value.run.summary.rejected !== 1) throw new Error('Unexpected sample verdicts')
      if (result.value.reports.length !== 2) throw new Error('Interim/final reports missing')
      await shot('03-arena')
      await click('.finding-row')
      await until("!!document.querySelector('[role=dialog]')", 'finding opened')
      await shot('04-finding-detail')
      await click('[role=dialog] button[aria-label=Close]')
      await clickText('score')
      await shot('05-score')
      await clickText('report')
      await until("document.body.textContent.includes('Final report')", 'final report shown')
      await shot('06-report')
      await click('nav a[href="#/findings"]')
      await until("document.body.textContent.includes('SAVE20 applies')", 'findings shown')
      await shot('07-findings')
      await click('nav a[href="#/dna"]')
      await until("document.body.textContent.includes('Current rules')", 'DNA loaded')
      await shot('08-dna')
      await click('nav a[href="#/settings"]')
      await until("document.body.textContent.includes('CLI executable paths')", 'settings loaded')
      await until("document.querySelectorAll('.provider-grid > article').length === 3", 'provider statuses loaded', 45_000)
      await shot('09-settings')
      if (errors.length) throw new Error(errors.join('\n'))
      writeFileSync(join(output, 'result.json'), JSON.stringify({ ok: true, runId, summary: result.value.run.summary, reportVersions: result.value.reports.length, screenshots: 9 }, null, 2))
      completed = true
      console.log(`Desktop check passed. Screenshots and result: ${output}`)
      app.quit()
    })().catch((error) => {
      failureWritten = true
      writeFileSync(join(output, 'result.json'), JSON.stringify({ ok: false, error: String(error), consoleErrors: errors }, null, 2))
      console.error(error)
      process.exitCode = 1
      app.quit()
    })
  })
})

require('../out/main/index.js')
