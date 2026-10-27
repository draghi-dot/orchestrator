import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { CLAIM_STATUS_LABEL } from '../../../shared/domain'
import type { ClaimStatus } from '../../../shared/domain'
import { Icon } from './icons'
export function Badge({ status }: { status: string }) {
  const label = CLAIM_STATUS_LABEL[status as ClaimStatus] ?? status.replaceAll('_', ' ')
  return <span className={`badge badge--${status}`}><span className="status-dot"/>{label}</span>
}
export function PageHead({ title, description, action }: { eyebrow: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{description && <p className="lead">{description}</p>}</div>{action && <div className="page-actions">{action}</div>}</div>
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><Icon name="arena" size={36}/><h3>{title}</h3>{children && <div className="muted">{children}</div>}</div>
}
export function ErrorBox({ error }: { error?: string | null }) { return error ? <div className="callout callout--error" role="alert">{error}</div> : null }
export function Loading() { return <div className="loading" role="status"><span className="spinner"/>Loading…</div> }
export function Metric({ value, label, hint }: { value: string | number; label: string; hint?: string }) {
  return <div className="metric"><span className="metric__value">{value}</span><span className="metric__label">{label}</span>{hint && <small>{hint}</small>}</div>
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const close = useRef(onClose); close.current = onClose
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null
    const handler = (e: KeyboardEvent) => {
      if (document.querySelectorAll('[role="dialog"]').item(document.querySelectorAll('[role="dialog"]').length - 1) !== dialogRef.current) return
      if (e.key === 'Escape') close.current()
      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        const fields = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,select,textarea,[tabindex="0"]') ?? [])
        const first = fields[0], last = fields.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('keydown', handler)
    const timer = setTimeout(() => dialogRef.current?.querySelector<HTMLElement>('button')?.focus(), 0)
    return () => { clearTimeout(timer); window.removeEventListener('keydown', handler); focus?.focus() }
  }, [])
  return <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><section ref={dialogRef} className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal__head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close"/></button></div><div className="modal__body">{children}</div></section></div>
}
const ToastContext = createContext<(message: string) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(timer) }, [message])
  return <ToastContext.Provider value={setMessage}>{children}{message && <div className="toast" role="status"><Icon name="check"/>{message}</div>}</ToastContext.Provider>
}
export const useToast = () => useContext(ToastContext)
