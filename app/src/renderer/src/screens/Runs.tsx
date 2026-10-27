import { ArrowRight, Bot, Play, Plus, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AdapterId, Run } from '../../../shared/domain'
import { Counts, Empty, ProgressBar, RunStateBadge, useToast } from '../components/ui'
import { command, newIdempotencyKey, useQuery } from '../lib/api'
import { formatDateTime, formatDuration, shortId } from '../lib/format'
import { navigate } from '../lib/router'
import { useLive } from '../lib/stream'

const ACTIVE = new Set(['queued', 'running', 'pause_requested', 'paused', 'cancel_requested'])

export function RunsScreen() {
  const live = useLive()
  const runs = useQuery('listRuns', undefined, live.version)
  const [composing, setComposing] = useState(false)

  const [active, history] = useMemo(() => {
    const all = runs.data ?? []
    return [all.filter((r) => ACTIVE.has(r.state)), all.filter((r) => !ACTIVE.has(r.state))]
  }, [runs.data])

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Test runs</div>
          <h1 className="h-display" style={{ marginTop: 8 }}>
            Runs
          </h1>
          <p className="lede">Agents execute cases. Code decides pass or fail from recorded evidence. Every step is on the record.</p>
        </div>
        {!composing ? (
          <button className="btn" onClick={() => setComposing(true)}>
            <Plus size={18} />
            New run
          </button>
        ) : null}
      </div>

      {composing ? <NewRunPanel onClose={() => setComposing(false)} /> : null}

      <div className="section-head">
        <h2 className="h-section">Active</h2>
        <span className="faint num">{active.length}</span>
      </div>
      {active.length === 0 ? (
        <div className="frame">
          <Empty title="Nothing running">Start a run to watch an agent work through a suite live.</Empty>
        </div>
      ) : (
        <div className="stack">
          {active.map((run) => (
            <ActiveRunCard key={run.id} run={run} />
          ))}
        </div>
      )}

      <div className="section-head">
        <h2 className="h-section">History</h2>
        <span className="faint num">{history.length}</span>
      </div>
      <div className="frame" style={{ overflow: 'hidden' }}>
        {history.length === 0 ? (
          <Empty title="No finished runs yet" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>State</th>
                <th>Suite</th>
                <th>Build</th>
                <th>Environment</th>
                <th>Agent</th>
                <th>Results</th>
                <th>Started</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <tr key={run.id} className="clickable" onClick={() => navigate(`/runs/${run.id}`)}>
                  <td>
                    <RunStateBadge state={run.state} />
                  </td>
                  <td>
                    <strong>{run.suiteName}</strong>
                    <div className="faint mono">{shortId(run.id)}</div>
                  </td>
                  <td className="mono">{run.contract.buildRevision}</td>
                  <td>{run.contract.environment.name}</td>
                  <td>{run.contract.agent.adapter === 'omp' ? 'oh-my-pi' : 'Scripted'}</td>
                  <td>{run.summary ? <Counts summary={run.summary} /> : <span className="faint">—</span>}</td>
                  <td className="num">{formatDateTime(run.startedAt ?? run.createdAt)}</td>
                  <td className="num">{formatDuration(run.startedAt, run.endedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

function ActiveRunCard({ run }: { run: Run }) {
  const summary = run.summary ?? { passed: 0, failed: 0, blocked: 0, error: 0, cancelled: 0, total: run.contract.caseIds.length }
  return (
    <a className="frame run-card drop" href={`#/runs/${run.id}`}>
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <RunStateBadge state={run.state} />
          <span className="chip chip--line">
            build <span className="mono">{run.contract.buildRevision}</span>
          </span>
          <span className="chip chip--line">{run.contract.environment.name}</span>
          <span className="chip chip--line">
            <Bot size={13} />
            {run.contract.agent.adapter === 'omp' ? 'oh-my-pi' : 'Scripted'}
          </span>
        </div>
        <div className="h-section">{run.suiteName}</div>
        <div className="faint" style={{ marginTop: 4 }}>
          {run.contract.caseIds.length} case{run.contract.caseIds.length === 1 ? '' : 's'} · started by {run.contract.initiator} ·{' '}
          {formatDateTime(run.createdAt)}
        </div>
        <div style={{ marginTop: 14, maxWidth: 560 }}>
          <ProgressBar summary={summary} />
        </div>
      </div>
      <div className="row" style={{ alignSelf: 'center' }}>
        <span className="btn btn--small">
          Open workspace
          <ArrowRight size={16} />
        </span>
      </div>
    </a>
  )
}

function NewRunPanel({ onClose }: { onClose: () => void }) {
  const overview = useQuery('overview', undefined)
  const settings = useQuery('settings', undefined)
  const toast = useToast()
  // One key per composer: a double click or a retried request cannot start two runs.
  const [idempotencyKey] = useState(newIdempotencyKey)
  const [suiteVersionId, setSuiteVersionId] = useState('')
  const [environmentId, setEnvironmentId] = useState('')
  const [buildRevision, setBuildRevision] = useState('local-dev')
  const [adapter, setAdapter] = useState<AdapterId>('scripted')
  const [caseIds, setCaseIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  const versions = useMemo(
    () => (overview.data?.suites ?? []).flatMap((s) => s.versions.map((v) => ({ ...v, suiteName: s.name, projectId: s.projectId }))),
    [overview.data],
  )
  const version = versions.find((v) => v.id === suiteVersionId)
  const environments = (overview.data?.environments ?? []).filter((e) => !version || e.projectId === version.projectId)
  const environment = environments.find((e) => e.id === environmentId)

  useEffect(() => {
    if (!suiteVersionId && versions[0]) setSuiteVersionId(versions[0].id)
  }, [versions, suiteVersionId])
  useEffect(() => {
    if (version) setCaseIds(version.cases.map((c) => c.id))
  }, [version])
  useEffect(() => {
    if ((!environmentId || !environments.some((e) => e.id === environmentId)) && environments[0]) setEnvironmentId(environments[0].id)
  }, [environments, environmentId])
  useEffect(() => {
    if (settings.data) setAdapter(settings.data.defaultAdapter)
  }, [settings.data])

  const toggleCase = (id: string) => setCaseIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))

  const start = async () => {
    if (!version || !environment || caseIds.length === 0) return
    setSubmitting(true)
    try {
      const result = await command({
        type: 'startRun',
        idempotencyKey,
        suiteVersionId: version.id,
        environmentId: environment.id,
        caseIds: version.cases.map((c) => c.id).filter((id) => caseIds.includes(id)),
        buildRevision,
        adapter,
      })
      navigate(`/runs/${result.runId}`)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'fail')
      setSubmitting(false)
    }
  }

  return (
    <div className="frame frame--pad drop" style={{ marginBottom: 8 }}>
      <div className="row" style={{ marginBottom: 18 }}>
        <Sparkles size={20} />
        <h2 className="h-section">New run</h2>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <div className="grid-2" style={{ gap: 28 }}>
        <div className="stack" style={{ gap: 16 }}>
          <label className="field">
            <span>Suite version (immutable)</span>
            <select className="select" value={suiteVersionId} onChange={(e) => setSuiteVersionId(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.suiteName} v{v.version} · {v.sourceRevision}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Environment</span>
            <select className="select" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.baseUrl}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Build under test</span>
            <input className="input mono" value={buildRevision} onChange={(e) => setBuildRevision(e.target.value)} placeholder="commit or build id" />
          </label>
          <div className="field">
            <span>Agent</span>
            <div className="segmented">
              <button className={adapter === 'scripted' ? 'on' : ''} onClick={() => setAdapter('scripted')}>
                Scripted
              </button>
              <button className={adapter === 'omp' ? 'on' : ''} onClick={() => setAdapter('omp')}>
                <Bot size={14} />
                oh-my-pi
              </button>
            </div>
          </div>
          {environment ? (
            <dl className="kv" style={{ marginTop: 6 }}>
              <dt>Allowed origins</dt>
              <dd className="mono">{environment.allowedOrigins.join(', ')}</dd>
              <dt>Writes</dt>
              <dd>{environment.allowMutatingMethods ? 'Mutating HTTP methods allowed' : 'Read-only (GET/HEAD)'}</dd>
              <dt>Test data</dt>
              <dd>{environment.testDataPolicy}</dd>
            </dl>
          ) : null}
        </div>
        <div className="field">
          <span>
            Cases · {caseIds.length} of {version?.cases.length ?? 0}
          </span>
          <div className="stack" style={{ gap: 8 }}>
            {version?.cases.map((c) => (
              <label key={c.id} className={`check ${caseIds.includes(c.id) ? 'check--on' : ''}`}>
                <input type="checkbox" checked={caseIds.includes(c.id)} onChange={() => toggleCase(c.id)} />
                <span>
                  <strong>{c.title}</strong>
                  <div className="faint mono">
                    {c.id} · {c.steps.length} step{c.steps.length === 1 ? '' : 's'} · {c.assertions.length} assertion
                    {c.assertions.length === 1 ? '' : 's'}
                  </div>
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <hr className="rule" />
      <div className="row">
        <span className="faint" style={{ fontSize: '0.86rem' }}>
          The suite version, build, environment policy, and agent profile are frozen into the run contract when it starts.
        </span>
        <span className="spacer" />
        <button className="btn" disabled={submitting || !version || !environment || caseIds.length === 0} onClick={start}>
          <Play size={16} />
          {submitting ? 'Starting…' : 'Start run'}
        </button>
      </div>
    </div>
  )
}
