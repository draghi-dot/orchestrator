import { ChevronLeft, ChevronRight, FileText, Pause, Play, Quote, Radio, RotateCcw, Square, StepBack, StepForward } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaseDef } from '../../../shared/domain'
import type { Envelope, EventType } from '../../../shared/events'
import { type AttemptView, type RunView, foldRun } from '../../../shared/fold'
import { ArtifactViewer } from '../components/ArtifactViewer'
import { AttemptBadge, type CaseStatus, Empty, RunStateBadge, StatusIcon, useToast } from '../components/ui'
import { command, newIdempotencyKey, useQuery } from '../lib/api'
import { formatAge, formatBytes, formatDuration, formatTime, shortId } from '../lib/format'
import { navigate, replaceParams } from '../lib/router'
import { useRunStream } from '../lib/stream'

type Filter = 'all' | 'lifecycle' | 'steps' | 'tools' | 'evidence' | 'assertions' | 'agent'

const FILTERS: { id: Filter; label: string; types: EventType[] | null }[] = [
  { id: 'all', label: 'All', types: null },
  {
    id: 'lifecycle',
    label: 'Lifecycle',
    types: ['run_created', 'run_started', 'run_pause_requested', 'run_paused', 'run_resumed', 'run_cancel_requested', 'run_cancelled', 'run_completed', 'run_failed', 'attempt_started', 'attempt_finished', 'worker_heartbeat', 'review_recorded'],
  },
  { id: 'steps', label: 'Steps', types: ['step_started', 'step_finished'] },
  { id: 'tools', label: 'Tools', types: ['tool_called', 'tool_result', 'tool_rejected'] },
  { id: 'evidence', label: 'Evidence', types: ['artifact_saved'] },
  { id: 'assertions', label: 'Assertions', types: ['assertion_passed', 'assertion_failed', 'assertion_blocked'] },
  { id: 'agent', label: 'Agent', types: ['agent_message', 'agent_blocked'] },
]

const s = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

function describe(e: Envelope): string {
  const p = e.payload
  switch (e.type) {
    case 'run_created':
      return `${s(p.suite_name)} · ${Array.isArray(p.case_ids) ? p.case_ids.length : 0} cases · build ${s(p.build_revision)}`
    case 'run_completed': {
      const sum = p.summary as Record<string, number>
      return `${sum.passed} passed · ${sum.failed} failed · ${sum.blocked} blocked · ${sum.error} errors`
    }
    case 'run_cancelled':
      return `mode ${s(p.mode)}`
    case 'run_failed':
      return s(p.reason)
    case 'run_pause_requested':
    case 'run_resumed':
    case 'run_cancel_requested':
      return `by ${s(p.by)}`
    case 'attempt_started':
      return `${s(p.case_id)} · attempt ${s(p.attempt_number)} · ${s(p.adapter)}`
    case 'attempt_finished':
      return `${s(p.case_id)} → ${s(p.status)} · ${s(p.reason)}`
    case 'step_started':
      return `${s(p.step_id)} · ${s(p.title)}`
    case 'step_finished':
      return `${s(p.step_id)} · ${s(p.status)}`
    case 'tool_called':
      return `${s(p.tool)} ${s(p.args)}`
    case 'tool_result':
      return `${s(p.tool)} · ${s(p.summary)}`
    case 'tool_rejected':
      return `${s(p.tool)} · ${s(p.reason)}`
    case 'artifact_saved':
      return `${s(p.label)} · ${formatBytes(Number(p.bytes) || 0)}`
    case 'assertion_passed':
    case 'assertion_failed':
    case 'assertion_blocked':
      return `${s(p.assertion_id)} · expected ${s(p.expected)} · actual ${s(p.actual)}`
    case 'agent_message':
      return s(p.text)
    case 'agent_blocked':
      return s(p.reason)
    case 'worker_heartbeat':
      return `${s(p.worker_id)} · ${s(p.status)}`
    case 'review_recorded':
      return `${s(p.decision)} by ${s(p.reviewer)} · ${s(p.reason)}`
    default:
      return ''
  }
}

function caseStatus(view: RunView, caseId: string): CaseStatus {
  const ids = view.caseAttempts[caseId]
  if (!ids || ids.length === 0) return 'pending'
  return view.attempts[ids[ids.length - 1]]?.status ?? 'pending'
}

