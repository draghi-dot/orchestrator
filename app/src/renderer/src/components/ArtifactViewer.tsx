import { useState } from 'react'
import { command, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import { ErrorBox, Loading, Modal, useToast } from './ui'
import { Icon } from './icons'
export function ArtifactViewer({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const { data, error, loading } = useQuery('artifact', { artifactId })
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const toast = useToast()
  const save = async () => {
    setSaving(true); setFailure(null)
    try { const result = await command({ type: 'exportArtifact', artifactId }); if (result.path) toast('Artifact saved') }
    catch (err) { setFailure(String(err)) } finally { setSaving(false) }
  }
  return <Modal title={data?.artifact.label ?? 'Evidence artifact'} onClose={onClose} wide>
    <ErrorBox error={error ?? failure}/>{loading && !data && <Loading/>}
    {data && <><div className="row spread"><span className={`badge ${data.verified ? 'badge--confirmed' : 'badge--rejected'}`}><Icon name="shield" size={14}/>{data.verified ? 'Hash verified' : 'Integrity check failed'}</span><span className="muted">{formatBytes(data.artifact.bytes)}</span><button className="btn btn--small" disabled={!data.verified || saving} onClick={() => void save()}><Icon name="download" size={16}/>Save file</button></div><p className="mono faint hash">SHA-256 {data.artifact.sha256}</p><ErrorBox error={data.error}/>{data.text !== null ? <pre className="codeblock">{data.text}</pre> : <p className="muted">No text preview is available.</p>}</>}
  </Modal>
}
