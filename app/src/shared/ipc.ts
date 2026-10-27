/** Typed renderer/host boundary. Query responses never contain credentials. */
import type { AccountStatus, Artifact, AuditConfig, Challenge, Claim, ClaimReview, DnaVersion, ReportVersion, ReviewDecision, Roster, Run, RuleChange, RuntimeId, RuntimeSettings, Target, Task, TestAccount, TestMode, Verification, WorkerProfile } from './domain'
import type { Envelope } from './events'
export type Result<T> = { ok: true; value: T } | { ok: false; error: { name: string; message: string } }
export type Finding = Claim & { challenges: Challenge[]; verifications: Verification[]; review: ClaimReview | null }
export interface RunDetail {
  run: Run
  tasks: Task[]
  claims: Finding[]
  report: ReportVersion | null
  reports: ReportVersion[]
  ruleChanges: RuleChange[]
  sampleScore: { knownBugs: number; matchedBugs: number; matches: { title: string; found: boolean }[] } | null
}
export interface ArtifactContent { artifact: Artifact; text: string | null; verified: boolean; error: string | null }
export interface ReviewItem { claim: Finding; run: Run }
export interface DnaOverview {
  current: DnaVersion
  history: DnaVersion[]
  pending: (RuleChange & { targetName: string })[]
  decided: (RuleChange & { targetName: string })[]
}
export interface Overview { operator: string; targets: Target[]; knowledgeDocs: number }
export interface FileEntry { path: string; type: 'file' | 'dir'; bytes: number }
export interface Queries {
  overview: { args: void; result: Overview }
  targetFiles: { args: { snapshotId: string }; result: FileEntry[] }
  targetSetup: { args: { targetId: string }; result: { target: Target; accounts: TestAccount[]; knowledgeDocs: number } }
  listRuns: { args: void; result: Run[] }
  runDetail: { args: { runId: string }; result: RunDetail }
  findings: { args: void; result: ReviewItem[] }
  artifact: { args: { artifactId: string }; result: ArtifactContent }
  reviewQueue: { args: void; result: ReviewItem[] }
  dna: { args: void; result: DnaOverview }
  accounts: { args: void; result: AccountStatus[] }
  activeLogins: { args: void; result: LoginUpdate[] }
  settings: { args: void; result: RuntimeSettings }
  events: { args: { runId: string | null; afterSeq: number }; result: StreamWindow }
}
export type QueryName = keyof Queries
export type Command =
  | { type: 'importGithub'; url: string; ref: string | null }
  | { type: 'importZip'; fileName: string; data: Uint8Array }
  | { type: 'chooseZip' }
  | { type: 'startRun'; idempotencyKey: string; targetId: string; mode: TestMode; externalUrl: string | null; allowCommands: boolean; audit: AuditConfig; roster: Roster; contenders?: WorkerProfile[] }
  | { type: 'pauseRun'; runId: string }
  | { type: 'resumeRun'; runId: string }
  | { type: 'cancelRun'; runId: string }
  | { type: 'reviewClaim'; claimId: string; decision: ReviewDecision; reason: string }
  | { type: 'decideRuleChange'; changeId: string; decision: 'accepted' | 'rejected'; reason: string }
  | { type: 'setTestAccount'; targetId: string; name: string; headerName: string; headerValue: string }
  | { type: 'removeTestAccount'; targetId: string; name: string }
  | { type: 'saveSettings'; settings: RuntimeSettings }
  | { type: 'exportReport'; runId: string }
  | { type: 'exportArtifact'; artifactId: string }
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
  setTestAccount: { saved: boolean }
  removeTestAccount: { removed: boolean }
  saveSettings: RuntimeSettings
  exportReport: { path: string | null }
  exportArtifact: { path: string | null }
  startLogin: { sessionId: string }
  sendLoginInput: { sent: boolean }
  cancelLogin: { cancelled: boolean }
  openLoginUrl: { opened: boolean }
  logout: AccountStatus
}
export interface StreamWindow { events: Envelope[]; highWaterSeq: number; complete: boolean }
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
  subscribe(runId: string | null, afterSeq: number, onEvents: (events: Envelope[]) => void): Promise<{ subId: string; window: StreamWindow }>
  unsubscribe(subId: string): Promise<void>
  onLoginUpdate(listener: (update: LoginUpdate) => void): () => void
  platform: string
}
declare global { interface Window { qa: QaBridge } }
