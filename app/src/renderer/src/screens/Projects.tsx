import { useState } from 'react'
import { Icon } from '../components/icons'
import { Badge, Empty, ErrorBox, Loading, Metric, Modal, PageHead, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'
import { formatDateTime, shortId } from '../lib/format'
import { navigate } from '../lib/router'
import { useLive } from '../lib/stream'

export function ProjectsScreen() {
  const live = useLive()
  const projects = useQuery('overview', undefined, live.version)
  const runs = useQuery('listRuns', undefined, live.version)
  const [importing, setImporting] = useState(false)
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const allRuns = runs.data ?? []

  async function load(kind: 'github' | 'zip') {
    setBusy(true)
    setError(null)
    try {
      const result = kind === 'github'
        ? await command({ type: 'importGithub', url, ref: ref.trim() || null })
        : await command({ type: 'chooseZip' })
      if (result.targetId) {
        setImporting(false)
        projects.refetch()
        toast('Project imported and scanned')
        navigate(`/setup/${result.targetId}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <PageHead eyebrow="Projects" title="Your next audit starts here." description="Import an app. Set the scope. Follow every claim through challenge and proof."
      action={<button className="btn btn--primary" onClick={() => setImporting(true)}><Icon name="plus"/>Import project</button>}/>
    <div className="workspace-stats">
      <Metric value={projects.data?.targets.length ?? 0} label="Projects"/>
      <Metric value={allRuns.length} label="Audits"/>
      <Metric value={allRuns.reduce((n, r) => n + (r.summary?.confirmed ?? 0), 0)} label="Host-confirmed findings"/>
      <div className="workspace-stats__note"><Icon name="thinker" size={36}/><p>Five workers.<br/>Every finding challenged.</p></div>
    </div>
    <ErrorBox error={projects.error ?? runs.error}/>
    <div className="section-head"><h2>Projects</h2><span className="muted">Snapshots stored on this Mac</span></div>
    {projects.loading && !projects.data ? <Loading/> : <div className="panel table-wrap">
      <table className="projects-table"><thead><tr><th>Project</th><th>Technology</th><th>Snapshot</th><th>Last audit</th><th/></tr></thead>
        <tbody>{projects.data?.targets.map((target) => {
          const snapshot = target.latestSnapshot
          const last = allRuns.find((r) => r.contract.targetId === target.id)
          return <tr key={target.id}>
            <td><div className="project-name"><Icon name={target.source.kind === 'sample' ? 'builder' : 'projects'} size={34}/><div><strong>{target.name}</strong><small className="table-sub">{target.source.kind === 'sample' ? 'Bundled sample with known defects' : target.source.kind === 'github' ? target.source.url : target.source.fileName}</small></div></div></td>
            <td>{snapshot?.stack.languages.slice(0, 2).map((l) => l.name).join(', ') || 'Source'}<small className="table-sub">{snapshot?.stack.frameworks.slice(0, 2).join(', ') || `${snapshot?.fileCount ?? 0} files`}</small></td>
            <td title={snapshot?.commitSha ?? snapshot?.contentHash}><span className="mono">{(snapshot?.commitSha ?? snapshot?.contentHash)?.slice(0, 10) ?? '—'}</span><small className="table-sub">{snapshot?.stack.routes.length ?? 0} routes / {snapshot?.stack.tests.files ?? 0} tests</small></td>
            <td>{last ? <><Badge status={last.state}/><small className="table-sub">{last.contract.allowCommands ? 'Local commands allowed' : 'Commands off'}</small></> : <span className="muted">Ready</span>}</td>
            <td><a className="text-btn" href={`#/setup/${target.id}`}>Set up audit <Icon name="arrow" size={16}/></a></td>
          </tr>
        })}</tbody>
      </table>
      {!projects.data?.targets.length && <Empty title="Import your first project.">GitHub repositories and ZIP source archives are supported.</Empty>}
    </div>}
    <button className="import-row" onClick={() => setImporting(true)}><Icon name="plus"/><strong>Add another project</strong><span>GitHub repository or ZIP archive</span><Icon name="arrow"/></button>
    <div className="section-head"><h2>Recent audits</h2><a className="text-btn" href="#/arena">Open arena <Icon name="arrow" size={16}/></a></div>
    <div className="panel">{allRuns.length ? <div className="table-wrap"><table><thead><tr><th>Project</th><th>Run</th><th>Status</th><th>Host confirmed</th><th>Started</th><th/></tr></thead><tbody>{allRuns.slice(0, 5).map((r) => <tr key={r.id}>
      <td><strong>{r.contract.targetName}</strong></td><td>{shortId(r.id)}</td><td><Badge status={r.state}/></td><td>{r.summary?.confirmed ?? 0}</td><td className="muted">{formatDateTime(r.createdAt)}</td><td><a className="icon-btn" href={`#/arena/${r.id}`} aria-label={`Open audit ${shortId(r.id)}`}><Icon name="arrow"/></a></td>
    </tr>)}</tbody></table></div> : <Empty title="The arena is ready.">Try the sample shop or import your own source.</Empty>}</div>
    {importing && <Modal title="Import a project" onClose={() => { if (!busy) setImporting(false) }}>
      <p className="muted">The source is copied into a local snapshot and scanned before anything runs.</p><ErrorBox error={error}/>
      <form onSubmit={(e) => { e.preventDefault(); void load('github') }}>
        <label className="field">GitHub repository<input autoFocus placeholder="https://github.com/owner/repository" value={url} onChange={(e) => setUrl(e.target.value)} required/></label>
        <label className="field">Branch, tag, or commit <span className="faint">optional</span><input placeholder="Default branch" value={ref} onChange={(e) => setRef(e.target.value)}/></label>
        <button className="btn btn--primary full" disabled={busy}>{busy ? 'Importing…' : 'Import from GitHub'}<Icon name="arrow" size={18}/></button>
      </form>
      <div className="divider-label">or use a local archive</div><button className="btn full" disabled={busy} onClick={() => void load('zip')}><Icon name="folder"/>Choose ZIP file</button>
    </Modal>}
  </>
}
