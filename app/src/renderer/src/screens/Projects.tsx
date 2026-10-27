import { useState } from 'react'
import type { Run, Target } from '../../../shared/domain'
import { Header } from '../App'
import { AREA, AUDIT_STATE, plural } from '../copy'
import { I } from '../components/icons'
import { Empty, ErrorBanner, Field, Loading, Modal, Pill, SidePanel, Tabs, useAction, useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'
import { formatAge, formatBytes, formatDateTime } from '../lib/format'
import { navigate, replaceParams, useRoute } from '../lib/router'
import { useLive } from '../lib/stream'
import { AccountModal } from './NewAudit'

function SourceIcon({ target }: { target: Target }) {
  const Icon = target.source.kind === 'github' ? I.github : target.source.kind === 'zip' ? I.zip : I.sample
  return (
    <span className="agent-icon">
      <Icon size={15} />
    </span>
  )
}

function sourceLabel(t: Target): string {
  if (t.source.kind === 'github') return t.source.url.replace('https://github.com/', '') + (t.source.ref ? ` (${t.source.ref})` : '')
  if (t.source.kind === 'zip') return t.source.fileName
  return 'Sample project'
}

export function ProjectsScreen({ selectedId }: { selectedId: string | null }) {
  const live = useLive()
  const route = useRoute()
  const overview = useQuery('overview', undefined, live.version)
  const runs = useQuery('listRuns', undefined, live.version)
  const [importing, setImporting] = useState(route.params.get('import') === '1')
  const lastRun = (id: string): Run | undefined => runs.data?.find((r) => r.contract.targetId === id)
  const selected = overview.data?.targets.find((t) => t.id === selectedId)

  return (
    <>
      <Header
        title="Projects"
        actions={
          <button className="btn" onClick={() => setImporting(true)}>
            <I.plus size={15} />
            Import project
          </button>
        }
      />
      <div className="content">
        <div className="page">
          <ErrorBanner error={overview.error} />
          {!overview.data ? (
            <Loading />
          ) : overview.data.targets.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Stack</th>
                    <th className="num">Files</th>
                    <th className="num">Routes</th>
                    <th>Last audit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overview.data.targets.map((t) => {
                    const snap = t.latestSnapshot
                    const run = lastRun(t.id)
                    return (
                      <tr key={t.id} className={`clickable ${selectedId === t.id ? 'selected' : ''}`} onClick={() => replaceParams({ id: t.id, import: null })}>
                        <td>
                          <div className="agent-cell">
                            <SourceIcon target={t} />
                            <div>
                              <div className="cell-title">{t.name}</div>
                              <div className="cell-sub">{sourceLabel(t)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="muted">{snap?.stack.languages.map((l) => l.name).slice(0, 3).join(', ') || 'Unknown'}</td>
                        <td className="num muted">{snap?.fileCount ?? 0}</td>
                        <td className="num muted">{snap?.stack.routes.length ?? 0}</td>
                        <td>
                          {run ? (
                            <span className="row">
                              <Pill tone={AUDIT_STATE[run.state].tone} dot>
                                {AUDIT_STATE[run.state].label}
                              </Pill>
                              <span className="small faint">{formatAge(run.createdAt)}</span>
                            </span>
                          ) : (
                            <span className="faint">Never</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn--sm"
                            onClick={(e) => {
                              e.stopPropagation()
                              navigate('/new', { project: t.id })
                            }}
                          >
                            New audit
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card">
              <Empty
                icon={<I.projects size={22} />}
                title="No projects yet"
                actions={
                  <button className="btn btn--primary" onClick={() => setImporting(true)}>
                    Import project
                  </button>
                }
              >
                Import a repository from GitHub or a ZIP file. Baton keeps a snapshot and never runs its code unless you allow it.
              </Empty>
            </div>
          )}
        </div>
      </div>
      {importing && (
        <ImportModal
          onClose={() => {
            setImporting(false)
            replaceParams({ import: null })
          }}
          onImported={(id) => {
            setImporting(false)
            overview.refetch()
            replaceParams({ id, import: null })
          }}
        />
      )}
      {selected && <ProjectPanel target={selected} onClose={() => replaceParams({ id: null })} />}
    </>
  )
}

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => void }) {
  const [tab, setTab] = useState<'github' | 'zip'>('github')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const work = useAction()
  const toast = useToast()
  const importGithub = () =>
    void work.run(async () => {
      const r = await command({ type: 'importGithub', url: url.trim(), ref: ref.trim() || null })
      toast('Project imported')
      onImported(r.targetId)
    })
  const importZip = () =>
    void work.run(async () => {
      const r = await command({ type: 'chooseZip' })
      if (r.targetId) {
        toast('Project imported')
        onImported(r.targetId)
      }
    })

  return (
    <Modal
      title="Import project"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {tab === 'github' ? (
            <button className="btn btn--primary" disabled={work.busy || !url.trim()} onClick={importGithub}>
              {work.busy ? 'Importing' : 'Import'}
            </button>
          ) : (
            <button className="btn btn--primary" disabled={work.busy} onClick={importZip}>
              {work.busy ? 'Importing' : 'Choose ZIP file'}
            </button>
          )}
        </>
      }
    >
      <Tabs<'github' | 'zip'>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'github', label: 'GitHub' },
          { id: 'zip', label: 'ZIP file' },
        ]}
      />
      <ErrorBanner error={work.error} />
      {tab === 'github' ? (
        <div className="stack">
          <Field label="Repository URL">
            <input className="input" placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && importGithub()} />
          </Field>
          <Field label="Branch or tag" hint="Optional. Uses the default branch if empty.">
            <input className="input" placeholder="main" value={ref} onChange={(e) => setRef(e.target.value)} />
          </Field>
          <p className="small faint">Public repositories, cloned without running any of their code.</p>
        </div>
      ) : (
        <p className="small muted">Choose a .zip of the source. Baton unpacks it into a snapshot, skips unsafe paths, and runs nothing.</p>
      )}
    </Modal>
  )
}

