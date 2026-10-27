import { useState } from 'react'
import type { Role, RuleChange } from '../../../shared/domain'
import { ROLES } from '../../../shared/domain'
import { Header } from '../App'
import { AGENT, PROVIDER } from '../copy'
import { AGENT_ICON, I } from '../components/icons'
import { Empty, ErrorBanner, Field, Loading, Modal, Pill, Tabs, useAction, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLive } from '../lib/stream'

type Tab = 'guidelines' | 'suggestions' | 'history'

export function PlaybookScreen() {
  const live = useLive()
  const q = useQuery('dna', undefined, live.version)
  const [tab, setTab] = useState<Tab>('guidelines')
  const [deciding, setDeciding] = useState<RuleChange | null>(null)

  return (
    <>
      <Header title="Playbook" actions={q.data && <Pill tone="outline">Version {q.data.current.version}</Pill>} />
      <div className="content">
        <div className="page">
          <div className="page-intro">
            <div>
              <h1>Playbook</h1>
              <p>Guidelines every agent follows. After each audit the learn agent suggests changes; nothing changes until you approve it.</p>
            </div>
          </div>
          <ErrorBanner error={q.error} />
          {!q.data ? (
            <Loading />
          ) : (
            <>
              <Tabs<Tab>
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'guidelines', label: 'Guidelines', count: q.data.current.rules.length },
                  { id: 'suggestions', label: 'Suggestions', count: q.data.pending.length },
                  { id: 'history', label: 'History' },
                ]}
              />
              {tab === 'guidelines' && (
                <div className="stack">
                  {(['all', ...ROLES] as (Role | 'all')[]).map((role) => {
                    const rules = q.data!.current.rules.filter((r) => r.role === role)
                    if (!rules.length) return null
                    const Icon = role === 'all' ? I.playbook : AGENT_ICON[role]
                    return (
                      <div className="card" key={role}>
                        <div className="card__head">
                          <span className="agent-icon">
                            <Icon size={15} />
                          </span>
                          <h3>{role === 'all' ? 'All agents' : AGENT[role].title}</h3>
                        </div>
                        {rules.map((r) => (
                          <div className="list-row" key={r.id}>
                            <div className="list-row__main">
                              <div className="selectable">{r.text}</div>
                              <div className="list-row__sub">{r.origin.runId ? `Added in version ${r.addedInVersion}, suggested by ${r.origin.runtime ? PROVIDER[r.origin.runtime].name : 'an agent'}` : 'Starter guideline'}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}
              {tab === 'suggestions' &&
                (q.data.pending.length ? (
                  <div className="card">
                    {q.data.pending.map((c) => (
                      <div className="list-row" key={c.id}>
                        <Pill tone={c.op === 'add' ? 'accent' : 'warning'}>{c.op === 'add' ? 'Add' : 'Remove'}</Pill>
                        <div className="list-row__main">
                          <div className="list-row__title selectable">{c.text}</div>
                          <div className="list-row__sub selectable">
                            {c.role === 'all' ? 'All agents' : AGENT[c.role].title}, from the {c.targetName} audit: {c.rationale}
                          </div>
                        </div>
                        <button className="btn btn--sm" onClick={() => setDeciding(c)}>
                          Review
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="card">
                    <Empty icon={<I.playbook size={22} />} title="No suggestions">
                      The learn agent suggests changes after each audit.
                    </Empty>
                  </div>
                ))}
              {tab === 'history' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Version</th>
                        <th>Change</th>
                        <th>By</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.history.map((v) => (
                        <tr key={v.id}>
                          <td className="tnum">{v.version}</td>
                          <td>{v.note}</td>
                          <td className="muted">{v.createdBy}</td>
                          <td className="muted tnum">{formatDateTime(v.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {deciding && <DecideModal change={deciding} onClose={() => setDeciding(null)} onDone={q.refetch} />}
    </>
  )
}

function DecideModal({ change, onClose, onDone }: { change: RuleChange; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const work = useAction()
  const toast = useToast()
  const decide = (decision: 'accepted' | 'rejected') =>
    void work.run(async () => {
      await command({ type: 'decideRuleChange', changeId: change.id, decision, reason })
      toast(decision === 'accepted' ? 'Playbook updated' : 'Suggestion declined')
      onDone()
      onClose()
    })
  return (
    <Modal
      title="Review suggestion"
      onClose={onClose}
      footer={
        <>
          <button className="btn" disabled={work.busy || !reason.trim()} onClick={() => decide('rejected')}>
            Decline
          </button>
          <button className="btn btn--primary" disabled={work.busy || !reason.trim()} onClick={() => decide('accepted')}>
            Approve
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="card card--pad">
          <div className="small faint" style={{ marginBottom: 4 }}>
            {change.op === 'add' ? 'Add guideline' : 'Remove guideline'} for {change.role === 'all' ? 'all agents' : AGENT[change.role].title.toLowerCase()}
          </div>
          <div className="selectable">{change.text}</div>
        </div>
        <div>
          <div className="field__label" style={{ marginBottom: 4 }}>
            Why the agent suggests it
          </div>
          <p className="small muted selectable">{change.rationale}</p>
        </div>
        <ErrorBanner error={work.error} />
        <Field label="Your note">
          <textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Kept in the playbook history." />
        </Field>
      </div>
    </Modal>
  )
}
