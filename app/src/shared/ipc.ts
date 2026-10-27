/**
 * The renderer <-> control-plane contract. The renderer never calls a model,
 * never sees a credential, and never touches the database: it sends explicit
 * commands and reads server facts.
 */

import type {
  AccountStatus,
  Artifact,
  Challenge,
  Claim,
  ClaimReview,
  DnaVersion,
  Replay,
  ReportVersion,
  ReviewDecision,
  Roster,
  Run,
  RuleChange,
  RuntimeId,
  RuntimeSettings,
  Target,
  Task,
  TestMode,
} from './domain'
import type { Envelope } from './events'

export type Result<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } }

export interface RunDetail {
  run: Run
  tasks: Task[]
  claims: (Claim & { challenges: Challenge[]; replay: Replay | null; review: ClaimReview | null })[]
  report: ReportVersion | null
  ruleChanges: RuleChange[]
}

export interface ArtifactContent {
  artifact: Artifact
  text: string | null
  verified: boolean
  error: string | null
}

export interface ReviewItem {
  claim: Claim
  run: Run
  challenges: Challenge[]
  replay: Replay | null
}

export interface DnaOverview {
  current: DnaVersion
  history: DnaVersion[]
  pending: (RuleChange & { targetName: string })[]
  decided: (RuleChange & { targetName: string })[]
}

export interface Overview {
  operator: string
  targets: Target[]
}

export interface FileEntry {
  path: string
  type: 'file' | 'dir'
  bytes: number
}

export interface Queries {
  overview: { args: void; result: Overview }
  targetFiles: { args: { snapshotId: string }; result: FileEntry[] }
  listRuns: { args: void; result: Run[] }
  runDetail: { args: { runId: string }; result: RunDetail }
  artifact: { args: { artifactId: string }; result: ArtifactContent }
  reviewQueue: { args: void; result: ReviewItem[] }
  dna: { args: void; result: DnaOverview }
  accounts: { args: void; result: AccountStatus[] }
  settings: { args: void; result: RuntimeSettings }
}

export type QueryName = keyof Queries

export type Command =
  | { type: 'importGithub'; url: string; ref: string | null }
  | { type: 'importZip'; fileName: string; data: Uint8Array }
  | { type: 'chooseZip' }
  | {
      type: 'startRun'
      idempotencyKey: string
      targetId: string
      mode: TestMode
      externalUrl: string | null
      allowCommands: boolean
      roster: Roster
    }
  | { type: 'pauseRun'; runId: string }
  | { type: 'resumeRun'; runId: string }
  | { type: 'cancelRun'; runId: string }
  | { type: 'reviewClaim'; claimId: string; decision: ReviewDecision; reason: string }
  | { type: 'decideRuleChange'; changeId: string; decision: 'accepted' | 'rejected'; reason: string }
  | { type: 'saveSettings'; settings: RuntimeSettings }
  | { type: 'exportReport'; runId: string }
  | { type: 'startLogin'; runtime: Exclude<RuntimeId, 'offline'> }
  | { type: 'sendLoginInput'; sessionId: string; text: string }
  | { type: 'cancelLogin'; sessionId: string }
  | { type: 'openLoginUrl'; sessionId: string }
  | { type: 'logout'; runtime: Exclude<RuntimeId, 'offline'> }

export interface CommandResults {
  importGithub: { targetId: string }
  importZip: { targetId: string }
  chooseZip: { targetId: string | null }
  startRun: { runId: string; created: boolean }
  pauseRun: { state: string }
  resumeRun: { state: string }
  cancelRun: { state: string }
  reviewClaim: { reviewId: string }
  decideRuleChange: { dnaVersion: number | null }
  saveSettings: RuntimeSettings
  exportReport: { path: string | null }
  startLogin: { sessionId: string }
  sendLoginInput: { sent: boolean }
  cancelLogin: { cancelled: boolean }
  openLoginUrl: { opened: boolean }
  logout: AccountStatus
}

export interface StreamWindow {
  events: Envelope[]
  highWaterSeq: number
  complete: boolean
}

/** Progress of an in-app sign-in, streamed from the runtime's own CLI. */
export interface LoginUpdate {
  sessionId: string
  runtime: Exclude<RuntimeId, 'offline'>
  lines: string[]
  url: string | null
  state: 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  message: string | null
}

export interface QaBridge {
  query<K extends QueryName>(name: K, args: Queries[K]['args']): Promise<Result<Queries[K]['result']>>
  command<C extends Command>(command: C): Promise<Result<CommandResults[C['type']]>>
  /** Catch-up window for (runId, afterSeq) is returned; later events arrive
   * through `onEvents`. Subscription and catch-up happen in one tick on the
   * control plane, so nothing committed in between is missed. */
  subscribe(runId: string | null, afterSeq: number, onEvents: (events: Envelope[]) => void): Promise<{ subId: string; window: StreamWindow }>
  unsubscribe(subId: string): Promise<void>
  onLoginUpdate(listener: (update: LoginUpdate) => void): () => void
  platform: string
}

declare global {
  interface Window {
    qa: QaBridge
  }
}
