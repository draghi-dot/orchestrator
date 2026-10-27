import { command, useQuery } from '../lib/api'
import { formatBytes } from '../lib/format'
import { I } from './icons'
import { ErrorBanner, Loading, Modal, Pill, useAction, useToast } from './ui'

export function ArtifactViewer({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const { data, error, loading } = useQuery('artifact', { artifactId })
  const save = useAction()
  const toast = useToast()

  return (
    <Modal
      wide
      title={data?.artifact.label ?? 'Evidence'}
      onClose={onClose}
      footer={
        <>
          <span className="hash truncate" style={{ marginRight: 'auto' }}>
            SHA-256 {data?.artifact.sha256}
          </span>
          <button
            className="btn"
            disabled={!data?.verified || save.busy}
            onClick={() =>
              void save.run(async () => {
                const result = await command({ type: 'exportArtifact', artifactId })
                if (result.path) toast('Saved')
              })
            }
          >
            <I.download size={15} />
            Save file
          </button>
        </>
      }
    >
      <ErrorBanner error={error ?? save.error} />
      {loading && !data && <Loading />}
      {data && (
        <div className="stack stack--sm">
          <div className="row">
            {data.verified ? (
              <Pill tone="success" dot>
                Integrity verified
              </Pill>
            ) : (
              <Pill tone="danger" dot>
                Integrity check failed
              </Pill>
            )}
            {data.artifact.redaction !== 'none' && <Pill>Credentials redacted</Pill>}
            <span className="faint small">{formatBytes(data.artifact.bytes)}</span>
          </div>
          <ErrorBanner error={data.error} />
          {data.text !== null ? <pre className="code code--tall">{data.text}</pre> : <p className="muted">No preview for this file type.</p>}
        </div>
      )}
    </Modal>
  )
}