export function RunWorkspace({ runId, params }: { runId: string; params: URLSearchParams }) {
  const stream = useRunStream(runId)
  const toast = useToast()
  const mode = params.get('mode') === 'replay' ? 'replay' : 'live'
  const filter = (params.get('filter') as Filter | null) ?? 'all'
  const seqParam = Number(params.get('seq')) || null

  // Refetch the authoritative run record whenever the folded lifecycle moves.
  const detailVersion = `${stream.view.state}:${Object.keys(stream.view.attempts).length}:${stream.view.summary.total}`
  const detail = useQuery('runDetail', { runId }, detailVersion)

  const events = stream.events
  const lastSeq = events.length > 0 ? events[events.length - 1].seq : 0
  const playhead = mode === 'replay' ? (seqParam ?? lastSeq) : lastSeq
  const view = useMemo(() => (mode === 'replay' ? foldRun(events, playhead) : stream.view), [mode, events, playhead, stream.view])

  const cases: CaseDef[] = useMemo(() => {
    const version = detail.data?.suiteVersion
    const ids = detail.data?.run.contract.caseIds ?? view.caseIds
    return ids.map((id) => version?.cases.find((c) => c.id === id)).filter((c): c is CaseDef => !!c)
  }, [detail.data, view.caseIds])

  const selectedCaseId =
    params.get('case') ??
    (view.activeAttemptId ? view.attempts[view.activeAttemptId]?.caseId : null) ??
    cases.find((c) => ['failed', 'error', 'blocked'].includes(caseStatus(view, c.id)))?.id ??
    cases[0]?.id ??
    null
  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null

  // ------------------------------------------------------------- controls
  const [pending, setPending] = useState<{ label: string; fromState: string } | null>(null)
  useEffect(() => {
    if (pending && stream.view.state !== pending.fromState) setPending(null)
  }, [stream.view.state, pending])

  const send = async (type: 'pauseRun' | 'resumeRun' | 'cancelRun', label: string) => {
    setPending({ label, fromState: stream.view.state })
    try {
      await command({ type, runId })
      // The response only acknowledges intent; the button stays pending
      // until a durable event moves the folded state.
    } catch (err) {
      setPending(null)
      toast.show(err instanceof Error ? err.message : String(err), 'fail')
    }
  }

  const runAgain = async () => {
    const run = detail.data?.run
    if (!run) return
    try {
      const result = await command({
        type: 'startRun',
        idempotencyKey: newIdempotencyKey(),
        suiteVersionId: run.contract.suiteVersionId,
        environmentId: run.contract.environment.id,
        caseIds: run.contract.caseIds,
        buildRevision: run.contract.buildRevision,
        adapter: run.contract.agent.adapter,
      })
      navigate(`/runs/${result.runId}`)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'fail')
    }
  }

  const liveState = stream.view.state
  const isTerminal = liveState === 'completed' || liveState === 'failed' || liveState === 'cancelled'
  const remaining = Math.max(0, view.summary.total - view.summary.passed - view.summary.failed - view.summary.blocked - view.summary.error - view.summary.cancelled)
  const activeAttempt = stream.view.activeAttemptId ? stream.view.attempts[stream.view.activeAttemptId] : null

  // Ticking clock for heartbeat ages and durations.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (isTerminal) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [isTerminal])

  const [artifactId, setArtifactId] = useState<string | null>(null)

  if (detail.error && !detail.data) {
    return (
      <div className="frame">
        <Empty title="Run not found" action={<a className="btn" href="#/runs">Back to runs</a>}>
          {detail.error}
        </Empty>
      </div>
    )
  }

  const run = detail.data?.run

  return (
    <>
      <div className="crumbs">
        <a href="#/runs">Runs</a>
        <ChevronRight size={14} />
        <span className="mono">{shortId(runId)}</span>
      </div>

      <div className="ws-head">
        <div>
          <h1 className="h-display">{view.suiteName ?? run?.suiteName ?? 'Run'}</h1>
          <div className="row row--wrap" style={{ marginTop: 14 }}>
            <RunStateBadge state={mode === 'replay' ? view.state : liveState} />
            {run ? (
              <>
                <span className="chip chip--line">
                  build <span className="mono">{run.contract.buildRevision}</span>
                </span>
                <span className="chip chip--line">
                  {run.contract.environment.name} · <span className="mono">{run.contract.environment.baseUrl}</span>
                </span>
                <span className="chip chip--line">{run.contract.agent.adapter === 'omp' ? `oh-my-pi${run.contract.agent.model ? ` · ${run.contract.agent.model}` : ''}` : 'Scripted agent'}</span>
                <span className="chip chip--line">by {run.contract.initiator}</span>
                <span className="chip chip--wash">{formatDuration(run.startedAt, run.endedAt, now)}</span>
              </>
            ) : null}
          </div>
          {stream.view.terminalReason && liveState !== 'completed' ? (
            <div className="faint" style={{ marginTop: 10 }}>
              {stream.view.terminalReason}
            </div>
          ) : null}
        </div>
        <div className="row">
          {pending ? (
            <span className="chip chip--dashed">
              {pending.label} — waiting for the worker to confirm
            </span>
          ) : null}
          {liveState === 'running' ? (
            <button className="btn btn--ghost" disabled={!!pending} onClick={() => send('pauseRun', 'Pause requested')}>
              <Pause size={16} />
              Pause
            </button>
          ) : null}
          {liveState === 'paused' || liveState === 'pause_requested' ? (
            <button className="btn" disabled={!!pending} onClick={() => send('resumeRun', 'Resume requested')}>
              <Play size={16} />
              Resume
            </button>
          ) : null}
          {['queued', 'running', 'paused', 'pause_requested'].includes(liveState) ? (
            <button className="btn btn--ghost btn--danger" disabled={!!pending} onClick={() => send('cancelRun', 'Cancel requested')}>
              <Square size={14} />
              Cancel
            </button>
          ) : null}
          {isTerminal ? (
            <button className="btn" onClick={runAgain}>
              <RotateCcw size={16} />
              Run again
            </button>
          ) : null}
        </div>
      </div>

      <div className="frame counters">
        <Counter n={view.summary.passed} label="Passed" status="passed" />
        <Counter n={view.summary.failed} label="Failed" status="failed" className={view.summary.failed > 0 ? 'counter--fail' : ''} />
        <Counter n={view.summary.blocked} label="Blocked" status="blocked" className={view.summary.blocked > 0 ? 'counter--block' : ''} />
        <Counter n={view.summary.error} label="Errors" status="error" />
        <Counter n={remaining} label={`Remaining of ${view.summary.total}`} status={remaining > 0 && !isTerminal ? 'running' : 'pending'} />
      </div>

      <div className="frame modebar">
        <div className="segmented">
          <button className={mode === 'live' ? 'on' : ''} onClick={() => replaceParams({ mode: null, seq: null })}>
            <Radio size={14} />
            Live
          </button>
          <button className={mode === 'replay' ? 'on' : ''} onClick={() => replaceParams({ mode: 'replay', seq: lastSeq })}>
            <RotateCcw size={14} />
            Replay
          </button>
        </div>
        {mode === 'replay' ? (
          <ReplayControls events={events} playhead={playhead} />
        ) : (
          <div className="row" style={{ flex: 1, fontSize: '0.88rem' }}>
            <span className="muted">Following the leading edge.</span>
            {activeAttempt ? (
              <span className="row" style={{ gap: 6 }}>
                <span className="chip chip--wash mono">{activeAttempt.workerId}</span>
                <span className="faint">
                  on {activeAttempt.caseId} · heartbeat {formatAge(activeAttempt.lastHeartbeatAt ?? activeAttempt.startedAt, now)}
                </span>
              </span>
            ) : !isTerminal && liveState !== 'unknown' ? (
              <span className="faint">No attempt in progress.</span>
            ) : null}
          </div>
        )}
        <span className="faint num mono" style={{ fontSize: '0.8rem' }}>
          {events.length} events
        </span>
      </div>

      {stream.replayComplete === false ? (
        <div className="callout callout--fail" style={{ marginBottom: 16 }}>
          The catch-up window hit its size limit. Older events for this run are not shown, so this replay is incomplete.
        </div>
      ) : null}

      <div className="ws-body">
        <div className="frame case-list">
          {cases.map((c, i) => {
            const status = caseStatus(view, c.id)
            const attempts = view.caseAttempts[c.id]?.length ?? 0
            return (
              <button key={c.id} className={`case-item ${c.id === selectedCaseId ? 'on' : ''}`} onClick={() => replaceParams({ case: c.id })}>
                <StatusIcon status={status} />
                <span>
                  <span className="case-item__title">{c.title}</span>
                  <span className="faint mono" style={{ display: 'block', marginTop: 3, fontSize: '0.74rem' }}>
                    {String(i + 1).padStart(2, '0')} · {c.id}
                    {attempts > 1 ? ` · ${attempts} attempts` : ''}
                  </span>
                </span>
              </button>
            )
          })}
          {cases.length === 0 ? <div className="empty faint">Loading cases…</div> : null}
        </div>

        <div className="stack" style={{ gap: 16 }}>
          {selectedCase ? <CaseDetail testCase={selectedCase} view={view} now={now} onOpenArtifact={setArtifactId} /> : null}
        </div>

        <Timeline
          events={events}
          filter={filter}
          playhead={mode === 'replay' ? playhead : null}
          selectedSeq={seqParam}
          onSelect={(e) => {
            const caseId = e.attemptId ? stream.view.attempts[e.attemptId]?.caseId : null
            replaceParams({ mode: 'replay', seq: e.seq, case: caseId ?? params.get('case') })
          }}
        />
      </div>

      {artifactId ? <ArtifactViewer artifactId={artifactId} onClose={() => setArtifactId(null)} /> : null}
    </>
  )
}

