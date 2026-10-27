import { useEffect, useRef, useState } from 'react'
import type { Roster } from '../../../shared/domain'
import { DEPTH_LIMITS, MODE_LABEL, PHASE_LABEL, PHASES } from '../../../shared/domain'
import { buildQuestionnaire, setupFromAnswers, type Answers } from '../../../shared/questionnaire'
import { Icon } from '../components/icons'
import { RosterEditor } from '../components/RosterEditor'
import { Empty, ErrorBox, Loading, PageHead, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'
import { navigate } from '../lib/router'
export function SetupScreen({ targetId }: { targetId?: string }) {
  return targetId ? <SetupForm key={targetId} targetId={targetId}/> : <><PageHead eyebrow="02 / AUDIT SETUP" title="Choose your starting point."/><div className="panel"><Empty title="Import a project first."><a className="btn btn--primary" href="#/projects">Go to projects <Icon name="arrow"/></a></Empty></div></>
}
function SetupForm({ targetId }: { targetId: string }) {
  const setup = useQuery('targetSetup', { targetId }); const settings = useQuery('settings', undefined)
  const [answers, setAnswers] = useState<Answers | null>(null); const [roster, setRoster] = useState<Roster | null>(null)
  const [allowed, setAllowed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null)
  const [accountName, setAccountName] = useState(''); const [headerName, setHeaderName] = useState('Authorization'); const [headerValue, setHeaderValue] = useState(''); const [savingAccount, setSavingAccount] = useState(false)
  const initialized = useRef(false); const idempotency = useRef(crypto.randomUUID()); const toast = useToast()
  const snapshot = setup.data?.target.latestSnapshot
  const questionnaire = snapshot ? buildQuestionnaire({ stack: snapshot.stack, accounts: setup.data!.accounts.filter((a) => a.configured).map((a) => a.name), trusted: setup.data!.target.source.kind === 'sample', knowledgeDocs: setup.data!.knowledgeDocs }) : null
  useEffect(() => {
    if (!initialized.current && questionnaire && settings.data && setup.data) {
      initialized.current = true; setAnswers(questionnaire.defaults); setRoster(settings.data.defaultRoster); setAllowed(setup.data.target.source.kind === 'sample')
    }
  }, [setup.data, settings.data, questionnaire])
  const start = async () => {
    if (!answers || !roster) return
    setBusy(true); setError(null)
    try {
      const input = setupFromAnswers(answers)
      if (input.allowCommands && !allowed) throw new Error('Allow local project commands to start a running-app audit.')
      const result = await command({ type: 'startRun', idempotencyKey: idempotency.current, targetId, ...input, roster })
      navigate(`/arena/${result.runId}`)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  const saveAccount = async () => {
    setSavingAccount(true); setError(null)
    try {
      await command({ type: 'setTestAccount', targetId, name: accountName, headerName, headerValue })
      setHeaderValue(''); setAccountName(''); setup.refetch(); toast('Test account saved on this Mac')
    } catch (err) { setError(String(err)) } finally { setSavingAccount(false) }
  }
  if (setup.error || settings.error) return <ErrorBox error={setup.error ?? settings.error}/>
  if (!answers || !roster || !setup.data || !snapshot || !questionnaire) return <Loading/>
  const selected = setupFromAnswers(answers)
  const limits = DEPTH_LIMITS[answers.depth]
  const update = (key: keyof Answers, value: unknown) => { setAnswers({ ...answers, [key]: value }); idempotency.current = crypto.randomUUID() }
  return <><PageHead eyebrow="02 / AUDIT SETUP" title={`A plan for ${setup.data.target.name}.`} description="Questions based on the code scan. Your answers become the contract for this audit." action={<a className="btn" href="#/projects"><Icon name="folder"/>Projects</a>}/>
    <div className="scan-bar"><Icon name="code"/><strong>{snapshot.stack.languages.map((l) => l.name).join(' / ') || 'Source snapshot'}</strong><span>{snapshot.fileCount} files</span><span>{snapshot.stack.routes.length} routes found</span><span>{snapshot.stack.tests.files} test files</span><span className="mono">{snapshot.contentHash.slice(0, 10)}</span></div>
    <ErrorBox error={error}/><div className="setup-layout"><div className="stack">
      <section className="panel padded"><div className="section-head section-head--flush"><h2>Define the audit</h2><span className="pill">{answers.depth}</span></div>
        {questionnaire.questions.filter((q) => q.visible(answers)).map((q, index) => <fieldset className="question" key={q.id}><legend><span className="question-number">{String(index + 1).padStart(2, '0')}</span>{q.prompt}</legend>{q.help && <p className="muted">{q.help}</p>}
          {q.kind === 'text' ? q.id === 'instructions' ? <textarea aria-label={q.prompt} placeholder={q.placeholder} value={String(answers[q.id])} onChange={(e) => update(q.id, e.target.value)} rows={3}/> : <input aria-label={q.prompt} placeholder={q.placeholder} value={String(answers[q.id])} onChange={(e) => update(q.id, e.target.value)}/> : <div className={`options ${q.options!.length > 3 ? 'options--grid' : ''}`}>{q.options!.map((option) => {
            const checked = q.kind === 'multi' ? (answers[q.id] as string[]).includes(option.value) : answers[q.id] === option.value
            return <label className={`option ${checked ? 'selected' : ''}`} key={option.value}><input type={q.kind === 'multi' ? 'checkbox' : 'radio'} name={q.id} checked={checked} onChange={() => update(q.id, q.kind === 'multi' ? checked ? (answers[q.id] as string[]).filter((v) => v !== option.value) : [...answers[q.id] as string[], option.value] : option.value)}/><span><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>{checked && <Icon name="check" size={16}/>}</label>
          })}</div>}
        </fieldset>)}
        {selected.allowCommands && <label className="permission-choice"><input type="checkbox" checked={allowed} onChange={(e) => setAllowed(e.target.checked)}/><span>Allow this project’s install and start commands to run locally on this Mac.</span></label>}
      </section>
      <section className="panel padded"><RosterEditor value={roster} onChange={(r) => { setRoster(r); idempotency.current = crypto.randomUUID() }}/></section>
      <details className="panel padded"><summary><Icon name="account"/>Test accounts <span className="count">{setup.data.accounts.length}</span></summary><p className="muted">Store a header for a dedicated test account. Workers receive its name; the host adds its credential to requests.</p><div className="account-tags">{setup.data.accounts.map((a) => <span className="tag" key={a.name}><Icon name="account" size={14}/>{a.name} · {a.configured ? 'configured' : 'empty'}</span>)}</div><div className="form-grid"><label className="field">Account name<input value={accountName} placeholder="alice" onChange={(e) => setAccountName(e.target.value)}/></label><label className="field">Header name<input value={headerName} onChange={(e) => setHeaderName(e.target.value)}/></label></div><label className="field">Header value<input type="password" autoComplete="new-password" value={headerValue} placeholder="Bearer …" onChange={(e) => setHeaderValue(e.target.value)}/></label><button type="button" className="btn" disabled={savingAccount || !accountName || !headerValue} onClick={() => void saveAccount()}>Save test account</button></details>
    </div><aside className="setup-summary panel panel--dark"><div className="eyebrow">This audit</div><h2>From a question<br/>to evidence.</h2><dl className="summary-list"><div><dt>Project</dt><dd>{setup.data.target.name}</dd></div><div><dt>Mode</dt><dd>{MODE_LABEL[answers.mode]}</dd></div><div><dt>Depth</dt><dd>{answers.depth}</dd></div><div><dt>Debate rounds</dt><dd>Up to {limits.maxRounds}</dd></div><div><dt>Findings</dt><dd>Up to {limits.maxClaims}</dd></div><div><dt>Knowledge</dt><dd>{answers.knowledge === 'yes' ? `${setup.data.knowledgeDocs} writeups` : 'Off'}</dd></div></dl><ol className="mini-pipeline">{PHASES.map((p, i) => <li key={p}><span>0{i + 1}</span>{PHASE_LABEL[p]}</li>)}</ol><button className="btn btn--yellow full" disabled={busy || !answers.focus.length || (selected.allowCommands && !allowed)} onClick={() => void start()}>{busy ? 'Starting…' : 'Start audit'}<Icon name="arrow"/></button><p className="small muted-on-dark">Findings are checked by the host. DNA changes wait for your decision.</p></aside></div></>
}
