import { Bot, CircleCheck, CircleX, Cog, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentSettings } from '../../../shared/domain'
import { useToast } from '../components/ui'
import { command, useQuery } from '../lib/api'

const HOST_TOOLS = [
  ['qa_step', 'Marks step boundaries. Drives the step list you see live.'],
  ['qa_http_request', 'HTTP against allowed origins only. Every response is hashed evidence.'],
  ['qa_note', 'Short operator-facing context. Never treated as a result.'],
  ['qa_report_blocked', 'Stops the case with a reason. Becomes a blocked attempt.'],
]

export function AgentScreen() {
  const settings = useQuery('settings', undefined)
  const [statusTick, setStatusTick] = useState(0)
  const status = useQuery('agentStatus', undefined, statusTick)
  const toast = useToast()
  const [draft, setDraft] = useState<AgentSettings | null>(null)
  const [toolsText, setToolsText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (settings.data && !draft) {
      setDraft(settings.data)
      setToolsText(settings.data.ompBuiltinTools.join(', '))
    }
  }, [settings.data, draft])

  if (!draft) return null

  const save = async (next: AgentSettings) => {
    setSaving(true)
    try {
      const saved = await command({ type: 'saveSettings', settings: next })
      setDraft(saved)
      setToolsText(saved.ompBuiltinTools.join(', '))
      toast.show('Agent settings saved. New runs use them; running runs keep their frozen profile.')
      setStatusTick((t) => t + 1)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : String(err), 'fail')
    } finally {
      setSaving(false)
    }
  }

  const omp = status.data?.omp

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Workers</div>
          <h1 className="h-display" style={{ marginTop: 8 }}>
            Agent
          </h1>
          <p className="lede">Agents sit behind one adapter seam. They act only through QA host tools; pass and fail come from deterministic assertions on what those tools recorded.</p>
        </div>
      </div>

      <div className="grid-2">
        <button className={`frame adapter-card ${draft.defaultAdapter === 'scripted' ? 'on' : ''}`} onClick={() => save({ ...draft, defaultAdapter: 'scripted' })}>
          <Cog size={26} />
          <h2 className="h-section" style={{ marginTop: 14 }}>
            Scripted
          </h2>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Deterministic, no model. Follows each step's literal request through the same tool surface. Use it to prove the lifecycle and your assertions.
          </p>
          <div className="row" style={{ marginTop: 16 }}>
            <span className="chip">
              <CircleCheck size={14} />
              Always available
            </span>
          </div>
        </button>

        <button className={`frame adapter-card ${draft.defaultAdapter === 'omp' ? 'on' : ''}`} onClick={() => save({ ...draft, defaultAdapter: 'omp' })}>
          <Bot size={26} />
          <h2 className="h-section" style={{ marginTop: 14 }}>
            oh-my-pi
          </h2>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Model-backed worker. Runs <span className="mono">omp --mode rpc</span> per attempt with built-in tools off; the QA host tools are its whole action surface.
          </p>
          <div className="row row--wrap" style={{ marginTop: 16 }}>
            {status.loading && !omp ? <span className="chip chip--line">Checking…</span> : null}
            {omp?.available ? (
              <span className="chip">
                <CircleCheck size={14} />
                {omp.version ?? 'available'}
              </span>
            ) : omp ? (
              <span className="chip chip--error">
                <CircleX size={14} />
                Not installed
              </span>
            ) : null}
            {omp?.available ? (
              omp.ready ? (
                <span className="chip chip--wash">Signed in{omp.model ? ` · ${omp.model}` : ''}</span>
              ) : (
                <span className="chip chip--accent">Not signed in</span>
              )
            ) : null}
            {omp?.path ? <span className="chip chip--line mono">{omp.path}</span> : null}
          </div>
        </button>
      </div>

      <div className="section-head">
        <h2 className="h-section">oh-my-pi settings</h2>
        <button className="btn btn--small btn--ghost" onClick={() => setStatusTick((t) => t + 1)}>
          <RefreshCw size={14} />
          Re-check
        </button>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="frame frame--pad stack" style={{ gap: 16 }}>
          {omp && !omp.available ? (
            <div className="callout">
              <TriangleAlert size={18} style={{ flex: 'none', marginTop: 2 }} />
              <div>
                <strong>omp was not found.</strong> {omp.error}
                <div className="mono selectable" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  brew install can1357/tap/omp
                  <br />
                  curl -fsSL https://omp.sh/install | sh
                </div>
                <div style={{ marginTop: 8 }}>
                  Then sign in to a model provider once with <span className="mono">omp</span> in a terminal (for example <span className="mono">/login</span>).
                </div>
              </div>
            </div>
          ) : null}
          {omp?.available && !omp.ready ? (
            <div className="callout">
              <TriangleAlert size={18} style={{ flex: 'none', marginTop: 2 }} />
              <div>
                <strong>omp is installed but cannot start a session.</strong> {omp.error}
                <div style={{ marginTop: 8 }}>Sign in once from a terminal, then press Re-check:</div>
                <div className="mono selectable" style={{ marginTop: 8, lineHeight: 1.7 }}>
                  omp login openai-codex
                  <span className="faint"> # ChatGPT Plus/Pro (Codex)</span>
                  <br />
                  omp login anthropic
                  <span className="faint"> # Claude account</span>
                </div>
                <div className="faint" style={{ marginTop: 8 }}>
                  An API key also works: set ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment omp runs with.
                </div>
              </div>
            </div>
          ) : null}
          <label className="field">
            <span>Command</span>
            <input className="input mono" value={draft.ompCommand} onChange={(e) => setDraft({ ...draft, ompCommand: e.target.value })} />
          </label>
          <label className="field">
            <span>Model (optional: id, fuzzy name, or role like @slow)</span>
            <input className="input mono" value={draft.ompModel} placeholder="uses omp's default model" onChange={(e) => setDraft({ ...draft, ompModel: e.target.value })} />
          </label>
          <label className="field">
            <span>Extra built-in tools (comma separated, default none)</span>
            <input className="input mono" value={toolsText} placeholder="e.g. browser" onChange={(e) => setToolsText(e.target.value)} />
          </label>
          {toolsText.trim() ? (
            <div className="callout callout--fail">
              <TriangleAlert size={18} style={{ flex: 'none', marginTop: 2 }} />
              <div>Built-in tools run inside omp. Their traffic is not checked against the environment's allowed origins by this app. Prefer the host tools.</div>
            </div>
          ) : null}
          <div className="row">
            <span className="spacer" />
            <button
              className="btn"
              disabled={saving}
              onClick={() =>
                save({
                  ...draft,
                  ompBuiltinTools: toolsText
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean),
                })
              }
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>

        <div className="dark" style={{ padding: '22px 24px' }}>
          <div className="row">
            <ShieldCheck size={20} />
            <strong style={{ fontStretch: '112%', fontSize: '1.05rem' }}>Host tool surface</strong>
          </div>
          <p style={{ color: 'var(--on-dark-muted)', margin: '10px 0 16px', fontSize: '0.9rem' }}>
            Registered with <span className="mono">set_host_tools</span>. Each call is policy-checked, executed at most once per call id, and written to the event log.
          </p>
          <div className="stack" style={{ gap: 12 }}>
            {HOST_TOOLS.map(([name, text]) => (
              <div key={name} style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
                <span className="mono" style={{ color: 'var(--accent)' }}>
                  {name}
                </span>
                <span style={{ color: 'var(--on-dark)', fontSize: '0.88rem' }}>{text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
