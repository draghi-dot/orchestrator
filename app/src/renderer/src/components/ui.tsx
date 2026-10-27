import { type ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Tone } from '../copy'
import { I, Spinner } from './icons'

export function Pill({ tone = 'neutral', dot = false, pulse = false, children, title }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; title?: string }) {
  const cls = tone === 'neutral' ? '' : `pill--${tone}`
  const dotCls = tone === 'success' ? 'dot--success' : tone === 'warning' ? 'dot--warning' : tone === 'danger' ? 'dot--danger' : tone === 'accent' ? 'dot--accent' : ''
  return (
    <span className={`pill ${cls}`} title={title}>
      {dot && <span className={`dot ${dotCls} ${pulse ? 'dot--pulse' : ''}`} />}
      {children}
    </span>
  )
}

export function Severity({ level }: { level: string }) {
  return (
    <span className={`sev sev--${level}`}>
      <span className="sev__bar" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      {level}
    </span>
  )
}

export function Empty({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty__icon">{icon}</div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="row">{actions}</div>}
    </div>
  )
}

export function Banner({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning' | 'danger'; children: ReactNode }) {
  const Icon = tone === 'danger' ? I.warningCircle : tone === 'warning' ? I.warning : I.info
  return (
    <div className={`banner ${tone === 'neutral' ? '' : `banner--${tone}`}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div>{children}</div>
    </div>
  )
}

export function ErrorBanner({ error }: { error?: string | null }) {
  return error ? <Banner tone="danger">{error.replace(/^Error:\s*/, '')}</Banner> : null
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Spinner />
      {label}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function useEscape(onEscape: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onEscape])
}

export function Modal({ title, onClose, wide = false, footer, children }: { title: ReactNode; onClose: () => void; wide?: boolean; footer?: ReactNode; children: ReactNode }) {
  useEscape(onClose)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not([aria-label="Close"])')?.focus()
  }, [])
  return (
    <>
      <div className="layer layer--modal" onClick={onClose} />
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" ref={ref}>
        <div className="modal__head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <I.close size={16} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </>
  )
}

export function SidePanel({ head, footer, onClose, children }: { head: ReactNode; footer?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEscape(onClose)
  return (
    <>
      <div className="layer" onClick={onClose} />
      <aside className="panel-side" role="dialog" aria-modal="true">
        <div className="panel-side__head">
          <div style={{ flex: 1, minWidth: 0 }}>{head}</div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <I.close size={16} />
          </button>
        </div>
        <div className="panel-side__body">{children}</div>
        {footer && <div className="panel-side__foot">{footer}</div>}
      </aside>
    </>
  )
}

type Toast = (message: string) => void
const ToastContext = createContext<Toast>(() => undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null)
  const show = useCallback<Toast>((text) => {
    const id = Date.now()
    setMessage({ text, id })
    setTimeout(() => setMessage((m) => (m?.id === id ? null : m)), 3200)
  }, [])
  return (
    <ToastContext.Provider value={show}>
      {children}
      {message && (
        <div className="toast" role="status">
          <I.checkCircle size={16} />
          {message.text}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

/** Run an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}
