import { useMemo, useState } from 'react'
import { PHASES, ROLES, TERMINAL_RUN_STATES, type Run } from '../../../shared/domain'
import type { Envelope } from '../../../shared/events'
import { type PhaseStatus, type RunView, arenaMetrics, foldRun } from '../../../shared/fold'
import type { Finding, RunDetail } from '../../../shared/ipc'
import { Header } from '../App'
import { AGENT, AGENT_STATE, AREA, AUDIT_STATE, CATEGORY, DEPTH, EVIDENCE, FINDING_STATUS, FOCUS, METHOD, PROVIDER, STEP, STEP_STATE, plural } from '../copy'
import { FindingPanel, effectiveStatus } from '../components/FindingPanel'
import { AGENT_ICON, I, Spinner } from '../components/icons'
import { Markdown } from '../components/Markdown'
import { Empty, ErrorBanner, Loading, Pill, Severity, Tabs, useAction, useToast } from '../components/ui'
import { type ActivityGroup, describe, isVisible } from '../lib/activity'
import { command, newIdempotencyKey, useQuery } from '../lib/api'
import { formatDateTime, formatDuration, formatTime } from '../lib/format'
import { navigate } from '../lib/router'
import { useRunStream } from '../lib/stream'

type Tab = 'overview' | 'findings' | 'activity' | 'report' | 'details'

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function AuditScreen({ runId }: { runId: string }) {
  const stream = useRunStream(runId)
  const detail = useQuery('runDetail', { runId }, stream.view.seq)
  const [tab, setTab] = useState<Tab>('overview')
  const [selected, setSelected] = useState<string | null>(null)
  const action = useAction()
  const toast = useToast()

  if (detail.error && !detail.data) {
    return (
      <>
        <Header title="Audit" crumbs={[{ label: 'Audits', href: '#/audits' }]} />
        <div className="content">
          <div className="page">
            <ErrorBanner error={detail.error} />
          </div>
        </div>
      </>
    )
  }
  if (!detail.data) {
    return (
      <>
        <Header title="Audit" crumbs={[{ label: 'Audits', href: '#/audits' }]} />
        <div className="content">
          <Loading />
        </div>
      </>
    )
  }

  const { run, claims } = detail.data
  const view = stream.view
  const state = AUDIT_STATE[run.state]
  const terminal = TERMINAL_RUN_STATES.has(run.state)
  const finding = claims.find((c) => c.id === selected)

  const control = (type: 'pauseRun' | 'resumeRun' | 'cancelRun') => void action.run(() => command({ type, runId }))
  const exportReport = () =>
    void action.run(async () => {
      const result = await command({ type: 'exportReport', runId })
      if (result.path) toast('Report saved')
    })
  const runAgain = () =>
    void action.run(async () => {
      const c = run.contract
      const result = await command({
        type: 'startRun',
        idempotencyKey: newIdempotencyKey(),
        targetId: c.targetId,
        mode: c.mode,
        externalUrl: c.externalUrl,
        allowCommands: c.allowCommands,
        audit: c.audit,
        roster: c.roster,
      })
      navigate(`/audits/${result.runId}`)
    })

  return (
    <>
      <Header
        crumbs={[{ label: 'Audits', href: '#/audits' }]}
        title={
          <span className="row">
            {run.contract.targetName}
            <Pill tone={state.tone} dot pulse={run.state === 'running'}>
              {state.label}
            </Pill>
          </span>
        }
        actions={
          <>
            {!terminal && run.state === 'paused' && (
              <button className="btn" disabled={action.busy} onClick={() => control('resumeRun')}>
                <I.play size={14} />
                Resume
              </button>
            )}
            {!terminal && run.state !== 'paused' && (
              <button className="btn" disabled={action.busy || run.state !== 'running'} onClick={() => control('pauseRun')}>
                <I.pause size={14} />
                Pause
              </button>
            )}
            {!terminal && (
              <button className="btn btn--danger" disabled={action.busy || run.state === 'cancel_requested'} onClick={() => control('cancelRun')}>
                <I.stop size={14} />
                Stop
              </button>
            )}
            {detail.data.report && (
              <button className="btn" disabled={action.busy} onClick={exportReport}>
                <I.download size={15} />
                Export report
              </button>
            )}
            {terminal && (
              <button className="btn btn--primary" disabled={action.busy} onClick={runAgain}>
                <I.refresh size={15} />
                Run again
              </button>
            )}
          </>
        }
      />
      <div className="content">
        <div className="page">
          <ErrorBanner error={action.error} />
          {run.terminalReason && run.state !== 'completed' && <Banner tone={run.state === 'failed' ? 'danger' : 'warning'} text={run.terminalReason} />}
          <Steps view={view} run={run} />
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'overview', label: 'Overview' },
              { id: 'findings', label: 'Findings', count: claims.length },
              { id: 'activity', label: 'Activity' },
              { id: 'report', label: 'Report' },
              { id: 'details', label: 'Details' },
            ]}
          />
          {tab === 'overview' && <Overview view={view} run={run} detail={detail.data} events={stream.events} onOpenFinding={setSelected} onShowActivity={() => setTab('activity')} />}
          {tab === 'findings' && <FindingsTable claims={claims} onOpen={setSelected} selected={selected} />}
          {tab === 'activity' && <Activity events={stream.events} />}
          {tab === 'report' && <Report detail={detail.data} onExport={exportReport} busy={action.busy} />}
          {tab === 'details' && <Details run={run} />}
        </div>
      </div>
      {finding && <FindingPanel finding={finding} run={run} onClose={() => setSelected(null)} onChanged={detail.refetch} />}
    </>
  )
}

