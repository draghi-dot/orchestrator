import type { Run } from '../../../shared/domain'
import { Header } from '../App'
import { AUDIT_STATE, METHOD, PROVIDER } from '../copy'
import { I } from '../components/icons'
import { Empty, ErrorBanner, Loading, Pill } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDateTime, formatDuration } from '../lib/format'
import { navigate } from '../lib/router'
import { useLive } from '../lib/stream'

export function providersUsed(run: Run): string {
  const names = [...new Set(Object.values(run.contract.roster).map((p) => PROVIDER[p.runtime].name))]
  return names.join(', ')
}

export function AuditsScreen() {
  const live = useLive()
  const runs = useQuery('listRuns', undefined, live.version)
  const overview = useQuery('overview', undefined)
  const sample = overview.data?.targets.find((t) => t.source.kind === 'sample')

  return (
    <>
      <Header
        title="Audits"
        actions={
          <button className="btn" onClick={() => navigate('/new')}>
            <I.plus size={15} />
            New audit
          </button>
        }
      />
      <div className="content">
        <div className="page">
          <ErrorBanner error={runs.error} />
          {!runs.data && runs.loading ? (
            <Loading />
          ) : runs.data && runs.data.length > 0 ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Findings</th>
                    <th>Method</th>
                    <th>Agents</th>
                    <th>Started</th>
                    <th className="num">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.data.map((r) => {
                    const state = AUDIT_STATE[r.state]
                    const s = r.summary
                    return (
                      <tr key={r.id} className="clickable" onClick={() => navigate(`/audits/${r.id}`)}>
                        <td>
                          <div className="cell-title">{r.contract.targetName}</div>
                          <div className="cell-sub mono">{r.contract.snapshotHash.slice(0, 10)}</div>
                        </td>
                        <td>
                          <Pill tone={state.tone} dot pulse={r.state === 'running'}>
                            {state.label}
                          </Pill>
                        </td>
                        <td>
                          {s && s.claims > 0 ? (
                            <>
                              <div>{s.confirmed} confirmed</div>
                              <div className="cell-sub">
                                {s.claims} reported, {s.rejected} false positive{s.rejected === 1 ? '' : 's'}
                              </div>
                            </>
                          ) : (
                            <span className="faint">None yet</span>
                          )}
                        </td>
                        <td>{METHOD[r.contract.mode].name}</td>
                        <td className="muted">{providersUsed(r)}</td>
                        <td className="muted tnum">{formatDateTime(r.createdAt)}</td>
                        <td className="num muted">{formatDuration(r.startedAt, r.endedAt)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty
                icon={<I.audits size={22} />}
                title="No audits yet"
                actions={
                  <>
                    {sample && (
                      <button className="btn btn--primary" onClick={() => navigate('/new', { project: sample.id })}>
                        Audit the sample project
                      </button>
                    )}
                    <button className="btn" onClick={() => navigate('/projects', { import: 1 })}>
                      Import a project
                    </button>
                  </>
                }
              >
                Agents explore your app, report findings, check each other’s work, and verify every issue before it reaches your report.
              </Empty>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
