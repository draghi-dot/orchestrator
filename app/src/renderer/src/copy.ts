/**
 * Every user-facing name in one place. The engine keeps its internal ids
 * (researcher, thinker, claim, ...); the interface always says the same
 * plain word for the same idea.
 */

import type { AreaId, Category, ClaimStatus, Depth, EvidenceOutcome, Focus, Phase, Role, RunState, RuntimeId, Stance, TaskStatus, TestMode } from '../../shared/domain'
import type { PhaseStatus } from '../../shared/fold'

export const APP_NAME = 'Baton'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline'

export const AGENT: Record<Role, { name: string; title: string; job: string }> = {
  builder: { name: 'Build', title: 'Build agent', job: 'Installs and starts the app so it can be tested.' },
  researcher: { name: 'Test', title: 'Test agent', job: 'Explores the code and the running app, and reports findings.' },
  thinker: { name: 'Review', title: 'Review agent', job: 'Checks every finding independently and disputes weak ones.' },
  reporter: { name: 'Report', title: 'Report agent', job: 'Writes the audit report as results come in.' },
  improver: { name: 'Learn', title: 'Learn agent', job: 'Suggests playbook changes from what went wrong.' },
}

export const STEP: Record<Phase, { name: string; role: Role }> = {
  build: { name: 'Build', role: 'builder' },
  research: { name: 'Test', role: 'researcher' },
  challenge: { name: 'Review', role: 'thinker' },
  report: { name: 'Report', role: 'reporter' },
  improve: { name: 'Learn', role: 'improver' },
}

export const PROVIDER: Record<RuntimeId, { name: string; hint: string }> = {
  claude: { name: 'Claude', hint: 'Claude Code, signed in on this Mac' },
  codex: { name: 'Codex', hint: 'Codex CLI, signed in on this Mac' },
  omp: { name: 'oh-my-pi', hint: 'oh-my-pi CLI' },
  offline: { name: 'Built-in', hint: 'Fixed checks, no AI model' },
}

export const METHOD: Record<TestMode, { name: string; hint: string }> = {
  white: { name: 'Code review', hint: 'Agents read the source. Nothing is run.' },
  black: { name: 'Live app', hint: 'Agents use the running app and never see the code.' },
  both: { name: 'Code and live app', hint: 'Code to find suspects, the running app to prove them.' },
}

export const DEPTH: Record<Depth, string> = { fast: 'Fast', balanced: 'Balanced', deep: 'Deep' }

export const FOCUS: Record<Focus, { name: string; hint: string }> = {
  correctness: { name: 'Correctness', hint: 'Wrong results, broken rules, edge cases' },
  security: { name: 'Security', hint: 'Access control, injection, data exposure' },
  api_contracts: { name: 'API contracts', hint: 'Status codes, response shapes, validation' },
  regression: { name: 'Regression tests', hint: 'A runnable test for every confirmed finding' },
}

export const AREA: Record<AreaId | 'whole_app', string> = {
  auth: 'Sign-in and sessions',
  payments: 'Cart, prices, and payments',
  admin: 'Admin and roles',
  upload: 'File upload',
  data: 'Data access',
  api: 'API endpoints',
  whole_app: 'Whole app',
}

export const CATEGORY: Record<Category, string> = {
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

export const FINDING_STATUS: Record<ClaimStatus, { label: string; tone: Tone; hint: string }> = {
  candidate: { label: 'Pending', tone: 'outline', hint: 'Waiting for review and verification.' },
  confirmed: { label: 'Confirmed', tone: 'danger', hint: 'Reproduced or verified, and the review agent agreed.' },
  rejected: { label: 'False positive', tone: 'neutral', hint: 'The evidence showed the app behaves correctly.' },
  inconclusive: { label: 'Unverified', tone: 'neutral', hint: 'There was no evidence Baton could check.' },
  needs_review: { label: 'Needs review', tone: 'warning', hint: 'The evidence holds, but the review agent objected.' },
}

export const AUDIT_STATE: Record<RunState | 'unknown', { label: string; tone: Tone }> = {
  unknown: { label: 'Loading', tone: 'outline' },
  queued: { label: 'Queued', tone: 'outline' },
  running: { label: 'Running', tone: 'accent' },
  pause_requested: { label: 'Pausing', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warning' },
  cancel_requested: { label: 'Stopping', tone: 'warning' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
}

export const AGENT_STATE: Record<TaskStatus | 'waiting', { label: string; tone: Tone }> = {
  waiting: { label: 'Waiting', tone: 'outline' },
  running: { label: 'Working', tone: 'accent' },
  done: { label: 'Done', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
}

export const STEP_STATE: Record<PhaseStatus, string> = {
  waiting: 'Waiting',
  running: 'In progress',
  done: 'Done',
  skipped: 'Skipped',
  blocked: 'Blocked',
  error: 'Error',
  cancelled: 'Stopped',
}

export const EVIDENCE: Record<EvidenceOutcome, { label: string; tone: Tone }> = {
  reproduced: { label: 'Reproduced by replay', tone: 'danger' },
  not_reproduced: { label: 'Could not reproduce', tone: 'neutral' },
  code_verified: { label: 'Code reference verified', tone: 'danger' },
  code_missing: { label: 'Code reference not found', tone: 'neutral' },
  error: { label: 'Check failed', tone: 'warning' },
  no_evidence: { label: 'Nothing to check', tone: 'neutral' },
}

export const STANCE: Record<Stance, { label: string; tone: Tone }> = {
  agree: { label: 'Agreed', tone: 'success' },
  dispute: { label: 'Disputed', tone: 'warning' },
  unsure: { label: 'Unsure', tone: 'neutral' },
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