function Counter({ n, label, status, className = '' }: { n: number; label: string; status: CaseStatus; className?: string }) {
  return (
    <div className={`counter ${className}`}>
      <div className="counter__n">
        <span>{n}</span>
      </div>
      <div className="counter__label">
        <StatusIcon status={status} size={18} />
        {label}
      </div>
    </div>
  )
}

function ReplayControls({ events, playhead }: { events: Envelope[]; playhead: number }) {
  const index = Math.max(0, events.findIndex((e) => e.seq >= playhead))
  const [playing, setPlaying] = useState(false)
  const at = events[index]

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      const i = events.findIndex((e) => e.seq > playhead)
      if (i === -1) {
        setPlaying(false)
        return
      }
      replaceParams({ seq: events[i].seq })
    }, 350)
    return () => clearInterval(t)
  }, [playing, playhead, events])

  const go = (i: number) => {
    const clamped = Math.max(0, Math.min(events.length - 1, i))
    if (events[clamped]) replaceParams({ seq: events[clamped].seq })
  }

  return (
    <div className="scrubber">
      <button className="icon-btn" onClick={() => go(0)} aria-label="First event" disabled={index === 0}>
        <StepBack size={16} />
      </button>
      <button className="icon-btn" onClick={() => go(index - 1)} aria-label="Previous event" disabled={index === 0}>
        <ChevronLeft size={16} />
      </button>
      <button className="icon-btn" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause replay' : 'Play replay'}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button className="icon-btn" onClick={() => go(index + 1)} aria-label="Next event" disabled={index >= events.length - 1}>
        <ChevronRight size={16} />
      </button>
      <button className="icon-btn" onClick={() => go(events.length - 1)} aria-label="Last event" disabled={index >= events.length - 1}>
        <StepForward size={16} />
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(0, events.length - 1)}
        value={index}
        onChange={(e) => go(Number(e.target.value))}
        aria-label="Replay position"
      />
      <span className="mono num" style={{ fontSize: '0.8rem', minWidth: 170, textAlign: 'right' }}>
        {index + 1}/{events.length} · seq {at?.seq ?? '—'} · {formatTime(at?.ts)}
      </span>
    </div>
  )
}

