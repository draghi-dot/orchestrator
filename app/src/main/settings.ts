import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Roster, RuntimeId, RuntimeSettings } from '../shared/domain'
import { ROLES } from '../shared/domain'

export const OFFLINE_ROSTER: Roster = {
  builder: { runtime: 'offline', model: '' },
  researcher: { runtime: 'offline', model: '' },
  thinker: { runtime: 'offline', model: '' },
  reporter: { runtime: 'offline', model: '' },
  improver: { runtime: 'offline', model: '' },
}

/** Researcher and Thinker on different vendors, so every finding is
 * cross-examined by a different model. */
export const ARENA_ROSTER: Roster = {
  builder: { runtime: 'offline', model: '' },
  researcher: { runtime: 'codex', model: '' },
  thinker: { runtime: 'claude', model: '' },
  reporter: { runtime: 'claude', model: '' },
  improver: { runtime: 'codex', model: '' },
}

export const DEFAULT_SETTINGS: RuntimeSettings = {
  claudeCommand: 'claude',
  codexCommand: 'codex',
  ompCommand: 'omp',
  defaultRoster: ARENA_ROSTER,
  knowledgePath: '',
}

const RUNTIMES: RuntimeId[] = ['claude', 'codex', 'omp', 'offline']
const MODEL = /^[A-Za-z0-9@._:/-]{0,80}$/

export function sanitizeSettings(input: Partial<RuntimeSettings>): RuntimeSettings {
  const command = (value: string | undefined, fallback: string) => {
    const v = (value ?? '').trim()
    return v && !/[\n\r]/.test(v) ? v : fallback
  }
  const roster = { ...DEFAULT_SETTINGS.defaultRoster }
  for (const role of ROLES) {
    const p = input.defaultRoster?.[role]
    if (p && RUNTIMES.includes(p.runtime)) roster[role] = { runtime: p.runtime, model: MODEL.test(p.model ?? '') ? (p.model ?? '').trim() : '' }
  }
  return {
    claudeCommand: command(input.claudeCommand, DEFAULT_SETTINGS.claudeCommand),
    codexCommand: command(input.codexCommand, DEFAULT_SETTINGS.codexCommand),
    ompCommand: command(input.ompCommand, DEFAULT_SETTINGS.ompCommand),
    defaultRoster: roster,
    knowledgePath: typeof input.knowledgePath === 'string' ? input.knowledgePath.trim() : '',
  }
}

export function sanitizeRoster(input: Partial<Roster> | undefined): Roster {
  return sanitizeSettings({ defaultRoster: { ...OFFLINE_ROSTER, ...(input ?? {}) } as Roster }).defaultRoster
}

export class SettingsStore {
  private readonly path: string
  private current: RuntimeSettings

  constructor(dir: string) {
    this.path = join(dir, 'runtime-settings.json')
    let loaded: Partial<RuntimeSettings> = {}
    try {
      if (existsSync(this.path)) loaded = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      loaded = {}
    }
    this.current = sanitizeSettings({ ...DEFAULT_SETTINGS, ...loaded })
  }

  get(): RuntimeSettings {
    return structuredClone(this.current)
  }

  save(next: Partial<RuntimeSettings>): RuntimeSettings {
    this.current = sanitizeSettings({ ...this.current, ...next })
    writeFileSync(this.path, JSON.stringify(this.current, null, 2))
    return this.get()
  }
}

/** GUI-launched apps on macOS get a minimal PATH; also look where the
 * Claude, Codex, and oh-my-pi installers put their binaries. */
export function resolveCommand(command: string): string | null {
  const executable = (p: string) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (isAbsolute(command)) return executable(command) ? command : null
  const home = homedir()
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.bun', 'bin'),
    join(home, '.omp', 'bin'),
    join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, command)
    if (executable(candidate)) return candidate
  }
  return null
}
