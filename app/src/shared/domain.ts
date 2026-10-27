/**
 * QA Arena domain vocabulary, shared by the control plane (main process), the
 * renderer, and tests. Pure types and constants only: no I/O.
 *
 * An imported app is audited by five workers. Findings are claims; a claim is
 * confirmed only by grounded evidence (a host replay of its reproduction, or
 * a verified code citation) plus a challenger who agrees. Everything else is
 * rejected, inconclusive, or waits for a person. The rules the workers follow
 * are the team's DNA, which the Improver proposes changes to after each run.
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
  /** Routes found by reading the code (best effort). */
  routes: { method: string; path: string; location: string }[]
  tests: { files: number; runner: string | null }
  /** Risky areas found, with the files that point to them. */
  areas: { id: AreaId; files: string[] }[]
  /** Files that look like they hold secrets. Names only, never contents. */
  sensitive: string[]
  /** The README describes accounts meant for testing. */
  mentionsTestAccounts: boolean
}

export type AreaId = 'auth' | 'payments' | 'admin' | 'upload' | 'data' | 'api'

export const AREA_LABEL: Record<AreaId, string> = {
  auth: 'Sign-in and sessions',
  payments: 'Cart, prices, and payments',
  admin: 'Admin and roles',
  upload: 'File upload',
  data: 'Data access and storage',
  api: 'API endpoints',
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
  maxRounds: number
  taskTimeoutSeconds: Record<Role, number>
  toolBudget: Record<Role, number>
}

export type Depth = 'fast' | 'balanced' | 'deep'
export type Focus = 'correctness' | 'security' | 'api_contracts' | 'regression'

export const FOCUS_LABEL: Record<Focus, string> = {
  correctness: 'Correctness',
  security: 'Security',
  api_contracts: 'API contracts',
  regression: 'Regression tests',
}

/** The answers to the audit setup questions, frozen into the run contract. */
export interface AuditConfig {
  areas: (AreaId | 'whole_app')[]
  focus: Focus[]
  depth: Depth
  excludedPaths: string[]
  /** Names of approved test accounts. Their credentials never leave the host. */
  accounts: string[]
  useKnowledge: boolean
  instructions: string
}

/** Frozen when a run starts and hashed. Reusing an idempotency key with a
 * different contract is rejected. */
export interface RunContract {
  targetId: string
  targetName: string
  snapshotId: string
  snapshotHash: string
  commitSha: string | null
  mode: TestMode
  /** Optional authorized deployment for black-box testing instead of a local build. */
  externalUrl: string | null
  /** Whether the Builder may run install/build/start commands on this machine. */
  allowCommands: boolean
  audit: AuditConfig
  roster: Roster
  dnaVersionId: string
  initiator: string
  limits: RunLimits
}

export interface RunSummary {
  claims: number
  confirmed: number
  rejected: number
  inconclusive: number
  needs_review: number
  candidate: number
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

export type Category = 'business_logic' | 'authorization' | 'authentication' | 'input_validation' | 'injection' | 'data_exposure' | 'error_handling' | 'api_contract' | 'other'

export const CATEGORY_LABEL: Record<Category, string> = {
  business_logic: 'Business logic',
  authorization: 'Authorization',
  authentication: 'Authentication',
  input_validation: 'Input validation',
  injection: 'Injection',
  data_exposure: 'Data exposure',
  error_handling: 'Error handling',
  api_contract: 'API contract',
  other: 'Other',
}

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
  /** Noncredential request headers, replayed exactly by the host. */
  headers?: Record<string, string>
  /** Name of an approved test account to send this request as. */
  as?: string
}

export interface Reproduction {
  steps: ReproStep[]
  check: Check
}

/** candidate: not settled yet. needs_review: evidence holds but the
 * challenger objects, so a person decides. */
export type ClaimStatus = 'candidate' | 'confirmed' | 'rejected' | 'inconclusive' | 'needs_review'

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  candidate: 'Candidate',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  inconclusive: 'Inconclusive',
  needs_review: 'Needs review',
}

export type Stance = 'agree' | 'dispute' | 'unsure'

/** What the host's own check found, independent of any agent. */
export type EvidenceOutcome = 'reproduced' | 'not_reproduced' | 'code_verified' | 'code_missing' | 'error' | 'no_evidence'

export interface Claim {
  id: string
  runId: string
  taskId: string
  role: Role
  runtime: RuntimeId
  title: string
  detail: string
  category: Category
  severity: Severity
  severityRationale: string
  area: 'white' | 'black'
  location: string | null
  /** Exact source lines that show the defect, for code findings. */
  evidenceQuote: string | null
  reproduction: Reproduction | null
  suggestedFix: string | null
  status: ClaimStatus
  verdictReason: string | null
  round: number
  withdrawn: boolean
  regressionTestArtifactId: string | null
  createdAt: string
}

export interface Challenge {
  id: string
  claimId: string
  taskId: string
  runtime: RuntimeId
  round: number
  stance: Stance
  reasoning: string
  createdAt: string
}

export interface Verification {
  claimId: string
  round: number
  outcome: EvidenceOutcome
  expected: string | null
  actual: string | null
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

export interface TestAccount {
  name: string
  headerName: string
  /** Shown to the renderer as configured or not; the value stays in the host. */
  configured: boolean
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
  /** Folder of Markdown writeups the Researcher and Thinker may search. */
  knowledgePath: string
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

export const DEPTH_LIMITS: Record<Depth, RunLimits> = {
  fast: {
    maxClaims: 6,
    maxRounds: 1,
    taskTimeoutSeconds: { builder: 420, researcher: 360, thinker: 300, reporter: 180, improver: 180 },
    toolBudget: { builder: 30, researcher: 35, thinker: 30, reporter: 6, improver: 8 },
  },
  balanced: {
    maxClaims: 10,
    maxRounds: 2,
    taskTimeoutSeconds: { builder: 600, researcher: 600, thinker: 480, reporter: 240, improver: 240 },
    toolBudget: { builder: 40, researcher: 60, thinker: 50, reporter: 8, improver: 10 },
  },
  deep: {
    maxClaims: 16,
    maxRounds: 3,
    taskTimeoutSeconds: { builder: 900, researcher: 1200, thinker: 900, reporter: 300, improver: 300 },
    toolBudget: { builder: 60, researcher: 120, thinker: 90, reporter: 10, improver: 12 },
  },
}

export const DEFAULT_LIMITS: RunLimits = DEPTH_LIMITS.balanced

export const DEFAULT_AUDIT: AuditConfig = {
  areas: ['whole_app'],
  focus: ['correctness', 'security'],
  depth: 'balanced',
  excludedPaths: [],
  accounts: [],
  useKnowledge: true,
  instructions: '',
}
