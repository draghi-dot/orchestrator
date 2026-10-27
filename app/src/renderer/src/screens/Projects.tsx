import { ChevronDown, ChevronRight, KeyRound, Lock, Server } from 'lucide-react'
import { useState } from 'react'
import type { CaseDef } from '../../../shared/domain'
import { Empty } from '../components/ui'
import { useQuery } from '../lib/api'
import { formatDateTime } from '../lib/format'

export function ProjectsScreen() {
  const overview = useQuery('overview', undefined)
  const data = overview.data

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Applications under test</div>
          <h1 className="h-display" style={{ marginTop: 8 }}>
            Projects
          </h1>
          <p className="lede">Each environment is a policy: where agents may go, what they may change, and which credentials exist. Secret values never reach this screen.</p>
        </div>
      </div>

      {data && data.projects.length === 0 ? (
        <div className="frame">
          <Empty title="No projects" />
        </div>
      ) : null}

      {data?.projects.map((project) => {
        const envs = data.environments.filter((e) => e.projectId === project.id)
        const suites = data.suites.filter((s) => s.projectId === project.id)
        return (
          <section key={project.id} style={{ marginBottom: 40 }}>
            <div className="frame frame--pad" style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
              <div style={{ flex: 1 }}>
                <h2 className="h-display" style={{ fontSize: '2rem' }}>
                  {project.name}
                </h2>
                <div className="row row--wrap" style={{ marginTop: 10 }}>
                  <span className="chip chip--line mono">{project.appUrl}</span>
                  <span className="chip chip--wash">owner {project.owner}</span>
                  <span className="chip chip--wash">
                    {envs.length} environment{envs.length === 1 ? '' : 's'} · {suites.length} suite{suites.length === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            </div>

            <div className="section-head">
              <h3 className="h-section">Environments</h3>
            </div>
            <div className="grid-2">
              {envs.map((env) => (
                <div key={env.id} className="frame frame--pad">
                  <div className="row">
                    <Server size={18} />
                    <h4 className="h-card">{env.name}</h4>
                    <span className="spacer" />
                    <span className={`chip ${env.allowMutatingMethods ? 'chip--accent' : ''}`}>
                      {env.allowMutatingMethods ? 'Writes allowed' : 'Read-only'}
                    </span>
                  </div>
                  <dl className="kv" style={{ marginTop: 16 }}>
                    <dt>Base URL</dt>
                    <dd className="mono">{env.baseUrl}</dd>
                    <dt>Allowed origins</dt>
                    <dd className="row row--wrap" style={{ gap: 6 }}>
                      {env.allowedOrigins.map((o) => (
                        <span key={o} className="chip chip--line mono">
                          {o}
                        </span>
                      ))}
                    </dd>
                    <dt>Test data</dt>
                    <dd>{env.testDataPolicy}</dd>
                    <dt>Reset</dt>
                    <dd>{env.resetInstructions}</dd>
                    <dt>Concurrency</dt>
                    <dd className="num">{env.concurrencyLimit} worker</dd>
                    <dt>Credentials</dt>
                    <dd className="stack" style={{ gap: 6 }}>
                      {env.secretRefs.length === 0 ? <span className="faint">None</span> : null}
                      {env.secretRefs.map((s) => (
                        <span key={s.name} className="row" style={{ gap: 8 }}>
                          <KeyRound size={14} />
                          <span className="mono">{s.name}</span>
                          <span className={`chip ${s.configured ? 'chip--wash' : 'chip--error'}`}>
                            <Lock size={12} />
                            {s.configured ? 'reference configured' : 'missing'}
                          </span>
                        </span>
                      ))}
                    </dd>
                  </dl>
                </div>
              ))}
            </div>

            <div className="section-head">
              <h3 className="h-section">Suites</h3>
            </div>
            <div className="stack">
              {suites.map((suite) => (
                <div key={suite.id} className="frame frame--pad">
                  <div className="row">
                    <h4 className="h-card">{suite.name}</h4>
                    <span className="spacer" />
                    <span className="faint" style={{ fontSize: '0.84rem' }}>
                      versions are immutable; edits create a new version
                    </span>
                  </div>
                  {suite.versions.map((v, i) => (
                    <div key={v.id} style={{ marginTop: 16 }}>
                      <div className="row row--wrap">
                        <span className={`chip ${i === 0 ? '' : 'chip--line'}`}>v{v.version}</span>
                        <span className="chip chip--line mono">{v.sourceRevision}</span>
                        <span className="faint" style={{ fontSize: '0.84rem' }}>
                          {v.cases.length} cases · {formatDateTime(v.createdAt)}
                        </span>
                      </div>
                      {i === 0 ? (
                        <div className="stack" style={{ gap: 8, marginTop: 12 }}>
                          {v.cases.map((c) => (
                            <CaseRow key={c.id} testCase={c} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

function CaseRow({ testCase }: { testCase: CaseDef }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 14px', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <strong>{testCase.title}</strong>
        <span className="faint mono" style={{ fontSize: '0.78rem' }}>
          {testCase.id}
        </span>
        <span className="spacer" />
        {testCase.tags.map((t) => (
          <span key={t} className="chip chip--wash">
            {t}
          </span>
        ))}
      </button>
      {open ? (
        <div style={{ padding: '0 16px 16px 40px' }} className="drop">
          <div className="muted" style={{ marginBottom: 10 }}>
            {testCase.preconditions}
          </div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Steps
          </div>
          <ol style={{ margin: '0 0 12px', paddingLeft: 18 }}>
            {testCase.steps.map((s) => (
              <li key={s.id} style={{ marginBottom: 4 }}>
                {s.title} {s.request ? <span className="mono faint">· {s.request.method} {s.request.url}</span> : null}
              </li>
            ))}
          </ol>
          <div className="eyebrow" style={{ marginBottom: 6 }}>
            Assertions
          </div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {testCase.assertions.map((a) => (
              <li key={a.id} style={{ marginBottom: 4 }}>
                {a.description} <span className="mono faint">· {a.kind}{a.path ? ` ${a.path}` : ''} = {JSON.stringify(a.expected)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