function Banner({ tone, text }: { tone: 'warning' | 'danger'; text: string }) {
  return (
    <div className={`banner banner--${tone}`}>
      <I.warningCircle size={16} />
      <div>{text}</div>
    </div>
  )
}

function StepIcon({ status }: { status: PhaseStatus }) {
  if (status === 'done') return <I.checkCircle size={16} weight="fill" color="var(--success)" />
  if (status === 'running') return <Spinner size={15} />
  if (status === 'blocked' || status === 'error') return <I.warningCircle size={16} weight="fill" color="var(--warning)" />
  if (status === 'skipped' || status === 'cancelled') return <I.minusCircle size={16} color="var(--text-3)" />
  return <I.circle size={16} color="var(--text-3)" />
}

function Steps({ view, run }: { view: RunView; run: Run }) {
  return (
    <div className="steps">
      {PHASES.map((phase) => {
        const step = STEP[phase]
        const status = view.phases[phase].status
        const provider = PROVIDER[run.contract.roster[step.role].runtime].name
        return (
          <div key={phase} className={`step step--${status}`} title={view.phases[phase].note ?? undefined}>
            <div className="step__bar">
              <span />
            </div>
            <div className="step__name">
              <StepIcon status={status} />
              {step.name}
            </div>
            <div className="step__meta truncate">
              {STEP_STATE[status]}
              {status !== 'skipped' ? `, ${provider}` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Overview({
  view,
  run,
  detail,
  events,
  onOpenFinding,
  onShowActivity,
}: {
  view: RunView
  run: Run
  detail: RunDetail
  events: Envelope[]
  onOpenFinding: (id: string) => void
  onShowActivity: () => void
}) {
  const m = arenaMetrics(view)
  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`)
  const visible = events.filter(isVisible)
  const recent = visible.slice(-8).reverse()
  const lastActivity = (taskId: string | undefined) => {
    if (!taskId) return null
    const e = [...visible].reverse().find((x) => x.taskId === taskId)
    return e ? describe(e, view).text : null
  }
  const needsReview = detail.claims.filter((c) => effectiveStatus(c) === 'needs_review')

  return (
    <div className="stack">
      <div className="grid-4">
        <div className="card stat">
          <div className="stat__label">Confirmed issues</div>
          <div className="stat__value">{m.confirmed}</div>
          <div className="stat__hint">{plural(m.claims, 'finding')} reported</div>
        </div>
        <div className="card stat">
          <div className="stat__label">False positives caught</div>
          <div className="stat__value">{m.falsePositivesCaught}</div>
          <div className="stat__hint">Dismissed by review and verification</div>
        </div>
        <div className="card stat">
          <div className="stat__label">Needs your review</div>
          <div className="stat__value">{m.needsReview + m.inconclusive}</div>
          <div className="stat__hint">Evidence and review disagree</div>
        </div>
        <div className="card stat">
          <div className="stat__label">Verified</div>
          <div className="stat__value">{pct(m.verificationCoverage)}</div>
          <div className="stat__hint">Findings backed by a replay or code check</div>
        </div>
      </div>

      {detail.sampleScore && (
        <div className="banner">
          <I.info size={16} />
          <div>
            Sample project: found {detail.sampleScore.matchedBugs} of {detail.sampleScore.knownBugs} known issues.
          </div>
        </div>
      )}

      {needsReview.length > 0 && TERMINAL_RUN_STATES.has(run.state) && (
        <div className="banner banner--warning">
          <I.warning size={16} />
          <div>
            {plural(needsReview.length, 'finding')} need{needsReview.length === 1 ? 's' : ''} your decision.{' '}
            <button className="link" onClick={() => onOpenFinding(needsReview[0].id)}>
              Review now
            </button>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card__head">
            <h3>Agents</h3>
          </div>
          <table>
            <tbody>
              {ROLES.map((role) => {
                const task = view.taskOrder.map((id) => view.tasks[id]).filter((t) => t.role === role).at(-1)
                const profile = run.contract.roster[role]
                const status = AGENT_STATE[task?.status ?? 'waiting']
                const Icon = AGENT_ICON[role]
                return (
                  <tr key={role}>
                    <td>
                      <div className="agent-cell">
                        <span className="agent-icon">
                          <Icon size={15} />
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-title">{AGENT[role].title}</div>
                          <div className="cell-sub truncate" style={{ maxWidth: 300 }}>
                            {sentence(task?.blockedReason ?? (task?.status === 'running' ? lastActivity(task.taskId) : task?.reason) ?? lastActivity(task?.taskId) ?? AGENT[role].job)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="muted small">
                      {PROVIDER[profile.runtime].name}
                      {profile.model ? ` ${profile.model}` : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Pill tone={status.tone} dot pulse={task?.status === 'running'}>
                        {status.label}
                      </Pill>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card__head">
            <h3>Latest activity</h3>
            <span className="spacer" />
            <button className="link small" onClick={onShowActivity}>
              View all
            </button>
          </div>
          {recent.length ? (
            <div className="activity">
              {recent.map((e) => (
                <ActivityRow key={e.seq} event={e} view={view} />
              ))}
            </div>
          ) : (
            <Empty title="Waiting for the first step" />
          )}
        </div>
      </div>
    </div>
  )
}

function ActivityRow({ event, view, future = false }: { event: Envelope; view: RunView; future?: boolean }) {
  const line = describe(event, view)
  const tone = line.tone === 'neutral' ? '' : `activity-item__icon--${line.tone}`
  const task = event.taskId ? view.tasks[event.taskId] : undefined
  const Icon = task ? AGENT_ICON[task.role] : line.group === 'findings' ? I.findings : I.audits
  return (
    <div className={`activity-item ${future ? 'future' : ''}`}>
      <span className={`activity-item__icon ${tone}`}>
        <Icon size={14} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="activity-item__title">
          {line.actor && <strong>{line.actor} </strong>}
          <span className="selectable">{line.text}</span>
        </div>
        {line.detail && <div className="activity-item__detail selectable">{line.detail}</div>}
      </div>
      <time>{formatTime(event.ts)}</time>
    </div>
  )
}

function FindingsTable({ claims, onOpen, selected }: { claims: Finding[]; onOpen: (id: string) => void; selected: string | null }) {
  if (!claims.length) {
    return (
      <div className="card">
        <Empty icon={<I.findings size={22} />} title="No findings yet">
          The test agent reports issues here. Each one is reviewed and verified before it counts.
        </Empty>
      </div>
    )
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 110 }}>Severity</th>
            <th>Finding</th>
            <th>Category</th>
            <th>Verification</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((c) => {
            const status = FINDING_STATUS[effectiveStatus(c)]
            const latest = c.verifications.at(-1)
            return (
              <tr key={c.id} className={`clickable ${selected === c.id ? 'selected' : ''}`} onClick={() => onOpen(c.id)}>
                <td>
                  <Severity level={c.severity} />
                </td>
                <td>
                  <div className="cell-title">{c.title}</div>
                  {c.location && <div className="cell-sub mono">{c.location}</div>}
                </td>
                <td className="muted">{CATEGORY[c.category]}</td>
                <td className="muted small">{latest ? EVIDENCE[latest.outcome].label : 'Not checked yet'}</td>
                <td>
                  <Pill tone={status.tone} dot>
                    {status.label}
                  </Pill>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const GROUPS: { id: ActivityGroup | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'findings', label: 'Findings' },
  { id: 'agents', label: 'Agents' },
  { id: 'tools', label: 'Actions' },
  { id: 'audit', label: 'Audit' },
]

function Activity({ events }: { events: Envelope[] }) {
  const [group, setGroup] = useState<ActivityGroup | 'all'>('all')
  const [playhead, setPlayhead] = useState<number | null>(null)
  const visible = useMemo(() => events.filter(isVisible), [events])
  const cutoff = playhead === null ? Number.POSITIVE_INFINITY : (visible[playhead - 1]?.seq ?? 0)
  const view = useMemo(() => foldRun(events, cutoff), [events, cutoff])
  const rows = visible.filter((e) => group === 'all' || describe(e, view).group === group)

  return (
    <div>
      <div className="replay">
        <I.clock size={16} color="var(--text-3)" />
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
          {playhead === null ? 'Live' : `Step ${playhead} of ${visible.length}`}
        </span>
        <input
          type="range"
          aria-label="Replay position"
          min={1}
          max={Math.max(1, visible.length)}
          value={playhead ?? visible.length}
          onChange={(e) => {
            const n = Number(e.target.value)
            setPlayhead(n >= visible.length ? null : n)
          }}
        />
        <button className="btn btn--sm" disabled={playhead === null} onClick={() => setPlayhead(null)}>
          Back to live
        </button>
      </div>
      <div className="chips" style={{ marginBottom: 12 }}>
        {GROUPS.map((g) => (
          <button key={g.id} className={`chip ${group === g.id ? 'on' : ''}`} onClick={() => setGroup(g.id)}>
            {g.label}
          </button>
        ))}
      </div>
      <div className="card">
        {rows.length ? (
          <div className="activity">
            {[...rows].reverse().map((e) => (
              <ActivityRow key={e.seq} event={e} view={view} future={e.seq > cutoff} />
            ))}
          </div>
        ) : (
          <Empty title="Nothing here yet" />
        )}
      </div>
    </div>
  )
}

function Report({ detail, onExport, busy }: { detail: RunDetail; onExport: () => void; busy: boolean }) {
  const [id, setId] = useState<string | null>(null)
  const versions = [...detail.reports].sort((a, b) => b.version - a.version)
  const report = versions.find((r) => r.id === id) ?? versions[0]
  if (!report) {
    return (
      <div className="card">
        <Empty icon={<I.file size={22} />} title="No report yet">
          A first draft is written after testing, and the final report after review.
        </Empty>
      </div>
    )
  }
  return (
    <div className="card">
      <div className="card__head">
        <select className="select select--sm" style={{ width: 'auto' }} value={report.id} onChange={(e) => setId(e.target.value)} aria-label="Report version">
          {versions.map((r, n) => (
            <option key={r.id} value={r.id}>
              {n === 0 ? 'Latest' : `Version ${r.version}`}, {formatDateTime(r.createdAt)}
            </option>
          ))}
        </select>
        <span className="small faint">{report.author}</span>
        <span className="spacer" />
        <button className="btn btn--sm" disabled={busy} onClick={onExport}>
          <I.download size={14} />
          Export
        </button>
      </div>
      <div className="card__body" style={{ padding: '20px 28px 28px' }}>
        <Markdown text={report.markdown} />
      </div>
    </div>
  )
}

function Details({ run }: { run: Run }) {
  const c = run.contract
  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card card--pad">
        <h3 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14 }}>Scope</h3>
        <dl className="kv">
          <dt>Method</dt>
          <dd>{METHOD[c.mode].name}</dd>
          <dt>Areas</dt>
          <dd>{c.audit.areas.map((a) => AREA[a]).join(', ')}</dd>
          <dt>Focus</dt>
          <dd>{c.audit.focus.map((f) => FOCUS[f].name).join(', ') || 'None'}</dd>
          <dt>Depth</dt>
          <dd>
            {DEPTH[c.audit.depth]}, up to {plural(c.limits.maxRounds, 'review round')} and {plural(c.limits.maxClaims, 'finding')}
          </dd>
          <dt>Excluded</dt>
          <dd>{c.audit.excludedPaths.length ? c.audit.excludedPaths.join(', ') : 'Nothing'}</dd>
          <dt>Instructions</dt>
          <dd>{c.audit.instructions || 'None'}</dd>
        </dl>
      </div>
      <div className="card card--pad">
        <h3 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14 }}>Environment</h3>
        <dl className="kv">
          <dt>App</dt>
          <dd>{c.externalUrl ? c.externalUrl : c.allowCommands ? 'Started on this Mac' : 'Not run'}</dd>
          <dt>Test accounts</dt>
          <dd>{c.audit.accounts.length ? c.audit.accounts.join(', ') : 'None'}</dd>
          <dt>Knowledge library</dt>
          <dd>{c.audit.useKnowledge ? 'On' : 'Off'}</dd>
          <dt>Snapshot</dt>
          <dd className="mono">{c.snapshotHash.slice(0, 16)}</dd>
          {c.commitSha && (
            <>
              <dt>Commit</dt>
              <dd className="mono">{c.commitSha.slice(0, 12)}</dd>
            </>
          )}
          <dt>Started by</dt>
          <dd>{c.initiator}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(run.startedAt ?? run.createdAt)}</dd>
          <dt>Duration</dt>
          <dd>{formatDuration(run.startedAt, run.endedAt)}</dd>
        </dl>
      </div>
      <div className="card card--pad" style={{ gridColumn: '1 / -1' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 14 }}>Agents</h3>
        <dl className="kv">
          {ROLES.map((role) => (
            <div key={role} style={{ display: 'contents' }}>
              <dt>{AGENT[role].title}</dt>
              <dd>
                {PROVIDER[c.roster[role].runtime].name}
                {c.roster[role].model ? `, ${c.roster[role].model}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
