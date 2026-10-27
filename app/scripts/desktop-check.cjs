/** Real Electron UI smoke check. Uses an isolated database; never changes provider sign-in. */
const { app, nativeTheme } = require('electron')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const output = process.env.QA_DESKTOP_OUTPUT || mkdtempSync(join(tmpdir(), 'baton-desktop-'))
mkdirSync(output, { recursive: true })
process.env.QA_ARENA_TEST_DATA_DIR = join(output, 'data')
process.env.QA_ARENA_FAST = process.env.QA_ARENA_FAST ?? '1'
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
  wc.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
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
    const find = `Array.from(document.querySelectorAll('button, a')).find(b => b.textContent.trim() === ${JSON.stringify(text)})`
    await until(`!!(${find}) && !(${find}).disabled`, text)
    await js(`(${find}).click()`)
  }
  async function shot(name) {
    await delay(250)
    writeFileSync(join(output, `${name}.png`), (await wc.capturePage()).toPNG())
  }
  const go = (hash) => js(`location.hash = ${JSON.stringify(hash)}`)

  wc.once('did-finish-load', () => {
    void (async () => {
      nativeTheme.themeSource = 'light'
      await until("document.body.textContent.includes('No audits yet')", 'empty audits')
      await shot('01-audits-empty')
      await clickText('Audit the sample project')
      await until("document.body.textContent.includes('Start audit')", 'new audit form')
      await shot('02-new-audit')
      await clickText('Use built-in agents only')
      await clickText('Start audit')
      await until("location.hash.startsWith('#/audits/')", 'audit started')
      const runId = await js("location.hash.split('/')[2]")
      await delay(900)
      await shot('03-audit-running')
      const detail = `(async () => { const r = await window.qa.query('runDetail', { runId: ${JSON.stringify(runId)} }); if (!r.ok) throw new Error(r.error.message); return r.value })()`
      await until(`${detail}.then(v => { if (['failed','cancelled'].includes(v.run.state)) throw new Error(v.run.terminalReason); return v.run.state === 'completed' })`, 'audit completed', 90_000)
      const result = await js(detail)
      if (result.run.summary.confirmed !== 4 || result.run.summary.rejected !== 1) throw new Error(`Unexpected sample verdicts: ${JSON.stringify(result.run.summary)}`)
      await delay(400)
      await shot('04-audit-overview')
      await clickText('Findings5')
      await until("!!document.querySelector('tbody tr.clickable')", 'findings table')
      await shot('05-audit-findings')
      await click('tbody tr.clickable')
      await until("!!document.querySelector('.panel-side')", 'finding panel')
      await shot('06-finding-panel')
      await click('.panel-side button[aria-label=Close]')
      await clickText('Activity')
      await shot('07-activity')
      await clickText('Report')
      await until("!!document.querySelector('.prose')", 'report shown')
      await shot('08-report')
      await go('#/findings')
      await until("!!document.querySelector('tbody tr.clickable')", 'global findings')
      await shot('09-findings')
      await go('#/projects')
      await until("!!document.querySelector('tbody tr.clickable')", 'projects')
      await shot('10-projects')
      await click('tbody tr.clickable')
      await until("!!document.querySelector('.panel-side')", 'project panel')
      await shot('11-project-panel')
      await click('.panel-side button[aria-label=Close]')
      await go('#/playbook')
      await until("document.body.textContent.includes('Guidelines')", 'playbook')
      await shot('12-playbook')
      await go('#/settings')
      await until("document.querySelectorAll('.card .list-row').length >= 3", 'accounts', 45_000)
      await shot('13-settings')
      nativeTheme.themeSource = 'dark'
      await go(`#/audits/${runId}`)
      await until("!!document.querySelector('.steps')", 'audit dark')
      await shot('14-dark-audit')
      await clickText('Findings5')
      await click('tbody tr.clickable')
      await until("!!document.querySelector('.panel-side')", 'finding panel dark')
      await shot('15-dark-finding')
      if (errors.length) throw new Error(errors.join('\n'))
      writeFileSync(join(output, 'result.json'), JSON.stringify({ ok: true, runId, summary: result.run.summary }, null, 2))
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
