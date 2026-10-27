import { useEffect, useMemo, useRef, useState } from 'react'
import type { Depth, Roster, TestMode } from '../../../shared/domain'
import { DEPTH_LIMITS } from '../../../shared/domain'
import { type Answers, buildQuestionnaire, setupFromAnswers } from '../../../shared/questionnaire'
import { Header } from '../App'
import { AREA, DEPTH, FOCUS, METHOD, PROVIDER, plural } from '../copy'
import { AgentTable } from '../components/AgentTable'
import { I } from '../components/icons'
import { Empty, ErrorBanner, Field, Loading, Modal, useAction, useToast } from '../components/ui'
import { command, newIdempotencyKey, useQuery } from '../lib/api'
import { navigate } from '../lib/router'
import { OFFLINE_ROSTER } from './offlineRoster'

export function NewAuditScreen({ projectId }: { projectId: string | null }) {
  const overview = useQuery('overview', undefined)
  const targets = overview.data?.targets ?? []
  const chosen = projectId ?? targets.find((t) => t.source.kind === 'sample')?.id ?? targets[0]?.id ?? null

  return (
    <>
      <Header title="New audit" crumbs={[{ label: 'Audits', href: '#/audits' }]} />
      <div className="content">
        <div className="page" style={{ maxWidth: 980 }}>
          <ErrorBanner error={overview.error} />
          {!overview.data ? (
            <Loading />
          ) : chosen ? (
            <AuditForm key={chosen} targetId={chosen} />
          ) : (
            <div className="card">
              <Empty
                icon={<I.projects size={22} />}
                title="Import a project first"
                actions={
                  <button className="btn btn--primary" onClick={() => navigate('/projects', { import: 1 })}>
                    Import a project
                  </button>
                }
              >
                An audit runs against a snapshot of a project from GitHub or a ZIP file.
              </Empty>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function AuditForm({ targetId }: { targetId: string }) {
  const overview = useQuery('overview', undefined)
  const setup = useQuery('targetSetup', { targetId })
  const settings = useQuery('settings', undefined)
  const accounts = useQuery('accounts', undefined)
  const [answers, setAnswers] = useState<Answers | null>(null)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [allowLocal, setAllowLocal] = useState(false)
  const [addingAccount, setAddingAccount] = useState(false)
  const key = useRef(newIdempotencyKey())
  const start = useAction()

  const snapshot = setup.data?.target.latestSnapshot ?? null
  const questionnaire = useMemo(
    () =>
      snapshot && setup.data
        ? buildQuestionnaire({
            stack: snapshot.stack,
            accounts: setup.data.accounts.filter((a) => a.configured).map((a) => a.name),
            trusted: setup.data.target.source.kind === 'sample',
            knowledgeDocs: setup.data.knowledgeDocs,
          })
        : null,
    [snapshot, setup.data],
  )

  useEffect(() => {
    if (!answers && questionnaire && setup.data) {
      setAnswers(questionnaire.defaults)
      setAllowLocal(setup.data.target.source.kind === 'sample')
    }
  }, [answers, questionnaire, setup.data])
  useEffect(() => {
    if (!roster && settings.data) setRoster(settings.data.defaultRoster)
  }, [roster, settings.data])

  if (setup.error) return <ErrorBanner error={setup.error} />
  if (!answers || !roster || !setup.data || !snapshot || !questionnaire) return <Loading />

  const target = setup.data.target
  const update = <K extends keyof Answers>(k: K, v: Answers[K]) => {
    key.current = newIdempotencyKey()
    setAnswers({ ...answers, [k]: v })
  }
  const toggle = (k: 'areas' | 'focus' | 'accounts', v: string) => update(k, answers[k].includes(v) ? answers[k].filter((x) => x !== v) : [...answers[k], v])
  const areaOptions = questionnaire.questions.find((q) => q.id === 'areas')?.options ?? []
  const runsApp = answers.mode !== 'white'
  const ready = answers.focus.length > 0 && (!runsApp || (answers.where === 'local' ? allowLocal : answers.url.trim().length > 0))
  const providers = [...new Set(Object.values(roster).map((p) => PROVIDER[p.runtime].name))].join(', ')
  const limits = DEPTH_LIMITS[answers.depth]

  const submit = () =>
    void start.run(async () => {
      const input = setupFromAnswers(answers)
      const result = await command({ type: 'startRun', idempotencyKey: key.current, targetId, ...input, roster })
      navigate(`/audits/${result.runId}`)
    })

  return (
    <>
      <div className="page-intro">
        <div>
          <h1>New audit</h1>
          <p>Choose what to test and how. Every finding is reviewed by a second agent and verified before it counts.</p>
        </div>
      </div>
      <ErrorBanner error={start.error} />

      <section className="form-section">
        <div className="form-section__intro">
          <h2>Project</h2>
          <p>The audit runs on a frozen snapshot.</p>
        </div>
        <div className="stack stack--sm">
          <select className="select" value={targetId} aria-label="Project" onChange={(e) => navigate('/new', { project: e.target.value })}>
            {overview.data?.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <div className="small muted">
            {snapshot.stack.languages.map((l) => l.name).join(', ') || 'Unknown stack'}, {plural(snapshot.fileCount, 'file')}, {plural(snapshot.stack.routes.length, 'route')} found
            {'  '}
            <a className="link" href={`#/projects?id=${target.id}`}>
              Project details
            </a>
          </div>
        </div>
      </section>

      <section className="form-section">
        <div className="form-section__intro">
          <h2>Scope</h2>
          <p>Areas found while reading the code. Pick what matters most.</p>
        </div>
        <div className="checks">
          {areaOptions.map((o) => {
            const on = answers.areas.includes(o.value)
            return (
              <label key={o.value} className={`check ${on ? 'check--on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggle('areas', o.value)} />
                <span>
                  <strong>{AREA[o.value as keyof typeof AREA] ?? o.label}</strong>
                  {o.hint && <small>{o.hint}</small>}
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section className="form-section">
        <div className="form-section__intro">
          <h2>How to test</h2>
          <p>Live testing runs the app or calls a URL you are allowed to test.</p>
        </div>
        <div className="stack">
          <div className="choice-cards">
            {(['white', 'black', 'both'] as TestMode[]).map((m) => (
              <label key={m} className={`check ${answers.mode === m ? 'check--on' : ''}`}>
                <input type="radio" name="mode" checked={answers.mode === m} onChange={() => update('mode', m)} />
                <span>
                  <strong>{METHOD[m].name}</strong>
                  <small>{METHOD[m].hint}</small>
                </span>
              </label>
            ))}
          </div>
          {runsApp && (
            <div className="card card--pad stack stack--sm">
              <div className="segmented" role="radiogroup" aria-label="Where the app runs">
                <button className={answers.where === 'local' ? 'on' : ''} onClick={() => update('where', 'local')}>
                  Run on this Mac
                </button>
                <button className={answers.where === 'url' ? 'on' : ''} onClick={() => update('where', 'url')}>
                  Test a URL
                </button>
              </div>
              {answers.where === 'local' ? (
                <label className="toggle-row">
                  <input type="checkbox" checked={allowLocal} onChange={(e) => setAllowLocal(e.target.checked)} />
                  <span>
                    Allow Baton to run this project’s install and start commands on this Mac
                    <span className="field__hint" style={{ display: 'block' }}>
                      {snapshot.stack.commands.start ? `Starts with ${snapshot.stack.commands.start}. ` : ''}Only allow this for code you trust.
                    </span>
                  </span>
                </label>
              ) : (
                <Field label="Test URL" hint="Agents can only reach this address, with read-only requests.">
                  <input className="input" placeholder="https://staging.example.com" value={answers.url} onChange={(e) => update('url', e.target.value)} />
                </Field>
              )}
              <div className="row" style={{ marginTop: 4 }}>
                <span className="field__label">Test accounts</span>
                <span className="spacer" />
                <button className="btn btn--sm btn--ghost" onClick={() => setAddingAccount(true)}>
                  <I.plus size={14} />
                  Add account
                </button>
              </div>
              {setup.data.accounts.length ? (
                <div className="row row--wrap">
                  {setup.data.accounts.map((a) => (
                    <label key={a.name} className="toggle-row" style={{ marginRight: 16 }}>
                      <input type="checkbox" disabled={!a.configured} checked={answers.accounts.includes(a.name)} onChange={() => toggle('accounts', a.name)} />
                      <span>{a.name}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="small faint">None. Add one to let agents test signed-in features. Credentials stay on this Mac.</div>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="form-section">
        <div className="form-section__intro">
          <h2>Focus</h2>
          <p>Agents prioritize these.</p>
        </div>
        <div className="checks">
          {(Object.keys(FOCUS) as (keyof typeof FOCUS)[]).map((f) => {
            const on = answers.focus.includes(f)
            return (
              <label key={f} className={`check ${on ? 'check--on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggle('focus', f)} />
                <span>
                  <strong>{FOCUS[f].name}</strong>
                  <small>{FOCUS[f].hint}</small>
                </span>
              </label>
            )
          })}
        </div>
      </section>

      <section className="form-section">
        <div className="form-section__intro">
          <h2>Agents</h2>
          <p>Use a different provider for testing and review so each one checks the other.</p>
          <button className="link small" style={{ marginTop: 8 }} onClick={() => setRoster(OFFLINE_ROSTER)}>
            Use built-in agents only
          </button>
        </div>
        <AgentTable value={roster} onChange={setRoster} accounts={accounts.data} />
      </section>

      <details className="fold">
        <summary>
          <I.caretRight size={14} />
          Advanced
        </summary>
        <div className="stack" style={{ paddingBottom: 12 }}>
          <div className="field">
            <span className="field__label">Depth</span>
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              {(['fast', 'balanced', 'deep'] as Depth[]).map((d) => (
                <button key={d} className={answers.depth === d ? 'on' : ''} onClick={() => update('depth', d)}>
                  {DEPTH[d]}
                </button>
              ))}
            </div>
            <span className="field__hint">
              Up to {plural(limits.maxRounds, 'review round')} and {plural(limits.maxClaims, 'finding')}.
            </span>
          </div>
          <Field label="Exclude paths" hint="Comma separated. Agents will not see these files.">
            <input className="input" placeholder="docs/, vendor/" value={answers.exclude} onChange={(e) => update('exclude', e.target.value)} />
          </Field>
          {setup.data.knowledgeDocs > 0 && (
            <label className="toggle-row">
              <input type="checkbox" checked={answers.knowledge === 'yes'} onChange={(e) => update('knowledge', e.target.checked ? 'yes' : 'no')} />
              <span>
                Let agents search the knowledge library ({plural(setup.data.knowledgeDocs, 'writeup')})
                <span className="field__hint" style={{ display: 'block' }}>
                  Used as background only, never as evidence.
                </span>
              </span>
            </label>
          )}
          <Field label="Instructions">
            <textarea className="textarea" rows={3} placeholder="Focus on checkout; ignore styling; never delete data." value={answers.instructions} onChange={(e) => update('instructions', e.target.value)} />
          </Field>
        </div>
      </details>

      <div className="footer-bar">
        <span className="small muted truncate">
          {target.name}, {METHOD[answers.mode].name.toLowerCase()}, {DEPTH[answers.depth].toLowerCase()}, {providers}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => navigate('/audits')}>
          Cancel
        </button>
        <button className="btn btn--primary" disabled={!ready || start.busy} onClick={submit}>
          {start.busy ? 'Starting' : 'Start audit'}
        </button>
      </div>

      {addingAccount && (
        <AccountModal
          targetId={targetId}
          onClose={() => setAddingAccount(false)}
          onSaved={(name) => {
            setup.refetch()
            update('accounts', [...answers.accounts, name])
            setAddingAccount(false)
          }}
        />
      )}
    </>
  )
}

export function AccountModal({ targetId, onClose, onSaved }: { targetId: string; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState('')
  const [header, setHeader] = useState('Authorization')
  const [value, setValue] = useState('')
  const save = useAction()
  const toast = useToast()
  return (
    <Modal
      title="Add test account"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={save.busy || !name.trim() || !value.trim()}
            onClick={() =>
              void save.run(async () => {
                await command({ type: 'setTestAccount', targetId, name: name.trim(), headerName: header.trim(), headerValue: value })
                toast('Test account saved')
                onSaved(name.trim())
              })
            }
          >
            Save account
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">Agents only see the account name. Baton adds the credential to their requests, and it never leaves this Mac.</p>
        <ErrorBanner error={save.error} />
        <Field label="Name">
          <input className="input" placeholder="alice" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Header">
            <input className="input" value={header} onChange={(e) => setHeader(e.target.value)} />
          </Field>
          <Field label="Value">
            <input className="input" type="password" autoComplete="new-password" placeholder="Bearer …" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
