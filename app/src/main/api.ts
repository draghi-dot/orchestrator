/** Host API: validates operator intent and serves durable read models. */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { Claim, RuntimeId } from '../shared/domain'
import { TERMINAL_RUN_STATES } from '../shared/domain'
import type { Command, CommandResults, Finding, Queries, QueryName, RunDetail } from '../shared/ipc'
import type { AccountManager } from './accounts'
import type { EvidenceStore } from './evidence'
import { listFiles, type Importer } from './importer'
import type { KnowledgeBase } from './knowledge'
import type { Orchestrator } from './orchestrator'
import { type SettingsStore, sanitizeRoster } from './settings'
import type { QaStore } from './store'

export class ControlPlaneApi {
  constructor(private readonly deps: {
    store: QaStore; evidence: EvidenceStore; orchestrator: Orchestrator; settings: SettingsStore;
    importer: Importer; accounts: AccountManager; operator: string; knowledge: () => KnowledgeBase | null;
    chooseZip: () => Promise<{ fileName: string; data: Uint8Array } | null>;
    saveFile: (name: string, data: Uint8Array) => Promise<string | null>;
    openUrl: (url: string) => Promise<void>;
  }) {}

  private finding(c: Claim): Finding {
    const s = this.deps.store
    return { ...c, challenges: s.listChallenges(c.id), verifications: s.listVerifications(c.id), review: s.getReview(c.id) }
  }

  async query<K extends QueryName>(name: K, args: Queries[K]['args']): Promise<Queries[K]['result']> {
    const { store, evidence, settings, accounts, knowledge } = this.deps
    const a = (args ?? {}) as Record<string, string>
    let result: unknown
    switch (name) {
      case 'overview': result = { targets: store.listTargets(), operator: this.deps.operator, knowledgeDocs: knowledge()?.size ?? 0 }; break
      case 'targetSetup': result = { target: store.getTarget(a.targetId), accounts: store.listTestAccounts(a.targetId), knowledgeDocs: knowledge()?.size ?? 0 }; break
      case 'targetFiles': {
        const snapshot = store.getSnapshot(a.snapshotId)
        result = listFiles(snapshot.rootPath).map((path) => ({ path, type: 'file', bytes: statSync(join(snapshot.rootPath, path)).size })); break
      }
      case 'listRuns': result = store.listRuns().map((r) => ({ ...r, summary: r.summary ?? store.summarize(r.id) })); break
      case 'runDetail': {
        const run = store.getRun(a.runId)
        const claims = store.listClaims(run.id).map((c) => this.finding(c))
        const known = store.listGroundTruth(run.contract.targetId)
        const matches = known.map((b) => ({ title: b.title, found: claims.some((c) => (c.status === 'confirmed' || c.review?.decision === 'accepted') && c.review?.decision !== 'rejected' && b.match.some((m) => (c.title + ' ' + c.detail).toLowerCase().includes(m.toLowerCase()))) }))
        result = { run: { ...run, summary: run.summary ?? store.summarize(run.id) }, tasks: store.listTasks(run.id), claims,
          report: store.latestReport(run.id), reports: store.listReports(run.id), ruleChanges: store.listRuleChanges({ runId: run.id }),
          sampleScore: known.length ? { knownBugs: known.length, matchedBugs: matches.filter((m) => m.found).length, matches } : null,
        } satisfies RunDetail
        break
      }
      case 'findings': result = store.listAllClaims().map((c) => ({ claim: this.finding(c), run: store.getRun(c.runId) })); break
      case 'reviewQueue': result = store.listReviewQueue().map((c) => ({ claim: this.finding(c), run: store.getRun(c.runId) })); break
      case 'artifact': {
        const artifact = store.getArtifact(a.artifactId)
        try {
          const bytes = evidence.get(artifact.sha256)
          const isText = /^(text\/|application\/(json|xml|javascript))/.test(artifact.mime)
          result = { artifact, text: isText ? bytes.subarray(0, 512 * 1024).toString('utf8') : null, verified: true, error: null }
        } catch (err) { result = { artifact, text: null, verified: false, error: String(err) } }
        break
      }
      case 'dna': {
        const changes = store.listRuleChanges().map((c) => ({ ...c, targetName: store.getRun(c.runId).contract.targetName }))
        result = { current: store.currentDna(), history: store.listDna(), pending: changes.filter((c) => c.status === 'proposed'), decided: changes.filter((c) => c.status !== 'proposed') }; break
      }
      case 'activeLogins': result = accounts.activeLogins(); break
      case 'accounts': result = await accounts.statuses(); break
      case 'settings': result = settings.get(); break
      case 'events': {
        const input = args as Queries['events']['args']
        result = store.catchUp(Math.max(0, Number(input.afterSeq) || 0), input.runId, 2000); break
      }
      default: throw new Error(`Unknown query ${String(name)}`)
    }
    return result as Queries[K]['result']
  }

