/**
 * Best-effort stack detection for an imported app: languages, frameworks,
 * and the commands that probably install, start, and test it. These are
 * hints for the Builder, not instructions; nothing here runs anything.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { StackInfo } from '../shared/domain'

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

  return {
    languages: [...languages.entries()].map(([name, count]) => ({ name, files: count })).sort((a, b) => b.files - a.files).slice(0, 6),
    frameworks: [...new Set(frameworks)],
    packageManager,
    commands,
    readmeExcerpt: readme ? readme.slice(0, 1200) : null,
    topLevel: [...new Set(files.map((f) => f.split('/')[0]))].sort().slice(0, 40),
  }
}
