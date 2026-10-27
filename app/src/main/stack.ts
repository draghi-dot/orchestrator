/**
 * Read-only discovery for an imported app (build plan, section 03):
 * languages, frameworks, likely commands, routes, tests, risky areas, and
 * files that look like they hold secrets (names only, never contents).
 * These are hints for the questionnaire and the workers. Nothing here runs
 * anything from the app.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { AreaId, StackInfo } from '../shared/domain'

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'JavaScript',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.html': 'HTML',
  '.css': 'CSS',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
}

const JS_FRAMEWORKS = ['express', 'fastify', 'koa', 'hono', 'next', 'nuxt', 'react', 'vue', 'svelte', '@sveltejs/kit', 'vite', '@nestjs/core', 'remix', 'astro']
const PY_FRAMEWORKS = ['flask', 'django', 'fastapi', 'starlette', 'tornado', 'aiohttp']

function readText(path: string, max = 512 * 1024): string | null {
  try {
    const data = readFileSync(path)
    return data.subarray(0, max).toString('utf8')
  } catch {
    return null
  }
}

export function detectStack(root: string, files: string[]): StackInfo {
  const languages = new Map<string, number>()
  for (const file of files) {
    const lang = LANGUAGE_BY_EXT[extname(file).toLowerCase()]
    if (lang) languages.set(lang, (languages.get(lang) ?? 0) + 1)
  }
  const has = (name: string) => files.includes(name)
  const frameworks: string[] = []
  let packageManager: string | null = null
  const commands: StackInfo['commands'] = { install: null, start: null, test: null }

  if (has('package.json')) {
    packageManager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm'
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; main?: string } = {}
    try {
      pkg = JSON.parse(readText(join(root, 'package.json')) ?? '{}')
    } catch {
      pkg = {}
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const f of JS_FRAMEWORKS) if (f in deps) frameworks.push(f.replace(/^@[^/]+\//, ''))
    const run = (script: string) => (packageManager === 'npm' ? (script === 'start' || script === 'test' ? `npm ${script}` : `npm run ${script}`) : `${packageManager} ${script === 'start' || script === 'test' ? script : `run ${script}`}`)
    if (Object.keys(deps).length > 0) commands.install = `${packageManager} install`
    const scripts = pkg.scripts ?? {}
    if (scripts.start) commands.start = run('start')
    else if (scripts.dev) commands.start = run('dev')
    else if (pkg.main && existsSync(join(root, pkg.main))) commands.start = `node ${pkg.main}`
    else if (has('server.js')) commands.start = 'node server.js'
    else if (has('index.js')) commands.start = 'node index.js'
    if (scripts.test && !/no test specified/.test(scripts.test)) commands.test = run('test')
  }

  const pyReqs = readText(join(root, 'requirements.txt')) ?? readText(join(root, 'pyproject.toml'))
  if (pyReqs !== null || languages.has('Python')) {
    const lower = (pyReqs ?? '').toLowerCase()
    for (const f of PY_FRAMEWORKS) if (lower.includes(f)) frameworks.push(f)
    if (has('requirements.txt')) commands.install ??= 'pip3 install -r requirements.txt'
    if (!commands.start) {
      if (has('manage.py')) commands.start = 'python3 manage.py runserver'
      else if (has('app.py')) commands.start = 'python3 app.py'
      else if (has('main.py')) commands.start = 'python3 main.py'
    }
    if (!commands.test && (has('pytest.ini') || has('tests') || lower.includes('pytest'))) commands.test = 'python3 -m pytest'
  }

  if (has('go.mod')) {
    commands.start ??= 'go run .'
    commands.test ??= 'go test ./...'
  }
  if (has('Cargo.toml')) {
    commands.start ??= 'cargo run'
    commands.test ??= 'cargo test'
  }

  const readmeName = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f))
  const readme = readmeName ? readText(join(root, readmeName), 4000) : null

  const scan = scanSources(root, files)
  if (!commands.test && scan.testRunner) commands.test = scan.testRunner

  return {
    languages: [...languages.entries()].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files).slice(0, 6),
    frameworks: [...new Set(frameworks)],
    packageManager,
    commands,
    readmeExcerpt: readme ? readme.slice(0, 1200) : null,
    topLevel: [...new Set(files.map((f) => f.split('/')[0]))].sort().slice(0, 40),
    routes: scan.routes,
    tests: { files: scan.testFiles, runner: commands.test },
    areas: scan.areas,
    sensitive: files.filter((f) => SENSITIVE.test(f.split('/').pop() ?? '')).slice(0, 40),
    mentionsTestAccounts: readme !== null && /test (user|account)s?|demo (user|account)s?|sample (user|account)s?/i.test(readme),
  }
}

const SENSITIVE = /^(\.env(\..+)?|.+\.pem|.+\.key|id_rsa|id_ed25519|credentials\.json|secrets?\.(json|ya?ml|toml)|\.npmrc|\.pypirc|service-?account.*\.json)$/i
const SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rb|go|php|java|kt|rs|vue|svelte)$/i
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.go$/i

const AREA_PATTERNS: Record<Exclude<AreaId, 'api'>, RegExp> = {
  auth: /\b(login|logout|signin|sign_in|signup|password|passwd|jwt|session|authenticate|bearer|oauth)\b/i,
  payments: /\b(payment|checkout|cart|price|pricing|stripe|invoice|order|discount|coupon|billing|refund)\b/i,
  admin: /\b(admin|isAdmin|is_admin|superuser|role|permission)\b/i,
  upload: /\b(upload|multer|multipart|formidable|busboy|UploadFile)\b/i,
  data: /\b(SELECT\s|INSERT\s+INTO|DELETE\s+FROM|sequelize|prisma|mongoose|knex|sqlite3?|psycopg|SQLAlchemy|mysql|redis)\b/i,
}

const ROUTE_PATTERNS: { re: RegExp; method: (m: RegExpMatchArray) => string; path: (m: RegExpMatchArray) => string }[] = [
  // Express, Koa router, Fastify, Hono
  { re: /\b(?:app|router|server|fastify|api|route)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]/gi, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  // FastAPI
  { re: /@\w+\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  // Flask
  { re: /@\w+\.route\(\s*['"]([^'"]+)['"]/gi, method: () => 'ANY', path: (m) => m[1] },
  // Plain Node http servers comparing the pathname
  { re: /pathname\s*===?\s*['"](\/[^'"]*)['"]/g, method: () => 'ANY', path: (m) => m[1] },
]

function scanSources(root: string, files: string[]): { routes: StackInfo['routes']; testFiles: number; testRunner: string | null; areas: StackInfo['areas'] } {
  const routes: StackInfo['routes'] = []
  const areaFiles = new Map<AreaId, string[]>()
  let testFiles = 0
  let scanned = 0
  for (const file of files) {
    if (TEST_FILE.test(file)) {
      testFiles += 1
      continue
    }
    if (!SOURCE.test(file) || scanned >= 400) continue
    const text = readText(join(root, file), 512 * 1024)
    if (text === null) continue
    scanned += 1
    for (const [area, re] of Object.entries(AREA_PATTERNS) as [AreaId, RegExp][]) {
      if (re.test(file) || re.test(text)) {
        const list = areaFiles.get(area) ?? []
        if (list.length < 6) list.push(file)
        areaFiles.set(area, list)
      }
    }
    if (routes.length >= 200) continue
    for (const pattern of ROUTE_PATTERNS) {
      for (const m of text.matchAll(pattern.re)) {
        if (routes.length >= 200) break
        const index = m.index ?? 0
        const line = text.slice(0, index).split('\n').length
        const path = pattern.path(m)
        if (!path.startsWith('/')) continue
        if (routes.some((r) => r.path === path && r.method === pattern.method(m))) continue
        routes.push({ method: pattern.method(m), path, location: `${file}:${line}` })
      }
    }
  }
  const areas: StackInfo['areas'] = [...areaFiles.entries()].map(([id, list]) => ({ id, files: list }))
  if (routes.length > 0) areas.push({ id: 'api', files: [...new Set(routes.map((r) => r.location.split(':')[0]))].slice(0, 6) })
  return { routes, testFiles, testRunner: null, areas }
}
