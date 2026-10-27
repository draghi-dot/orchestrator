import { ArrowUpRight, FileText } from 'lucide-react'
import { useState } from 'react'
import type { ReviewDecision } from '../../../shared/domain'
import type { ReviewItem } from '../../../shared/ipc'
import { ArtifactViewer } from '../components/ArtifactViewer'
import { AttemptBadge, Empty, StatusIcon, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'
import { formatDateTime, shortId } from '../lib/format'
import { useLive } from '../lib/stream'

const DECISIONS: { id: ReviewDecision; label: string; hint: string }[] = [
  { id: 'confirmed_defect', label: 'Confirm defect', hint: 'The application is wrong.' },
  { id: 'flaky', label: 'Flaky', hint: 'Passes on retry; track as attempt history.' },
  { id: 'needs_case_fix', label: 'Fix the case', hint: 'The test or its data is wrong.' },
  { id: 'not_a_bug', label: 'Not a bug', hint: 'Expected behavior; close it.' },
]

const DECISION_LABEL = Object.fromEntries(DECISIONS.map((d) => [d.id, d.label])) as Record<ReviewDecision, string>

export function ReviewScreen() {
  const live = useLive()
  const queue = useQuery('reviewQueue', undefined, live.version)
  const reviews = useQuery('reviews', undefined, live.version)
  const [artifactId, setArtifactId] = useState<string | null>(null)

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Triage</div>
          <h1 className="h-display" style={{ marginTop: 8 }}>
            Review
          </h1>
          <p className="lede">Failed, blocked, and errored cases wait here for a human decision. Every decision is recorded with its reason.</p>
        </div>
      </div>

      <div className="section-head">
        <h2 className="h-section">Queue</h2>
        <span className="faint num">{queue.data?.length ?? 0}</span>
      </div>
      {queue.data && queue.data.length === 0 ? (
        <div className="frame">
          <Empty title="Queue is clear">Nothing needs a decision right now.</Empty>
        </div>
      ) : (
        <div className="stack">
          {(queue.data ?? []).map((item) => (
            <ReviewCard key={item.attempt.id} item={item} onOpenArtifact={setArtifactId} />
          ))}
        </div>
      )}

      <div className="section-head">
        <h2 className="h-section">Audit trail</h2>
        <span className="faint num">{reviews.data?.length ?? 0}</span>
      </div>
      <div className="frame" style={{ overflow: 'hidden' }}>
        {reviews.data && reviews.data.length > 0 ? (
          <table className="table">
            <thead>
              <tr>
                <th>Decision</th>
                <th>Case</th>
                <th>Reason</th>
                <th>Reviewer</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reviews.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className={`chip ${r.decision === 'confirmed_defect' ? 'chip--fail' : r.decision === 'flaky' ? 'chip--accent' : 'chip--line'}`}>
                      {DECISION_LABEL[r.decision]}
                    </span>
                  </td>
                  <td className="mono">{r.caseId}</td>
                  <td>{r.reason}</td>
                  <td>{r.reviewer}</td>
                  <td className="num">{formatDateTime(r.createdAt)}</td>
                  <td>
                    <a className="btn btn--small btn--ghost" href={`#/runs/${r.runId}?case=${encodeURIComponent(r.caseId)}`}>
                      Run
                      <ArrowUpRight size={14} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No decisions yet" />
        )}
      </div>

      {artifactId ? <ArtifactViewer artifactId={artifactId} onClose={() => setArtifactId(null)} /> : null}
    </>
  )
}

function ReviewCard({ item, onOpenArtifact }: { item: ReviewItem; onOpenArtifact: (id: string) => void }) {
  const toast = useToast()
  const [decision, setDecision] = useState<ReviewDecision | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const notable = item.assertions.filter((a) => a.status !== 'passed')

  const submit = async () => {
    if (!decision || !reason.trim()) return
    setSubmitting(true)
    try {
      await command({ type: 'recordReview', attemptId: item.attempt.id, decision, reason })
      toast.show(`Recorded: ${DECISION_LABEL[decision]}`)
      // The card leaves the queue when the review_recorded event refetches it.
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'fail')
      setSubmitting(false)
    }
  }

  return (
    <div className="frame frame--pad drop">
      <div className="grid-2" style={{ gap: 28, gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>
        <div>
          <div className="row row--wrap">
            <AttemptBadge status={item.attempt.status} />
            <span className="chip chip--line">{item.run.suiteName}</span>
            <span className="chip chip--line">
              build <span className="mono">{item.run.contract.buildRevision}</span>
            </span>
            <span className="chip chip--wash">attempt #{item.attempt.attemptNumber}</span>
          </div>
          <h3 className="h-section" style={{ marginTop: 12 }}>
            {item.caseTitle}
          </h3>
          <div className="muted" style={{ marginTop: 4 }}>
            {item.attempt.terminalReason}
          </div>
          {notable.length > 0 ? (
            <div style={{ marginTop: 14 }}>
              {notable.map((a) => (
                <div key={a.id} className={`assert-row ${a.status === 'failed' ? 'assert-row--failed' : ''}`} style={{ gridTemplateColumns: '24px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)' }}>
                  <StatusIcon status={a.status} size={22} />
                  <span className="mono">{a.assertionId}</span>
                  <span className="mono">expected {a.expected}</span>
                  <span className="mono actual">actual {a.actual}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="row row--wrap" style={{ marginTop: 14 }}>
            {item.artifacts.map((art) => (
              <button key={art.id} className="btn btn--small btn--ghost" onClick={() => onOpenArtifact(art.id)}>
                <FileText size={14} />
                <span className="mono">{art.label}</span>
              </button>
            ))}
            <a className="btn btn--small btn--ghost" href={`#/runs/${item.run.id}?case=${encodeURIComponent(item.attempt.caseId)}`}>
              Open in run {shortId(item.run.id)}
              <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="field">
            <span>Decision</span>
            <div className="grid-2" style={{ gap: 8 }}>
              {DECISIONS.map((d) => (
                <label key={d.id} className={`check ${decision === d.id ? 'check--on' : ''}`} title={d.hint}>
                  <input type="radio" name={`decision-${item.attempt.id}`} checked={decision === d.id} onChange={() => setDecision(d.id)} />
                  <span>
                    <strong style={{ fontSize: '0.9rem' }}>{d.label}</strong>
                    <div className="faint" style={{ fontSize: '0.78rem' }}>
                      {d.hint}
                    </div>
                  </span>
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Reason (required, kept in the audit trail)</span>
            <textarea className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What did you check?" />
          </label>
          <div className="row">
            <span className="spacer" />
            <button className="btn" disabled={!decision || !reason.trim() || submitting} onClick={submit}>
              {submitting ? 'Recording…' : 'Record decision'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