  private requireIdleAccount(runtime: RuntimeId): void {
    if (this.deps.store.activeRuns().some((r) => !TERMINAL_RUN_STATES.has(r.state) && Object.values(r.contract.roster).some((p) => p.runtime === runtime))) {
      throw new Error('Finish or cancel runs using this provider before changing its sign-in')
    }
  }

  private requireIdleTarget(targetId: string): void {
    if (this.deps.store.activeRuns().some((r) => r.contract.targetId === targetId && !TERMINAL_RUN_STATES.has(r.state))) {
      throw new Error('Finish or cancel this project’s runs before changing its test accounts')
    }
  }

  async command<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
    const { store, orchestrator, settings, importer, accounts, operator } = this.deps
    let result: unknown
    switch (command.type) {
      case 'importGithub': result = { targetId: (await importer.importGithub(command.url, command.ref)).id }; break
      case 'importZip': result = { targetId: importer.importZip(command.fileName, command.data).id }; break
      case 'chooseZip': {
        const chosen = await this.deps.chooseZip()
        result = { targetId: chosen ? importer.importZip(chosen.fileName, chosen.data).id : null }; break
      }
      case 'startRun': {
        const { run, created } = orchestrator.start({ ...command, roster: sanitizeRoster(command.roster), initiator: operator })
        result = { runId: run.id, created }; break
      }
      case 'pauseRun': result = { state: orchestrator.requestPause(command.runId, operator).state }; break
      case 'resumeRun': result = { state: orchestrator.resume(command.runId, operator).state }; break
      case 'cancelRun': result = { state: orchestrator.requestCancel(command.runId, operator).state }; break
      case 'reviewClaim': {
        if (!['accepted', 'rejected'].includes(command.decision)) throw new Error('Invalid review decision')
        const claim = store.getClaim(command.claimId)
        if (!TERMINAL_RUN_STATES.has(store.getRun(claim.runId).state)) throw new Error('Wait for the run to finish before reviewing a finding')
        result = { reviewId: store.reviewClaim({ ...command, reviewer: operator }).id }; break
      }
      case 'decideRuleChange': {
        if (!['accepted', 'rejected'].includes(command.decision)) throw new Error('Invalid rule decision')
        result = { dnaVersion: store.decideRuleChange({ ...command, by: operator }).dna?.version ?? null }; break
      }
      case 'setTestAccount':
        this.requireIdleTarget(command.targetId)
        store.getTarget(command.targetId)
        if (!command.headerValue || command.headerValue.length > 8000 || /[\r\n]/.test(command.headerValue)) throw new Error('Enter a nonempty, single-line header value')
        store.setTestAccount(command.targetId, command.name, command.headerName, command.headerValue)
        result = { saved: true }; break
      case 'removeTestAccount': this.requireIdleTarget(command.targetId); store.removeTestAccount(command.targetId, command.name); result = { removed: true }; break
      case 'saveSettings': result = settings.save(command.settings); break
      case 'exportReport': {
        const report = store.latestReport(command.runId)
        if (!report) throw new Error('No report is available yet')
        result = { path: await this.deps.saveFile(`${command.runId}-report.md`, new TextEncoder().encode(report.markdown)) }; break
      }
      case 'exportArtifact': {
        const artifact = store.getArtifact(command.artifactId)
        result = { path: await this.deps.saveFile(`${artifact.id}${artifact.mime.includes('javascript') ? '.test.mjs' : '.txt'}`, this.deps.evidence.get(artifact.sha256)) }; break
      }
      case 'startLogin': this.requireIdleAccount(command.runtime); result = { sessionId: accounts.start(command.runtime) }; break
      case 'sendLoginInput': result = { sent: accounts.sendInput(command.sessionId, command.text) }; break
      case 'cancelLogin': result = { cancelled: accounts.cancel(command.sessionId) }; break
      case 'openLoginUrl': {
        const url = accounts.loginUrl(command.sessionId)
        if (url) await this.deps.openUrl(url)
        result = { opened: !!url }; break
      }
      case 'logout': this.requireIdleAccount(command.runtime); result = await accounts.logout(command.runtime); break
      default: throw new Error(`Unknown command ${(command as { type: string }).type}`)
    }
    return result as CommandResults[C['type']]
  }
}
