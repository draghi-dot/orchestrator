import { useEffect, useRef, useState } from 'react'
import type { AccountStatus, RuntimeSettings } from '../../../shared/domain'
import type { LoginUpdate } from '../../../shared/ipc'
import { Header } from '../App'
import { PROVIDER } from '../copy'
import { AgentTable } from '../components/AgentTable'
import { I, Spinner } from '../components/icons'
import { ErrorBanner, Field, Loading, Pill, useAction, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'

export function SettingsScreen() {
  const settings = useQuery('settings', undefined)
  const accounts = useQuery('accounts', undefined)
  const pending = useQuery('activeLogins', undefined)
  const [draft, setDraft] = useState<RuntimeSettings | null>(null)
  const [login, setLogin] = useState<LoginUpdate | null>(null)
  const sawUpdate = useRef(false)
  const save = useAction()
  const account = useAction()
  const toast = useToast()

  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])
  useEffect(() => {
    if (!sawUpdate.current && pending.data?.length) setLogin(pending.data[0])
  }, [pending.data])
  useEffect(
    () =>
      window.qa.onLoginUpdate((u) => {
        sawUpdate.current = true
        setLogin(u)
        if (u.state !== 'waiting') accounts.refetch()
      }),
    [accounts.refetch],
  )

  const dirty = draft && settings.data && JSON.stringify(draft) !== JSON.stringify(settings.data)

  return (
    <>
      <Header
        title="Settings"
        actions={
          <button
            className="btn btn--primary"
            disabled={!dirty || save.busy}
            onClick={() =>
              void save.run(async () => {
                await command({ type: 'saveSettings', settings: draft! })
                settings.refetch()
                toast('Settings saved')
              })
            }
          >
            Save changes
          </button>
        }
      />
      <div className="content">
        <div className="page" style={{ maxWidth: 900 }}>
          <ErrorBanner error={save.error ?? settings.error} />

          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Accounts</h2>
            <span className="spacer" />
            <button className="btn btn--sm btn--ghost" onClick={accounts.refetch}>
              <I.refresh size={14} />
              Refresh
            </button>
          </div>
          <p className="small muted" style={{ marginBottom: 12 }}>
            Agents run through the official Claude and Codex apps on this Mac. You sign in with them directly; Baton never sees your credentials.
          </p>
          <ErrorBanner error={account.error ?? accounts.error} />
          <div className="card">
            {!accounts.data ? (
              <Loading label="Checking accounts" />
            ) : (
              accounts.data.map((a) => (
                <AccountRow
                  key={a.runtime}
                  account={a}
                  login={login?.runtime === a.runtime ? login : null}
                  busy={account.busy}
                  onSignIn={() => void account.run(() => command({ type: 'startLogin', runtime: a.runtime }))}
                  onSignOut={() => void account.run(async () => {
                    await command({ type: 'logout', runtime: a.runtime })
                    accounts.refetch()
                  })}
                  onOpen={(id) => void account.run(() => command({ type: 'openLoginUrl', sessionId: id }))}
                  onCancel={(id) => void account.run(() => command({ type: 'cancelLogin', sessionId: id }))}
                  onCode={(id, text) => account.run(() => command({ type: 'sendLoginInput', sessionId: id, text }))}
                />
              ))
            )}
          </div>

          {!draft ? (
            <Loading />
          ) : (
            <>
              <div className="section-title">
                <h2>Default agents</h2>
              </div>
              <p className="small muted" style={{ marginBottom: 12 }}>
                New audits start with these. You can change them per audit.
              </p>
              <AgentTable value={draft.defaultRoster} onChange={(defaultRoster) => setDraft({ ...draft, defaultRoster })} accounts={accounts.data} />

              <div className="section-title">
                <h2>Knowledge library</h2>
              </div>
              <div className="card card--pad stack stack--sm">
                <Field label="Folder" hint="Markdown writeups agents may search for background. Never treated as evidence. Leave empty to use the bundled library if present.">
                  <input className="input mono" placeholder="/path/to/writeups" value={draft.knowledgePath} onChange={(e) => setDraft({ ...draft, knowledgePath: e.target.value })} />
                </Field>
              </div>

              <details className="fold">
                <summary>
                  <I.caretRight size={14} />
                  Advanced
                </summary>
                <div className="card card--pad stack">
                  {(['claudeCommand', 'codexCommand', 'ompCommand'] as const).map((k) => (
                    <Field key={k} label={`${k === 'claudeCommand' ? 'Claude' : k === 'codexCommand' ? 'Codex' : 'oh-my-pi'} command`} hint={k === 'claudeCommand' ? 'A name on your PATH or an absolute path.' : undefined}>
                      <input className="input mono" value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                    </Field>
                  ))}
                </div>
              </details>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function AccountRow({
  account,
  login,
  busy,
  onSignIn,
  onSignOut,
  onOpen,
  onCancel,
  onCode,
}: {
  account: AccountStatus
  login: LoginUpdate | null
  busy: boolean
  onSignIn: () => void
  onSignOut: () => void
  onOpen: (sessionId: string) => void
  onCancel: (sessionId: string) => void
  onCode: (sessionId: string, text: string) => Promise<boolean>
}) {
  const [code, setCode] = useState('')
  const name = PROVIDER[account.runtime].name
  const waiting = login?.state === 'waiting'
  const external = account.runtime === 'omp'
  const status = !account.installed ? (
    <Pill tone="outline">Not installed</Pill>
  ) : account.signedIn ? (
    <Pill tone="success" dot>
      Connected
    </Pill>
  ) : waiting ? (
    <Pill tone="accent">
      <Spinner size={11} />
      Signing in
    </Pill>
  ) : (
    <Pill>Not connected</Pill>
  )

  return (
    <>
      <div className="list-row">
        <span className="provider-mark">
          <I.terminal size={17} />
        </span>
        <div className="list-row__main">
          <div className="row">
            <span className="list-row__title">{name}</span>
            {status}
          </div>
          <div className="list-row__sub">
            {account.signedIn && account.account ? account.account : !account.installed ? `Install the ${name} CLI to use it.` : external ? 'Sign in with omp login in Terminal.' : 'Sign in to use it for agents.'}
            {account.version && <span className="faint">{`  ${account.version}`}</span>}
          </div>
        </div>
        {!external &&
          account.installed &&
          (account.signedIn ? (
            <button className="btn btn--sm" disabled={busy} onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <button className="btn btn--sm btn--primary" disabled={busy || waiting} onClick={onSignIn}>
              Sign in
            </button>
          ))}
      </div>
      {login && login.state !== 'succeeded' && (
        <div className="login-box stack stack--sm">
          <div className="small">
            {login.state === 'waiting' ? 'Finish signing in in your browser.' : login.message ?? 'Sign-in did not complete.'}
          </div>
          {waiting && (
            <>
              <div className="row">
                {login.url && (
                  <button className="btn btn--sm" disabled={busy} onClick={() => onOpen(login.sessionId)}>
                    <I.external size={14} />
                    Open sign-in page
                  </button>
                )}
                <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => onCancel(login.sessionId)}>
                  Cancel
                </button>
              </div>
              {account.runtime === 'claude' && (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void onCode(login.sessionId, code).then((ok) => ok && setCode(''))
                  }}
                >
                  <input className="input" type="password" autoComplete="off" placeholder="Paste the code from the browser, if asked" value={code} onChange={(e) => setCode(e.target.value)} />
                  <button className="btn btn--sm" disabled={busy || !code.trim()}>
                    Submit
                  </button>
                </form>
              )}
              {login.lines.length > 0 && (
                <details>
                  <summary className="small faint">Details</summary>
                  <pre className="code" style={{ marginTop: 6 }}>
                    {login.lines.slice(-12).join('\n')}
                  </pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </>
  )
}
