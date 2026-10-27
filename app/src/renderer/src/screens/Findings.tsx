import { useMemo, useState } from 'react'
import type { ClaimStatus } from '../../../shared/domain'
import { Header } from '../App'
import { CATEGORY, FINDING_STATUS } from '../copy'
import { FindingPanel, effectiveStatus } from '../components/FindingPanel'
import { I } from '../components/icons'
import { Empty, ErrorBanner, Loading, Pill, Severity } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { useLive } from '../lib/stream'

const ORDER: ClaimStatus[] = ['needs_review', 'confirmed', 'inconclusive', 'candidate', 'rejected']
const SEVERITY = { high: 0, medium: 1, low: 2 } as Record<string, number>

export function FindingsScreen() {
  const live = useLive()
  const q = useQuery('findings', undefined, live.version)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ClaimStatus | 'all'>('all')
  const [severity, setSeverity] = useState('all')
  const [project, setProject] = useState('all')
  const [selected, setSelected] = useState<string | null>(null)

  const all = q.data ?? []
  const projects = useMemo(() => [...new Set(all.map((x) => x.run.contract.targetName))].sort(), [all])
  const items = all
    .filter(({ claim, run }) => {
      const s = effectiveStatus(claim)
      const text = `${claim.title} ${claim.location ?? ''} ${run.contract.targetName}`.toLowerCase()
      return (status === 'all' || s === status) && (severity === 'all' || claim.severity === severity) && (project === 'all' || run.contract.targetName === project) && text.includes(search.trim().toLowerCase())
    })
    .sort((a, b) => ORDER.indexOf(effectiveStatus(a.claim)) - ORDER.indexOf(effectiveStatus(b.claim)) || (SEVERITY[a.claim.severity] ?? 3) - (SEVERITY[b.claim.severity] ?? 3))
  const current = all.find((x) => x.claim.id === selected)

  return (
    <>
      <Header title="Findings" />
      <div className="content">
        <div className="page">
          <ErrorBanner error={q.error} />
          <div className="filters">
            <div className="search">
              <I.search size={15} />
              <input className="input" placeholder="Search findings" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search findings" />
            </div>
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value as ClaimStatus | 'all')} aria-label="Status">
              <option value="all">All statuses</option>
              {ORDER.map((s) => (
                <option key={s} value={s}>
                  {FINDING_STATUS[s].label}
                </option>
              ))}
            </select>
            <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
              <option value="all">All severities</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            {projects.length > 1 && (
              <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
                <option value="all">All projects</option>
                {projects.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            )}
            <span className="spacer" />
            <span className="small faint">{items.length} shown</span>
          </div>
          {!q.data ? (
            <Loading />
          ) : items.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Severity</th>
                    <th>Finding</th>
                    <th>Project</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Reported</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(({ claim, run }) => {
                    const s = FINDING_STATUS[effectiveStatus(claim)]
                    return (
                      <tr key={claim.id} className={`clickable ${selected === claim.id ? 'selected' : ''}`} onClick={() => setSelected(claim.id)}>
                        <td>
                          <Severity level={claim.severity} />
                        </td>
                        <td>
                          <div className="cell-title">{claim.title}</div>
                          {claim.location && <div className="cell-sub mono">{claim.location}</div>}
                        </td>
                        <td className="muted">{run.contract.targetName}</td>
                        <td className="muted">{CATEGORY[claim.category]}</td>
                        <td>
                          <Pill tone={s.tone} dot>
                            {s.label}
                          </Pill>
                        </td>
                        <td className="muted small tnum">{formatDateTime(claim.createdAt)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty icon={<I.findings size={22} />} title={all.length ? 'No findings match these filters' : 'No findings yet'}>
                {all.length ? 'Try a different status or severity.' : 'Findings from every audit appear here, newest problems first.'}
              </Empty>
            </div>
          )}
        </div>
      </div>
      {current && <FindingPanel finding={current.claim} run={current.run} onClose={() => setSelected(null)} onChanged={q.refetch} />}
    </>
  )
}
