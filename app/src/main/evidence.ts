/**
 * Content-addressed, immutable evidence store (after Kestrel's
 * evidence_store/filesystem.py). Blobs live at `<root>/<sha256>`. Reads
 * re-hash the bytes so a tampered or truncated blob is reported, not served.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class UnknownEvidenceError extends Error {
  constructor(sha256: string) {
    super(`unknown evidence: ${sha256}`)
    this.name = 'UnknownEvidenceError'
  }
}

export class EvidenceIntegrityError extends Error {
  constructor(sha256: string, actual: string) {
    super(`evidence ${sha256} failed integrity check (stored bytes hash to ${actual})`)
    this.name = 'EvidenceIntegrityError'
  }
}

export const sha256Of = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export class EvidenceStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }

  private pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UnknownEvidenceError(sha256)
    return join(this.root, sha256)
  }

  put(data: Uint8Array): string {
    const digest = sha256Of(data)
    const path = this.pathFor(digest)
    if (!existsSync(path)) {
      // Write-then-rename so a crash never leaves a partial blob under its final name.
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, data)
      renameSync(tmp, path)
    }
    return digest
  }

  get(sha256: string): Buffer {
    const path = this.pathFor(sha256)
    if (!existsSync(path)) throw new UnknownEvidenceError(sha256)
    const data = readFileSync(path)
    const actual = sha256Of(data)
    if (actual !== sha256) throw new EvidenceIntegrityError(sha256, actual)
    return data
  }

  exists(sha256: string): boolean {
    return existsSync(this.pathFor(sha256))
  }
}
