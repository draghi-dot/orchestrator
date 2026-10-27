import { Icon, type IconName } from './components/icons'
import { ToastProvider } from './components/ui'
import { useQuery } from './lib/api'
import { useRoute } from './lib/router'
import { LiveProvider, useLive } from './lib/stream'
import { ProjectsScreen } from './screens/Projects'
import { SetupScreen } from './screens/Setup'
import { ArenaScreen, RunWorkspace } from './screens/Arena'
import { FindingsScreen } from './screens/Findings'
import { DnaScreen } from './screens/Dna'
import { SettingsScreen } from './screens/Settings'
const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: 'projects', label: 'Projects', icon: 'projects' }, { path: 'setup', label: 'Audit setup', icon: 'setup' },
  { path: 'arena', label: 'Arena', icon: 'arena' }, { path: 'findings', label: 'Findings', icon: 'findings' },
  { path: 'dna', label: 'DNA', icon: 'dna' }, { path: 'settings', label: 'Settings', icon: 'settings' },
]
function Shell() {
  const { path } = useRoute(); const section = path[0] ?? 'projects'; const live = useLive()
  const review = useQuery('reviewQueue', undefined, live.version)
  const overview = useQuery('overview', undefined, live.version)
  let screen
  if (section === 'setup') screen = <SetupScreen key={path[1] ?? 'default'} targetId={path[1] ?? overview.data?.targets[0]?.id}/>
  else if (section === 'arena') screen = path[1] ? <RunWorkspace key={path[1]} runId={path[1]}/> : <ArenaScreen/>
  else if (section === 'findings') screen = <FindingsScreen/>
  else if (section === 'dna') screen = <DnaScreen/>
  else if (section === 'settings') screen = <SettingsScreen/>
  else screen = <ProjectsScreen/>
  return <div className="app"><header className={`titlebar ${window.qa.platform === 'darwin' ? 'mac' : ''}`}><span className="titlebar__label">QA ARENA <span>/</span> LOCAL WORKSPACE</span><span className="connection"><span className={`status-dot ${live.status === 'live' ? 'online' : ''}`}/>{live.status === 'live' ? 'Connected' : live.status}</span></header>
    <aside className="sidebar"><a href="#/projects" className="brand"><span className="brand__symbol"><Icon name="arena" size={27}/></span><span>QA<span className="brand__light">ARENA</span></span></a><div className="sidebar__caption">Workspace</div><nav aria-label="Primary">{NAV.map((n) => <a href={`#/${n.path}`} className={section === n.path ? 'active' : ''} key={n.path}><Icon name={n.icon}/><span>{n.label}</span>{n.path === 'findings' && !!review.data?.length && <span className="nav-count">{review.data.length}</span>}</a>)}</nav><div className="sidebar__footer"><div className="sidebar__note"><Icon name="shield" size={22}/><strong>Evidence decides.</strong><p>Workers find and challenge.<br/>The host verifies.</p></div><div className="operator"><span className="avatar">{overview.data?.operator.slice(0, 1).toUpperCase() ?? 'L'}</span><div><strong>{overview.data?.operator ?? 'Local operator'}</strong><small>On this Mac</small></div><span className="status-dot online"/></div></div></aside>
    <main className="main"><div className="page">{screen}</div></main></div>
}
export function App() { return <LiveProvider><ToastProvider><Shell/></ToastProvider></LiveProvider> }