function ProjectPanel({ target, onClose }: { target: Target; onClose: () => void }) {
  const setup = useQuery('targetSetup', { targetId: target.id })
  const [adding, setAdding] = useState(false)
  const remove = useAction()
  const snap = target.latestSnapshot
  const stack = snap?.stack

  return (
    <>
      <SidePanel
        onClose={onClose}
        head={
          <>
            <h2>{target.name}</h2>
            <div className="small muted" style={{ marginTop: 4 }}>
              {sourceLabel(target)}
            </div>
          </>
        }
        footer={
          <div className="row">
            <button className="btn btn--primary" onClick={() => navigate('/new', { project: target.id })}>
              New audit
            </button>
          </div>
        }
      >
        {!snap || !stack ? (
          <Loading />
        ) : (
          <>
            <section className="block">
              <h3>Snapshot</h3>
              <dl className="kv">
                <dt>Imported</dt>
                <dd>{formatDateTime(snap.createdAt)}</dd>
                <dt>Size</dt>
                <dd>
                  {plural(snap.fileCount, 'file')}, {formatBytes(snap.bytes)}
                </dd>
                {snap.commitSha && (
                  <>
                    <dt>Commit</dt>
                    <dd className="mono">{snap.commitSha.slice(0, 12)}</dd>
                  </>
                )}
                <dt>Content hash</dt>
                <dd className="mono">{snap.contentHash.slice(0, 16)}</dd>
              </dl>
            </section>
            <section className="block">
              <h3>Stack</h3>
              <dl className="kv">
                <dt>Languages</dt>
                <dd>{stack.languages.map((l) => `${l.name} (${l.files})`).join(', ') || 'Unknown'}</dd>
                <dt>Frameworks</dt>
                <dd>{stack.frameworks.join(', ') || 'None found'}</dd>
                <dt>Start command</dt>
                <dd className="mono">{stack.commands.start ?? 'None found'}</dd>
                <dt>Test command</dt>
                <dd className="mono">{stack.commands.test ?? 'None found'}</dd>
              </dl>
            </section>
            <section className="block">
              <h3>Areas found</h3>
              {stack.areas.length ? (
                <div className="stack stack--sm">
                  {stack.areas.map((a) => (
                    <div key={a.id}>
                      <div className="cell-title">{AREA[a.id]}</div>
                      <div className="cell-sub mono">{a.files.join(', ')}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">Nothing stood out while reading the code.</p>
              )}
            </section>
            <section className="block">
              <h3>Routes</h3>
              {stack.routes.length ? (
                <div className="stack stack--sm">
                  {stack.routes.slice(0, 30).map((r) => (
                    <div key={`${r.method}${r.path}`} className="row mono small">
                      <span className="faint" style={{ width: 52 }}>
                        {r.method}
                      </span>
                      <span className="truncate">{r.path}</span>
                      <span className="spacer" />
                      <span className="faint">{r.location}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">No routes found.</p>
              )}
            </section>
            {stack.sensitive.length > 0 && (
              <section className="block">
                <h3>Files that may hold secrets</h3>
                <p className="small muted" style={{ marginBottom: 6 }}>
                  Names only. Baton never shows their contents.
                </p>
                <div className="mono small">{stack.sensitive.join(', ')}</div>
              </section>
            )}
            <section className="block">
              <div className="row" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>Test accounts</h3>
                <span className="spacer" />
                <button className="btn btn--sm btn--ghost" onClick={() => setAdding(true)}>
                  <I.plus size={14} />
                  Add
                </button>
              </div>
              {setup.data?.accounts.length ? (
                <div className="stack stack--sm">
                  {setup.data.accounts.map((a) => (
                    <div key={a.name} className="row">
                      <I.user size={15} color="var(--text-3)" />
                      <span>{a.name}</span>
                      <span className="small faint">{a.headerName}</span>
                      <span className="spacer" />
                      <button
                        className="btn btn--sm btn--ghost"
                        disabled={remove.busy}
                        onClick={() =>
                          void remove.run(async () => {
                            await command({ type: 'removeTestAccount', targetId: target.id, name: a.name })
                            setup.refetch()
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="small muted">None. Agents can only test signed-in features with a test account.</p>
              )}
              <ErrorBanner error={remove.error} />
            </section>
          </>
        )}
      </SidePanel>
      {adding && (
        <AccountModal
          targetId={target.id}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            setup.refetch()
          }}
        />
      )}
    </>
  )
}
