import { type ReactNode, useEffect } from 'react'
import { APP_NAME, AUDIT_STATE } from './copy'
import { BatonMark, I } from './components/icons'
import { ToastProvider } from './components/ui'
import { useQuery } from './lib/api'
import { formatAge } from './lib/format'
import { navigate, useRoute } from './lib/router'
import { LiveProvider, useLive } from './lib/stream'
import { AuditScreen } from './screens/Audit'
import { AuditsScreen } from './screens/Audits'
import { FindingsScreen } from './screens/Findings'
import { NewAuditScreen } from './screens/NewAudit'
import { PlaybookScreen } from './screens/Playbook'
import { ProjectsScreen } from './screens/Projects'
import { SettingsScreen } from './screens/Settings'

/** Page header bar: title or breadcrumbs on the left, actions on the right. */
export function Header({ title, crumbs, actions }: { title: ReactNode; crumbs?: { label: string; href: string }[]; actions?: ReactNode }) {
  return (
    <header className="header">
      <div className="header__title">
        {crumbs?.map((c) => (
          <span key={c.href} className="row" style={{ gap: 8 }}>
            <a className="crumb" href={c.href}>
              {c.label}
            </a>
            <span className="crumb-sep">/</span>
          </span>
        ))}
        <span className="truncate">{title}</span>
      </div>
      {actions && <div className="header__actions">{actions}</div>}
    </header>
  )
}

function Sidebar({ section, auditId }: { section: string; auditId: string | null }) {
  const live = useLive()
  const runs = useQuery('listRuns', undefined, live.version)
  const review = useQuery('reviewQueue', undefined, live.version)
  const playbook = useQuery('dna', undefined, live.version)
  const accounts = useQuery('accounts', undefined, section === 'settings' ? live.version : 0)

  const nav = [
    { id: 'audits', label: 'Audits', icon: I.audits, count: 0 },
    { id: 'projects', label: 'Projects', icon: I.projects, count: 0 },
    { id: 'findings', label: 'Findings', icon: I.findings, count: review.data?.length ?? 0 },
    { id: 'playbook', label: 'Playbook', icon: I.playbook, count: playbook.data?.pending.length ?? 0 },
  ]
  const recent = (runs.data ?? []).slice(0, 6)
  const provider = (id: 'claude' | 'codex') => accounts.data?.find((a) => a.runtime === id)

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <a className="brand" href="#/audits">
        <BatonMark />
        {APP_NAME}
      </a>
      <button className="btn btn--primary btn--new" onClick={() => navigate('/new')}>
        <I.plus size={15} weight="bold" />
        New audit
        <kbd>⌘N</kbd>
      </button>
      <nav className="nav" aria-label="Primary">
        {nav.map((n) => (
          <a key={n.id} href={`#/${n.id}`} className={`nav-item ${section === n.id ? 'active' : ''}`}>
            <n.icon size={17} />
            {n.label}
            {n.count > 0 && <span className="count count--accent">{n.count}</span>}
          </a>
        ))}
      </nav>
      {recent.length > 0 && (
        <>
          <div className="sidebar__section">Recent audits</div>
          <div className="recent">
            {recent.map((r) => {
              const state = AUDIT_STATE[r.state]
              const dot = state.tone === 'success' ? 'dot--success' : state.tone === 'accent' ? 'dot--accent dot--pulse' : state.tone === 'danger' ? 'dot--danger' : state.tone === 'warning' ? 'dot--warning' : ''
              return (
                <a key={r.id} href={`#/audits/${r.id}`} className={`recent-item ${auditId === r.id ? 'active' : ''}`} title={`${r.contract.targetName}: ${state.label}`}>
                  <span className={`dot ${dot}`} />
                  <span className="truncate">{r.contract.targetName}</span>
                  <time>{formatAge(r.createdAt).replace(' ago', '')}</time>
                </a>
              )
            })}
          </div>
        </>
      )}
      <div className="sidebar__footer">
        <a href="#/settings" className={`nav-item ${section === 'settings' ? 'active' : ''}`}>
          <I.settings size={17} />
          Settings
        </a>
        <div className="providers" title="Model providers">
          {(['claude', 'codex'] as const).map((id) => {
            const p = provider(id)
            return (
              <span key={id}>
                <span className={`dot ${p?.signedIn ? 'dot--success' : ''}`} />
                {id === 'claude' ? 'Claude' : 'Codex'}
              </span>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function Shell() {
  const route = useRoute()
  const section = route.path[0] || 'audits'
  const auditId = section === 'audits' ? (route.path[1] ?? null) : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        navigate('/new')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  let screen: ReactNode
  if (section === 'audits' && auditId) screen = <AuditScreen key={auditId} runId={auditId} />
  else if (section === 'new') screen = <NewAuditScreen key={route.params.get('project') ?? 'new'} projectId={route.params.get('project')} />
  else if (section === 'projects') screen = <ProjectsScreen selectedId={route.params.get('id')} />
  else if (section === 'findings') screen = <FindingsScreen />
  else if (section === 'playbook') screen = <PlaybookScreen />
  else if (section === 'settings') screen = <SettingsScreen />
  else screen = <AuditsScreen />

  return (
    <div className="app">
      <Sidebar section={section === 'new' ? '' : section} auditId={auditId} />
      <main className="main">{screen}</main>
    </div>
  )
}

export function App() {
  return (
    <LiveProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </LiveProvider>
  )
}
