import { FileText, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import { useEffect } from 'react'
import { useQuery } from '../lib/api'
import { formatBytes, formatDateTime } from '../lib/format'

export function ArtifactViewer({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const { data, error, loading } = useQuery('artifact', { artifactId })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="frame sheet" role="dialog" aria-modal="true" aria-label="Artifact" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <FileText size={22} style={{ marginTop: 2 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="h-card selectable">{data?.artifact.label ?? 'Artifact'}</div>
            {data ? (
              <div className="row row--wrap" style={{ marginTop: 8 }}>
                {data.verified ? (
                  <span className="chip">
                    <ShieldCheck size={14} />
                    Hash verified
                  </span>
                ) : (
                  <span className="chip chip--fail">
                    <ShieldAlert size={14} />
                    Integrity check failed
                  </span>
                )}
                {data.artifact.redaction !== 'none' ? <span className="chip chip--accent">Sensitive headers redacted</span> : null}
                <span className="chip chip--line">{data.artifact.mime}</span>
                <span className="chip chip--line">{formatBytes(data.artifact.bytes)}</span>
                <span className="chip chip--line">{formatDateTime(data.artifact.createdAt)}</span>
              </div>
            ) : null}
            {data ? (
              <div className="mono faint selectable" style={{ marginTop: 8 }}>
                sha256 {data.artifact.sha256}
              </div>
            ) : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="sheet__body">
          {loading && !data ? <div className="empty">Loading…</div> : null}
          {error ? <div className="callout callout--fail" style={{ margin: 20 }}>{error}</div> : null}
          {data?.error ? <div className="callout callout--fail" style={{ margin: 20 }}>{data.error}</div> : null}
          {data?.text !== null && data?.text !== undefined ? <pre className="codeblock">{data.text}</pre> : null}
          {data && data.verified && data.text === null ? <div className="empty">Binary artifact; preview not available.</div> : null}
        </div>
      </div>
    </div>
  )
}
