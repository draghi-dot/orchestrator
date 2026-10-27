import type { AccountStatus, Roster, RuntimeId } from '../../../shared/domain'
import { ROLES } from '../../../shared/domain'
import { AGENT, PROVIDER } from '../copy'
import { AGENT_ICON } from './icons'

const RUNTIMES: RuntimeId[] = ['claude', 'codex', 'omp', 'offline']

export function AgentTable({ value, onChange, accounts }: { value: Roster; onChange: (next: Roster) => void; accounts?: AccountStatus[] }) {
  const ready = (runtime: RuntimeId) => runtime === 'offline' || accounts?.find((a) => a.runtime === runtime)?.signedIn !== false
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th style={{ width: 190 }}>Model provider</th>
            <th style={{ width: 170 }}>Model</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => {
            const Icon = AGENT_ICON[role]
            const profile = value[role]
            return (
              <tr key={role}>
                <td>
                  <div className="agent-cell">
                    <span className="agent-icon">
                      <Icon size={15} />
                    </span>
                    <div>
                      <div className="cell-title">{AGENT[role].title}</div>
                      <div className="cell-sub">{AGENT[role].job}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <select
                    className="select select--sm"
                    aria-label={`${AGENT[role].title} provider`}
                    value={profile.runtime}
                    onChange={(e) => onChange({ ...value, [role]: { runtime: e.target.value as RuntimeId, model: '' } })}
                  >
                    {RUNTIMES.map((r) => (
                      <option key={r} value={r}>
                        {PROVIDER[r].name}
                        {ready(r) ? '' : ' (not connected)'}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="input select--sm"
                    style={{ height: 30 }}
                    aria-label={`${AGENT[role].title} model`}
                    disabled={profile.runtime === 'offline'}
                    placeholder={profile.runtime === 'offline' ? 'Not used' : 'Default'}
                    value={profile.model}
                    onChange={(e) => onChange({ ...value, [role]: { ...profile, model: e.target.value } })}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
