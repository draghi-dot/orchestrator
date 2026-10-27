/**
 * Imports an app under test from GitHub or a ZIP into an immutable snapshot.
 *
 * Everything imported is untrusted. Paths are normalized and confined to the
 * snapshot folder, symlinks are never written or followed, git runs without
 * prompts or hooks, and size and count limits stop archive bombs. Nothing in
 * the imported code is executed here.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, sep } from 'node:path'
import { unzipSync } from 'fflate'
import type { Snapshot, Target, TargetSource } from '../shared/domain'
import { detectStack } from './stack'
import type { QaStore } from './store'

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

export interface ImportLimits {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxFiles: 20_000,
  maxTotalBytes: 300 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
}

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.next', '.turbo', '.DS_Store', '__MACOSX'])

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?$/

export function parseGithubUrl(raw: string): { url: string; owner: string; repo: string; ref: string | null } {
  const match = GITHUB_URL.exec(raw.trim())
  if (!match) throw new ImportError('Use a GitHub repository address like https://github.com/owner/repo')
  const [, owner, repo, ref] = match
  return { url: `https://github.com/${owner}/${repo}.git`, owner, repo, ref: ref ? decodeURIComponent(ref) : null }
}

/** Normalize an archive entry name; null means skip it. Throws on escapes. */
export function safeEntryPath(name: string): string | null {
  const unified = name.replace(/\\/g, '/')
  if (unified.endsWith('/')) return null
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) throw new ImportError(`archive entry uses an absolute path: ${name}`)
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) throw new ImportError(`archive entry escapes its folder: ${name}`)
  if (parts.some((p) => SKIP_DIRS.has(p))) return null
  if (parts.length === 0) return null
  return parts.join('/')
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

function git(args: string[], cwd: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.symlinks=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } },
      (err, stdout, stderr) => {
        if (err) reject(new ImportError(`git ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`))
        else resolve(stdout.trim())
      },
    )
  })
}

export class Importer {
  constructor(
    private readonly store: QaStore,
    private readonly root: string,
    private readonly limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
  ) {
    mkdirSync(root, { recursive: true })
  }

  async importGithub(rawUrl: string, ref: string | null): Promise<Target> {
    const parsed = parseGithubUrl(rawUrl)
    const branch = ref?.trim() || parsed.ref
    if (branch && !/^[A-Za-z0-9_./-]{1,200}$/.test(branch)) throw new ImportError('That branch or tag name has characters git refs cannot use')
    const scratch = mkdtempSync(join(tmpdir(), 'qadna-clone-'))
    try {
      const dest = join(scratch, 'repo')
      await git(['clone', '--depth', '1', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : []), '--', parsed.url, dest], scratch)
      const commit = await git(['rev-parse', 'HEAD'], dest, 15_000)
      return this.importDirectory(parsed.repo, dest, { kind: 'github', url: `https://github.com/${parsed.owner}/${parsed.repo}`, ref: branch ?? null }, commit)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  importZip(fileName: string, data: Uint8Array): Target {
    if (data.byteLength === 0) throw new ImportError('The ZIP file is empty')
    let count = 0
    let total = 0
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(data, {
        filter: (file) => {
          const path = safeEntryPath(file.name)
          if (path === null) return false
          count += 1
          total += file.originalSize
          if (count > this.limits.maxFiles) throw new ImportError(`The ZIP has more than ${this.limits.maxFiles} files`)
          if (file.originalSize > this.limits.maxFileBytes) throw new ImportError(`${file.name} is larger than ${this.limits.maxFileBytes / 1024 / 1024} MB`)
          if (total > this.limits.maxTotalBytes) throw new ImportError(`The ZIP unpacks to more than ${this.limits.maxTotalBytes / 1024 / 1024} MB`)
          return true
        },
      })
    } catch (err) {
      if (err instanceof ImportError) throw err
      throw new ImportError(`Could not read the ZIP: ${err instanceof Error ? err.message : String(err)}`)
    }
    const files = Object.entries(entries)
      .map(([name, bytes]) => ({ path: safeEntryPath(name), bytes }))
      .filter((f): f is { path: string; bytes: Uint8Array } => f.path !== null)
    if (files.length === 0) throw new ImportError('The ZIP has no files to test')

    // GitHub's "Download ZIP" wraps everything in one folder; drop it.
    const firstSegments = new Set(files.map((f) => f.path.split('/')[0]))
    const wrapped = firstSegments.size === 1 && files.every((f) => f.path.includes('/'))
    const prefix = wrapped ? `${[...firstSegments][0]}/` : ''
    const baseName = fileName.replace(/\.zip$/i, '').replace(/[^\w.-]+/g, '-') || 'app'
    const name = wrapped ? [...firstSegments][0] : baseName

    const target = this.store.createTarget({ name, source: { kind: 'zip', fileName } })
    const snapshotId = this.store.id('snap')
    const dest = join(this.root, target.id, snapshotId)
    for (const f of files) {
      const rel = f.path.slice(prefix.length)
      const out = join(dest, ...rel.split('/'))
      if (!out.startsWith(dest + sep)) throw new ImportError(`archive entry escapes its folder: ${f.path}`)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, f.bytes)
    }
    this.recordSnapshot(target, snapshotId, dest, null)
    return this.store.getTarget(target.id)
  }

  /** Copy a directory (a clone, or the bundled sample) into a new snapshot. */
  importDirectory(name: string, sourceDir: string, source: TargetSource, commitSha: string | null): Target {
    const target = this.store.createTarget({ name, source })
    const snapshotId = this.store.id('snap')
    const dest = join(this.root, target.id, snapshotId)
    mkdirSync(dest, { recursive: true })
    let count = 0
    let total = 0
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue
        const from = join(dir, entry.name)
        const stat = lstatSync(from)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          walk(from)
        } else if (stat.isFile()) {
          if (stat.size > this.limits.maxFileBytes) continue
          count += 1
          total += stat.size
          if (count > this.limits.maxFiles) throw new ImportError(`The app has more than ${this.limits.maxFiles} files`)
          if (total > this.limits.maxTotalBytes) throw new ImportError(`The app is larger than ${this.limits.maxTotalBytes / 1024 / 1024} MB`)
          const to = join(dest, relative(sourceDir, from))
          mkdirSync(dirname(to), { recursive: true })
          cpSync(from, to)
        }
      }
    }
    walk(sourceDir)
    this.recordSnapshot(target, snapshotId, dest, commitSha)
    return this.store.getTarget(target.id)
  }

  private recordSnapshot(target: Target, snapshotId: string, dest: string, commitSha: string | null): Snapshot {
    const files = listFiles(dest)
    const hash = createHash('sha256')
    let bytes = 0
    for (const rel of files) {
      const data = readFileSync(join(dest, ...rel.split('/')))
      bytes += data.byteLength
      hash.update(`${rel}\0${sha256(data)}\n`)
    }
    return this.store.addSnapshot({
      id: snapshotId,
      targetId: target.id,
      rootPath: dest,
      contentHash: hash.digest('hex'),
      commitSha,
      fileCount: files.length,
      bytes,
      stack: detectStack(dest, files),
    })
  }
}

/** Sorted relative POSIX paths of regular files under `root` (no symlinks). */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) out.push(relative(root, full).split(sep).join(posix.sep))
    }
  }
  walk(root)
  return out.sort()
}
