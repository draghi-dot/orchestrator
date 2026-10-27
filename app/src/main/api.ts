/**
 * The API layer (after Kestrel's apps/api + ops_dashboard routes): owns
 * operator intent, maps commands onto the orchestrator, and serves read
 * models. Electron-agnostic so it can be tested without a window.
 */

import type { AgentProfile, Environment } from '../shared/domain'
import type { Command, CommandResults, Queries, QueryName, ReviewItem } from '../shared/ipc'
import { EvidenceIntegrityError, type EvidenceStore } from './evidence'
import type { Orchestrator } from './orchestrator'
import { type SettingsStore, probeOmp } from './settings'
import type { QaStore } from './store'

const MAX_ARTIFACT_TEXT = 512 * 1024

export class ControlPlaneApi {
  constructor(
    private readonly deps: {
      store: QaStore
      evidence: EvidenceStore
      orchestrator: Orchestrator
      settings: SettingsStore
      operator: string
    },
  ) {}

  private publicEnvironment(env: Environment) {
    return { ...env, secretRefs: env.secretRefs.map((s) => ({ name: s.name, configured: s.ref.length > 0 })) }
  }

  async query<K extends QueryName>(name: K, args: Queries[K]['args']): Promise<Queries[K]['result']> {
    const { store, evidence, settings } = this.deps
    const a = (args ?? {}) as Record<string, string>
    switch (name) {
      case 'overview': {
        const result: Queries['overview']['result'] = {
          projects: store.listProjects(),
          environments: store.listEnvironments().map((e) => this.publicEnvironment(e)),
          suites: store.listSuites().map((s) => ({ ...s, versions: store.listSuiteVersions(s.id) })),
          operator: this.deps.operator,
        }
        return result as Queries[K]['result']
      }
      case 'listRuns':
        // Terminal runs carry their frozen summary; live ones are summarized now.
        return store.listRuns().map((r) => (r.summary ? r : { ...r, summary: store.summarize(r.id) })) as Queries[K]['result']
      case 'runDetail': {
        const run = store.getRun(a.runId)
        return { run, attempts: store.listAttempts(run.id), suiteVersion: store.getSuiteVersion(run.contract.suiteVersionId) } as Queries[K]['result']
      }
      case 'artifact': {
        const artifact = store.getArtifact(a.artifactId)
        try {
          const bytes = evidence.get(artifact.sha256)
          const isText = /^(text\/|application\/(json|xml))/.test(artifact.mime)
          const text = isText ? bytes.subarray(0, MAX_ARTIFACT_TEXT).toString('utf8') : null
          return { artifact, text, verified: true, error: null } as Queries[K]['result']
        } catch (err) {
          const message = err instanceof EvidenceIntegrityError ? err.message : `evidence unavailable: ${(err as Error).message}`
          return { artifact, text: null, verified: false, error: message } as Queries[K]['result']
        }
      }
      case 'reviewQueue': {
        const items: ReviewItem[] = store.listReviewQueue().map((attempt) => {
          const run = store.getRun(attempt.runId)
          const version = store.getSuiteVersion(run.contract.suiteVersionId)
          const artifactIds = new Set<string>()
          const assertions = store.listAssertionResults(attempt.id)
          for (const r of assertions) for (const id of r.artifactIds) artifactIds.add(id)
          return {
            attempt,
            run,
            caseTitle: version.cases.find((c) => c.id === attempt.caseId)?.title ?? attempt.caseId,
            assertions,
            artifacts: [...artifactIds].map((id) => store.getArtifact(id)),
          }
        })
        return items as Queries[K]['result']
      }
      case 'reviews':
        return store.listReviews() as Queries[K]['result']
      case 'settings':
        return settings.get() as Queries[K]['result']
      case 'agentStatus':
        return { omp: await probeOmp(settings.get().ompCommand, settings.get().ompModel) } as Queries[K]['result']
      default:
        throw new Error(`unknown query ${String(name)}`)
    }
  }

  async command<C extends Command>(command: C): Promise<CommandResults[C['type']]> {
    const { store, orchestrator, settings, operator } = this.deps
    type R = CommandResults[C['type']]
    switch (command.type) {
      case 'startRun': {
        const s = settings.get()
        const agent: AgentProfile =
          command.adapter === 'omp'
            ? { adapter: 'omp', model: s.ompModel, builtinTools: s.ompBuiltinTools }
            : { adapter: 'scripted', model: '', builtinTools: [] }
        const { run, created } = orchestrator.start({
          idempotencyKey: command.idempotencyKey,
          suiteVersionId: command.suiteVersionId,
          environmentId: command.environmentId,
          caseIds: command.caseIds,
          buildRevision: command.buildRevision,
          agent,
          initiator: operator,
        })
        return { runId: run.id, created } as R
      }
      case 'pauseRun':
        return { state: orchestrator.requestPause(command.runId, operator).state } as R
      case 'resumeRun':
        return { state: orchestrator.resume(command.runId, operator).state } as R
      case 'cancelRun':
        return { state: orchestrator.requestCancel(command.runId, operator).state } as R
      case 'recordReview': {
        const review = store.recordReview({ attemptId: command.attemptId, decision: command.decision, reason: command.reason, reviewer: operator })
        return { reviewId: review.id } as R
      }
      case 'saveSettings':
        return settings.save(command.settings) as R
      default:
        throw new Error(`unknown command ${(command as { type: string }).type}`)
    }
  }
}
