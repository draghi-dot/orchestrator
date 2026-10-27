import { Ban, Check, CircleDashed, Loader, OctagonAlert, Pause, Square, X } from 'lucide-react'
import { type ReactNode, createContext, useCallback, useContext, useState } from 'react'
import type { AttemptStatus, RunState, RunSummary } from '../../../shared/domain'
import type { ConnectionStatus } from '../lib/stream'

export type CaseStatus = AttemptStatus | 'pending'

const ATTEMPT_LABEL: Record<CaseStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  error: 'Error',
  cancelled: 'Cancelled',
}

export function StatusIcon({ status, size = 24 }: { status: CaseStatus; size?: number }) {
  const icon = size * 0.58
  const glyph = {
    pending: <CircleDashed size={icon} />,
    running: <Loader size={icon} className="spin" />,
    passed: <Check size={icon} strokeWidth={3} />,
    failed: <X size={icon} strokeWidth={3} />,
    blocked: <Ban size={icon} strokeWidth={2.5} />,
    error: <OctagonAlert size={icon} strokeWidth={2.5} />,
    cancelled: <Square size={icon * 0.8} />,
  }[status]
  return (
    <span className={`status-icon status-icon--${status}`} style={{ width: size, height: size }} aria-label={ATTEMPT_LABEL[status]} title={ATTEMPT_LABEL[status]}>
      {glyph}
    </span>
  )
}

export function AttemptBadge({ status }: { status: CaseStatus }) {
  const cls = {
    pending: 'chip--muted',
    running: 'chip--line',
    passed: '',
    failed: 'chip--fail',
    blocked: 'chip--accent',
    error: 'chip--error',
    cancelled: 'chip--muted',
  }[status]
  return (
    <span className={`chip ${cls}`}>
      {status === 'running' ? <span className="dot dot--live" /> : null}
      {ATTEMPT_LABEL[status]}
    </span>
  )
}

const RUN_LABEL: Record<RunState | 'unknown', string> = {
  unknown: 'Loading',
  queued: 'Queued',
  running: 'Running',
  pause_requested: 'Pausing…',
  paused: 'Paused',
  cancel_requested: 'Cancelling…',
  completed: 'Completed',
  failed: 'Run failed',
  cancelled: 'Cancelled',
}

export function RunStateBadge({ state }: { state: RunState | 'unknown' }) {
  switch (state) {
    case 'running':
      return (
        <span className="chip chip--line">
          <span className="dot dot--live" />
          Running
        </span>
      )
    case 'pause_requested':
    case 'cancel_requested':
      return (
        <span className="chip chip--dashed">
          <Loader size={13} className="spin" />
          {RUN_LABEL[state]}
        </span>
      )
    case 'paused':
      return (
        <span className="chip chip--accent">
          <Pause size={13} strokeWidth={3} />
          Paused
        </span>
      )
    case 'completed':
      return (
        <span className="chip">
          <Check size={13} strokeWidth={3} />
          Completed
        </span>
      )
    case 'failed':
      return (
        <span className="chip chip--fail">
          <OctagonAlert size={13} strokeWidth={2.5} />
          Run failed
        </span>
      )
    case 'cancelled':
      return (
        <span className="chip chip--muted">
          <Square size={11} />
          Cancelled
        </span>
      )
    default:
      return <span className="chip chip--muted">{RUN_LABEL[state]}</span>
  }
}

export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const label = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', disconnected: 'Disconnected' }[status]
  return (
    <span className={`conn conn--${status}`} title="Event stream from the control plane">
      {status === 'live' ? <span className="dot dot--live" /> : status === 'connecting' ? <Loader size={12} className="spin" /> : <span className="dot" />}
      {label}
    </span>
  )
}

export function ProgressBar({ summary, running = 0 }: { summary: RunSummary; running?: number }) {
  const total = Math.max(summary.total, 1)
  const pct = (n: number) => `${(n / total) * 100}%`
  return (
    <div
      className="progress"
      role="img"
      aria-label={`${summary.passed} passed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.error} errors of ${summary.total}`}
    >
      <span className="p-pass" style={{ width: pct(summary.passed) }} />
      <span className="p-fail" style={{ width: pct(summary.failed) }} />
      <span className="p-block" style={{ width: pct(summary.blocked) }} />
      <span className="p-error" style={{ width: pct(summary.error) }} />
      <span className="p-cancel" style={{ width: pct(summary.cancelled) }} />
      <span className="p-run" style={{ width: pct(running) }} />
    </div>
  )
}

export function Counts({ summary }: { summary: RunSummary }) {
  return (
    <span className="counts">
      <span title="Passed">
        <StatusIcon status="passed" size={18} />
        {summary.passed}
      </span>
      <span title="Failed">
        <StatusIcon status="failed" size={18} />
        {summary.failed}
      </span>
      <span title="Blocked">
        <StatusIcon status="blocked" size={18} />
        {summary.blocked}
      </span>
      <span title="Errors">
        <StatusIcon status="error" size={18} />
        {summary.error}
      </span>
    </span>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <div className="empty__big">{title}</div>
        {children ? <div className="muted">{children}</div> : null}
        {action ? <div style={{ marginTop: 18 }}>{action}</div> : null}
      </div>
    </div>
  )
}

interface ToastValue {
  show(message: string, tone?: 'info' | 'fail'): void
}

const ToastContext = createContext<ToastValue>({ show: () => undefined })

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'fail'; id: number } | null>(null)
  const show = useCallback((message: string, tone: 'info' | 'fail' = 'info') => {
    const id = Date.now()
    setToast({ message, tone, id })
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 5000)
  }, [])
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast ? (
        <div className={`toast ${toast.tone === 'fail' ? 'toast--fail' : ''}`} role="status" onClick={() => setToast(null)}>
          {toast.message}
        </div>
      ) : null}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
