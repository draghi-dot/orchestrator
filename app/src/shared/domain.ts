/**
 * QA DNA domain vocabulary, shared by the control plane (main process), the
 * renderer, and tests. Pure types and constants only: no I/O.
 *
 * An imported app is tested by five workers. Findings are claims; a claim
 * counts only when the host can reproduce it, and every claim is challenged
 * by another worker before it is settled. The rules the workers follow are
 * the team's DNA, which the Improver proposes changes to after each run.
 */

// ------------------------------------------------------------------ targets

export type TargetSource =
  | { kind: 'github'; url: string; ref: string | null }
  | { kind: 'zip'; fileName: string }
  | { kind: 'sample' }

export interface StackInfo {
  languages: { name: string; files: number }[]
  frameworks: string[]
  packageManager: string | null
  commands: { install: string | null; start: string | null; test: string | null }
  readmeExcerpt: string | null
  topLevel: string[]
}

export interface Snapshot {
  id: string
  targetId: string
  rootPath: string
  contentHash: string
  commitSha: string | null
  fileCount: number
  bytes: number
  stack: StackInfo
  createdAt: string
}

export interface Target {
  id: string
  name: string
  source: TargetSource
  createdAt: string
  latestSnapshot: Snapshot | null
}

// ------------------------------------------------------------------ workers

export const ROLES = ['builder', 'researcher', 'thinker', 'reporter', 'improver'] as const
export type Role = (typeof ROLES)[number]

export const PHASES = ['build', 'research', 'challenge', 'report', 'improve'] as const
export type Phase = (typeof PHASES)[number]

export const PHASE_ROLE: Record<Phase, Role> = {
  build: 'builder',
  research: 'researcher',
  challenge: 'thinker',
  report: 'reporter',
  improve: 'improver',
}

export const ROLE_LABEL: Record<Role, string> = {
  builder: 'Builder',
  researcher: 'Researcher',
  thinker: 'Thinker',
  reporter: 'Reporter',
  improver: 'Improver',
}

export const PHASE_LABEL: Record<Phase, string> = {
  build: 'Build',
  research: 'Research',
  challenge: 'Challenge',
  report: 'Report',
  improve: 'Improve',
}

export type RuntimeId = 'claude' | 'codex' | 'omp' | 'offline'

export const RUNTIME_LABEL: Record<RuntimeId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  omp: 'oh-my-pi',
  offline: 'Offline',
}

export interface WorkerProfile {
  runtime: RuntimeId
  /** Model alias or id for the runtime; empty uses the runtime's default. */
  model: string
}

export type Roster = Record<Role, WorkerProfile>

/** white: source code only. black: the running app only. both: everything. */
export type TestMode = 'white' | 'black' | 'both'

export const MODE_LABEL: Record<TestMode, string> = {
  white: 'White box',
  black: 'Black box',
  both: 'White and black box',
}

// --------------------------------------------------------------------- runs

export type RunState =
  | 'queued'
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled'])

export type TaskStatus = 'running' | 'done' | 'blocked' | 'error' | 'cancelled'

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'blocked', 'error', 'cancelled'])

export interface RunLimits {
  maxClaims: number
  taskTimeoutSeconds: Record<Role, number>
  toolBudget: Record<Role, number>
}

/** Frozen when a run starts and hashed. Reusing an idempotency key with a
 * different contract is rejected. */
export interface RunContract {
  targetId: string
  targetName: string
  snapshotId: string
  snapshotHash: string
  mode: TestMode
  /** Optional deployed copy for black-box testing instead of a local build. */
  externalUrl: string | null
  /** Whether the Builder may run install/build/start commands on this machine. */
  allowCommands: boolean
  roster: Roster
  dnaVersionId: string
  initiator: string
  limits: RunLimits
}

export interface RunSummary {
  claims: number
  confirmed: number
  refuted: number
  disputed: number
  unverified: number
  open: number
  ruleChanges: number
}