function CaseDetail({ testCase, view, now, onOpenArtifact }: { testCase: CaseDef; view: RunView; now: number; onOpenArtifact: (id: string) => void }) {
  const attemptIds = view.caseAttempts[testCase.id] ?? []
  const [chosen, setChosen] = useState<string | null>(null)
  useEffect(() => setChosen(null), [testCase.id])
  const attemptId = chosen && attemptIds.includes(chosen) ? chosen : attemptIds[attemptIds.length - 1]
  const attempt: AttemptView | undefined = attemptId ? view.attempts[attemptId] : undefined
  const status: CaseStatus = attempt?.status ?? 'pending'

  return (
    <>
      <div className="frame frame--pad">
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {testCase.id}
            </div>
            <h2 className="h-section" style={{ marginTop: 6 }}>
              {testCase.title}
            </h2>
            <p className="muted" style={{ margin: '8px 0 0' }}>
              {testCase.preconditions}
            </p>
          </div>
          <AttemptBadge status={status} />
        </div>
        <div className="row row--wrap" style={{ marginTop: 14 }}>
          {testCase.tags.map((t) => (
            <span key={t} className="chip chip--wash">
              {t}
            </span>
          ))}
          <span className="chip chip--line">timeout {testCase.timeoutSeconds}s</span>
          {attemptIds.length > 1 ? (
            <div className="attempt-tabs" style={{ marginLeft: 'auto' }}>
              {attemptIds.map((id) => {
                const a = view.attempts[id]
                return (
                  <button key={id} className={`btn btn--small ${id === attemptId ? '' : 'btn--ghost'}`} onClick={() => setChosen(id)}>
                    #{a.attemptNumber}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        {attempt ? (
          <>
            <hr className="rule" />
            <dl className="kv">
              <dt>Outcome</dt>
              <dd>{attempt.reason ?? (attempt.status === 'running' ? 'In progress' : '—')}</dd>
              <dt>Attempt</dt>
              <dd className="mono">
                #{attempt.attemptNumber} · {shortId(attempt.attemptId)} · {attempt.workerId} · {attempt.adapter}
              </dd>
              <dt>Timing</dt>
              <dd className="num">
                {formatTime(attempt.startedAt)} · {formatDuration(attempt.startedAt, attempt.endedAt, now)}
              </dd>
              <dt>Tool calls</dt>
              <dd className="num">
                {attempt.toolCalls}
                {attempt.rejectedToolCalls > 0 ? <span style={{ color: 'var(--fail)', fontWeight: 600 }}> · {attempt.rejectedToolCalls} rejected by policy</span> : null}
              </dd>
            </dl>
            {attempt.blockedReason ? (
              <div className="callout" style={{ marginTop: 14 }}>
                <strong>Agent reported blocked:</strong> {attempt.blockedReason}
              </div>
            ) : null}
            {attempt.lastAgentMessage ? (
              <div className="callout" style={{ marginTop: 14, background: 'var(--paper)', borderColor: 'var(--line)' }}>
                <Quote size={16} style={{ flex: 'none', marginTop: 2 }} />
                <div>
                  <div className="eyebrow" style={{ marginBottom: 4 }}>
                    Agent note · context, not a result
                  </div>
                  <span className="selectable">{attempt.lastAgentMessage}</span>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="frame frame--pad">
        <h3 className="h-card" style={{ marginBottom: 6 }}>
          Steps
        </h3>
        <ol className="steps">
          {testCase.steps.map((step, i) => {
            const sv = attempt?.steps[step.id]
            const cls = sv ? (sv.status === 'running' ? 'running' : sv.status === 'failed' ? 'failed' : 'done') : ''
            return (
              <li key={step.id}>
                <span className={`step-n ${cls ? `step-n--${cls}` : ''}`}>{i + 1}</span>
                <div>
                  <strong>{step.title}</strong>
                  <div className="muted" style={{ fontSize: '0.88rem' }}>
                    {step.instruction}
                  </div>
                  {step.request ? (
                    <div className="mono faint" style={{ marginTop: 4 }}>
                      {step.request.method} {step.request.url}
                    </div>
                  ) : null}
                </div>
                <span className="faint" style={{ fontSize: '0.82rem' }}>
                  {sv ? (sv.status === 'running' ? 'running…' : sv.status) : 'not started'}
                </span>
              </li>
            )
          })}
        </ol>
      </div>

      <div className="frame frame--pad">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 className="h-card">Assertions</h3>
          <span className="faint" style={{ fontSize: '0.84rem' }}>
            evaluated by code on recorded responses
          </span>
        </div>
        <div className="assert-row assert-row--head">
          <span />
          <span>Check</span>
          <span>Expected</span>
          <span>Actual</span>
        </div>
        {testCase.assertions.map((def) => {
          const result = attempt?.assertions.find((r) => r.assertionId === def.id)
          const st: CaseStatus = result ? result.status : attempt && attempt.status !== 'running' ? 'cancelled' : 'pending'
          return (
            <div key={def.id} className={`assert-row ${result?.status === 'failed' ? 'assert-row--failed' : ''}`}>
              <StatusIcon status={st} size={22} />
              <span>
                <strong>{def.description}</strong>
                <div className="faint mono">
                  {def.kind} · {def.stepId}
                </div>
              </span>
              <span className="mono">{result?.expected ?? (def.path ? `${def.path} == ${JSON.stringify(def.expected)}` : JSON.stringify(def.expected))}</span>
              <span className="mono actual">{result?.actual ?? <span className="faint">{st === 'pending' ? 'not evaluated yet' : 'not evaluated'}</span>}</span>
            </div>
          )
        })}
      </div>

      <div className="frame frame--pad">
        <h3 className="h-card" style={{ marginBottom: 12 }}>
          Evidence
        </h3>
        {attempt && attempt.artifactIds.length > 0 ? (
          <div className="stack" style={{ gap: 8 }}>
            {attempt.artifactIds.map((id) => {
              const art = view.artifacts[id]
              if (!art) return null
              return (
                <button key={id} className="artifact" onClick={() => onOpenArtifact(id)}>
                  <FileText size={18} />
                  <span style={{ minWidth: 0 }}>
                    <strong className="mono" style={{ fontSize: '0.84rem' }}>
                      {art.label}
                    </strong>
                    <div className="faint mono" style={{ fontSize: '0.74rem' }}>
                      {art.stepId} · sha256 {art.sha256.slice(0, 16)}… · {formatBytes(art.bytes)}
                    </div>
                  </span>
                  <span className="chip chip--wash">Open</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="faint">No artifacts recorded{attempt ? ' for this attempt' : ' yet'}.</div>
        )}
      </div>
    </>
  )
}

function Timeline({
  events,
  filter,
  playhead,
  selectedSeq,
  onSelect,
}: {
  events: Envelope[]
  filter: Filter
  playhead: number | null
  selectedSeq: number | null
  onSelect: (e: Envelope) => void
}) {
  const types = FILTERS.find((f) => f.id === filter)?.types ?? null
  const shown = types ? events.filter((e) => types.includes(e.type)) : events
  const listRef = useRef<HTMLDivElement>(null)
  const following = playhead === null

  useEffect(() => {
    if (following && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [following, shown.length])

  useEffect(() => {
    if (playhead === null || !listRef.current) return
    const el = listRef.current.querySelector(`[data-seq="${selectedSeq ?? playhead}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [playhead, selectedSeq])

  return (
    <div className="dark timeline">
      <div className="timeline__head">
        <div className="row">
          <strong style={{ fontStretch: '112%' }}>Timeline</strong>
          <span className="spacer" />
          <span className="mono" style={{ fontSize: '0.74rem', color: 'var(--on-dark-muted)' }}>
            {shown.length} shown
          </span>
        </div>
        <div className="timeline__filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => replaceParams({ filter: f.id === 'all' ? null : f.id })}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline__list" ref={listRef}>
        {shown.length === 0 ? <div style={{ padding: 18, color: 'var(--on-dark-muted)' }}>No events match.</div> : null}
        {shown.map((e) => {
          const future = playhead !== null && e.seq > playhead
          const head = playhead !== null && e.seq === (selectedSeq ?? playhead)
          const tone = e.type === 'assertion_failed' || e.type === 'tool_rejected' || e.type === 'run_failed' || (e.type === 'attempt_finished' && ['failed', 'error'].includes(String(e.payload.status)))
            ? 'fail'
            : e.type === 'assertion_passed' || (e.type === 'attempt_finished' && e.payload.status === 'passed')
              ? 'pass'
              : ''
          return (
            <div key={e.seq} data-seq={e.seq} className={`ev ${future ? 'ev--future' : ''} ${head ? 'ev--head' : ''}`} onClick={() => onSelect(e)}>
              <span className="ev__seq">{e.seq}</span>
              <span>
                <span className={`ev__type ${tone ? `ev__type--${tone}` : ''}`}>{e.type}</span>
                <span style={{ color: 'var(--on-dark-muted)' }}> · {formatTime(e.ts)}</span>
                <div className="ev__detail">{describe(e)}</div>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
