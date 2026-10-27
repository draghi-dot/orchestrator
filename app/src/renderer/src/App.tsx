import { ToastProvider } from './components/ui'
import { ConnectionPill } from './components/ui'
import { useQuery } from './lib/api'
import { useRoute } from './lib/router'
import { LiveProvider, useLive } from './lib/stream'
import { AgentScreen } from './screens/Agent'
import { ProjectsScreen } from './screens/Projects'
import { ReviewScreen } from './screens/Review'
import { RunWorkspace } from './screens/RunWorkspace'
import { RunsScreen } from './screens/Runs'

function Shell() {
  const route = useRoute()
  const live = useLive()
  const queue = useQuery('reviewQueue', undefined, live.version)
  const section = route.path[0] ?? 'runs'
  const isMac = window.kestrel.platform === 'darwin'

  const link = (href: string, label: string, key: string, count?: number) => (
    <a href={`#/${href}`} className={section === key ? 'active' : ''}>
      {label}
      {count ? <span className="nav__count">{count}</span> : null}
    </a>
  )

  let screen
  if (section === 'runs' && route.path[1]) screen = <RunWorkspace runId={route.path[1]} params={route.params} />
  else if (section === 'projects') screen = <ProjectsScreen />
  else if (section === 'review') screen = <ReviewScreen />
  else if (section === 'agent') screen = <AgentScreen />
  else screen = <RunsScreen />

  return (
    <div className="app">
      <header className={`titlebar ${isMac ? 'mac' : ''}`}>
        <a className="wordmark" href="#/runs">
          <span className="wordmark__mark">kestrel</span>
          <span className="wordmark__qa">QA</span>
        </a>
        <nav className="nav" aria-label="Primary">
          {link('runs', 'Runs', 'runs')}
          {link('projects', 'Projects', 'projects')}
          {link('review', 'Review', 'review', queue.data?.length)}
          {link('agent', 'Agent', 'agent')}
        </nav>
        <ConnectionPill status={live.status} />
      </header>
      <main className="main">
        <div className="page">{screen}</div>
      </main>
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
