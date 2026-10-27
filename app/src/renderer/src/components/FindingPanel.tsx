import { useState } from 'react'
import type { Run } from '../../../shared/domain'
import { TERMINAL_RUN_STATES } from '../../../shared/domain'
import type { Finding } from '../../../shared/ipc'
import { AGENT, CATEGORY, EVIDENCE, FINDING_STATUS, PROVIDER, STANCE } from '../copy'
import { command } from '../lib/api'
import { ArtifactViewer } from './ArtifactViewer'
import { I } from './icons'
import { ErrorBanner, Pill, Severity, SidePanel, useAction, useToast } from './ui'

export const effectiveStatus = (f: Finding) => (f.review ? (f.review.decision === 'accepted' ? 'confirmed' : 'rejected') : f.status)

export function FindingPanel({ finding, run, onClose, onChanged }: { finding: Finding; run: Run; onClose: () => void; onChanged: () => void }) {
  const [artifact, setArtifact] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const action = useAction()
  const toast = useToast()
  const status = FINDING_STATUS[effectiveStatus(finding)]
  const latest = finding.verifications.at(-1)
  const canDecide = TERMINAL_RUN_STATES.has(run.state) && !finding.review && (finding.status === 'needs_review' || finding.status === 'inconclusive')

  const decide = (decision: 'accepted' | 'rejected') =>
    void action.run(async () => {
      await command({ type: 'reviewClaim', claimId: finding.id, decision, reason })
      toast(decision === 'accepted' ? 'Finding confirmed' : 'Marked as false positive')
      onChanged()
      onClose()
    })

  return (
    <>
      <SidePanel
        onClose={onClose}
        head={
          <>
            <div className="row row--wrap" style={{ marginBottom: 8 }}>
              <Pill tone={status.tone} dot title={status.hint}>
                {status.label}
              </Pill>
              <Severity level={finding.severity} />
              <span className="faint small">{CATEGORY[finding.category]}</span>
            </div>
            <h2 className="selectable">{finding.title}</h2>
            <div className="small muted" style={{ marginTop: 4 }}>
              {run.contract.targetName}
              {finding.location && (
                <>
                  {'  '}
                  <span className="mono">{finding.location}</span>
                </>
              )}
            </div>
          </>
        }
        footer={
          canDecide ? (
            <div className="stack stack--sm">
              <ErrorBanner error={action.error} />
              <textarea className="textarea" rows={2} placeholder="Why? This note is kept with the decision." value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="row">
                <button className="btn btn--primary" disabled={action.busy || !reason.trim()} onClick={() => decide('accepted')}>
                  Confirm finding
                </button>
                <button className="btn" disabled={action.busy || !reason.trim()} onClick={() => decide('rejected')}>
                  Mark as false positive
                </button>
              </div>
            </div>
          ) : finding.review ? (
            <div className="small muted">
              {finding.review.decision === 'accepted' ? 'Confirmed' : 'Marked as false positive'} by {finding.review.reviewer}: {finding.review.reason}
            </div>
          ) : finding.status === 'needs_review' || finding.status === 'inconclusive' ? (
            <div className="small muted">You can confirm or dismiss this finding when the audit finishes.</div>
          ) : undefined
        }
      >
        <section className="block">
          <h3>What was reported</h3>
          <p className="prose">{finding.detail}</p>
          <p className="small faint" style={{ marginTop: 8 }}>
            Reported by {AGENT[finding.role].title} using {PROVIDER[finding.runtime].name}
            {finding.round > 1 ? `, updated in review round ${finding.round}` : ''}
          </p>
        </section>

        <section className="block">
          <h3>Verification</h3>
          {latest ? (
            <div className="stack stack--sm">
              <div className="row">
                <Pill tone={EVIDENCE[latest.outcome].tone === 'danger' ? 'danger' : 'neutral'}>{EVIDENCE[latest.outcome].label}</Pill>
              </div>
              {latest.expected !== null && (
                <dl className="compare">
                  <dt>Expected</dt>
                  <dd>{latest.expected}</dd>
                  <dt>Actual</dt>
                  <dd>{latest.actual}</dd>
                </dl>
              )}
              <p className="small muted">{finding.verdictReason ?? latest.detail}</p>
              {latest.artifactId && (
                <button className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => setArtifact(latest.artifactId)}>
                  View recorded response
                </button>
              )}
            </div>
          ) : (
            <p className="small muted">Not verified yet.</p>
          )}
        </section>

        {finding.challenges.length > 0 && (
          <section className="block">
            <h3>Review</h3>
            {finding.challenges.map((c) => (
              <div className="review-entry" key={c.id}>
                <Pill tone={STANCE[c.stance].tone}>{STANCE[c.stance].label}</Pill>
                <span className="small muted">
                  Review agent using {PROVIDER[c.runtime].name}
                  {c.round > 1 ? `, round ${c.round}` : ''}
                </span>
                <p className="selectable">{c.reasoning}</p>
              </div>
            ))}
          </section>
        )}

        {finding.reproduction && (
          <section className="block">
            <h3>How to reproduce</h3>
            <ol className="repro-steps">
              {finding.reproduction.steps.map((s, n) => (
                <li key={n} className="selectable">
                  <span>
                    {s.method} {s.path}
                    {s.as ? <span className="faint"> as {s.as}</span> : null}
                    {s.body ? <div className="faint">{s.body}</div> : null}
                  </span>
                </li>
              ))}
            </ol>
            <p className="small muted" style={{ marginTop: 8 }}>
              A correct app returns{' '}
              <span className="mono">
                {finding.reproduction.check.kind === 'status_equals'
                  ? `status ${finding.reproduction.check.expected}`
                  : finding.reproduction.check.kind === 'body_contains'
                    ? `a body containing ${JSON.stringify(finding.reproduction.check.expected)}`
                    : `${finding.reproduction.check.path} = ${JSON.stringify(finding.reproduction.check.expected)}`}
              </span>
            </p>
          </section>
        )}

        {finding.evidenceQuote && (
          <section className="block">
            <h3>Code</h3>
            <pre className="code">{finding.evidenceQuote}</pre>
          </section>
        )}

        <section className="block">
          <h3>Why this severity</h3>
          <p className="prose">{finding.severityRationale}</p>
        </section>

        {finding.suggestedFix && (
          <section className="block">
            <h3>Suggested fix</h3>
            <p className="prose">{finding.suggestedFix}</p>
          </section>
        )}

        {finding.regressionTestArtifactId && (
          <section className="block">
            <h3>Regression test</h3>
            <div className="row">
              <button className="btn btn--sm" onClick={() => setArtifact(finding.regressionTestArtifactId)}>
                <I.code size={14} />
                View test
              </button>
              <span className="small muted">A runnable test that fails until the issue is fixed.</span>
            </div>
          </section>
        )}
      </SidePanel>
      {artifact && <ArtifactViewer artifactId={artifact} onClose={() => setArtifact(null)} />}
    </>
  )
}