export interface Run {
  id: string
  idempotencyKey: string
  contractHash: string
  contract: RunContract
  state: RunState
  terminalReason: string | null
  summary: RunSummary | null
  appUrl: string | null
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface Task {
  id: string
  runId: string
  role: Role
  phase: Phase
  ordinal: number
  attemptNumber: number
  runtime: RuntimeId
  workerId: string
  ownerGeneration: number
  status: TaskStatus
  terminalReason: string | null
  startedAt: string
  endedAt: string | null
  lastHeartbeatAt: string | null
}

// ------------------------------------------------------------------- claims

export type Severity = 'high' | 'medium' | 'low'

export type CheckKind = 'status_equals' | 'body_contains' | 'json_equals'

/** What a correct app returns. A claim says the app fails this check. */
export interface Check {
  kind: CheckKind
  path?: string
  expected: string | number | boolean | null
}

export interface ReproStep {
  method: string
  path: string
  body?: string
}

export interface Reproduction {
  steps: ReproStep[]
  check: Check
}

export type ClaimStatus = 'open' | 'confirmed' | 'refuted' | 'disputed' | 'unverified'

export type Stance = 'agree' | 'dispute' | 'unsure'

export type ReplayOutcome = 'reproduced' | 'not_reproduced' | 'error' | 'no_repro'

export interface Claim {
  id: string
  runId: string
  taskId: string
  role: Role
  runtime: RuntimeId
  title: string
  detail: string
  severity: Severity
  area: 'white' | 'black'
  location: string | null
  reproduction: Reproduction | null
  status: ClaimStatus
  verdictReason: string | null
  createdAt: string
}

export interface Challenge {
  id: string
  claimId: string
  taskId: string
  runtime: RuntimeId
  stance: Stance
  reasoning: string
  createdAt: string
}

export interface Replay {
  claimId: string
  outcome: ReplayOutcome
  detail: string
  artifactId: string | null
  createdAt: string
}

export type ReviewDecision = 'accepted' | 'rejected'

export interface ClaimReview {
  id: string
  claimId: string
  decision: ReviewDecision
  reason: string
  reviewer: string
  createdAt: string
}

// ---------------------------------------------------------------------- DNA

export interface DnaRule {
  id: string
  role: Role | 'all'
  text: string
  /** Where the rule came from: the seed set or a run's Improver. */
  origin: { runId: string | null; runtime: RuntimeId | null }
  addedInVersion: number
}

export interface DnaVersion {
  id: string
  version: number
  rules: DnaRule[]
  parentId: string | null
  note: string
  createdBy: string
  createdAt: string
}

export type RuleChangeStatus = 'proposed' | 'accepted' | 'rejected'

export interface RuleChange {
  id: string
  runId: string
  taskId: string
  runtime: RuntimeId
  op: 'add' | 'remove'
  ruleId: string | null
  role: Role | 'all'
  text: string
  rationale: string
  status: RuleChangeStatus
  decidedBy: string | null
  decisionReason: string | null
  decidedAt: string | null
  createdAt: string
}

// ----------------------------------------------------------------- evidence

export interface Artifact {
  id: string
  sha256: string
  runId: string
  taskId: string | null
  mime: string
  bytes: number
  label: string
  redaction: 'none' | 'headers_redacted'
  createdAt: string
}

export interface ReportVersion {
  id: string
  runId: string
  taskId: string | null
  version: number
  author: string
  markdown: string
  createdAt: string
}

// ------------------------------------------------------------------ accounts

export interface RuntimeSettings {
  claudeCommand: string
  codexCommand: string
  ompCommand: string
  defaultRoster: Roster
}

export interface AccountStatus {
  runtime: Exclude<RuntimeId, 'offline'>
  installed: boolean
  path: string | null
  version: string | null
  signedIn: boolean
  /** Who is signed in and how, as the CLI reports it (never a token). */
  account: string | null
  error: string | null
}

export const DEFAULT_LIMITS: RunLimits = {
  maxClaims: 12,
  taskTimeoutSeconds: { builder: 600, researcher: 600, thinker: 480, reporter: 240, improver: 240 },
  toolBudget: { builder: 40, researcher: 60, thinker: 50, reporter: 8, improver: 10 },
}
