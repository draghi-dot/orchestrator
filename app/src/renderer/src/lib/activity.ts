import type { ClaimStatus, EvidenceOutcome, Phase, Role, Stance } from '../../../shared/domain'
import type { Envelope, EventType } from '../../../shared/events'
import type { RunView } from '../../../shared/fold'
import { AGENT, EVIDENCE, FINDING_STATUS, PROVIDER, STANCE, STEP } from '../copy'

export type ActivityGroup = 'audit' | 'agents' | 'tools' | 'findings'
export type ActivityTone = 'neutral' | 'success' | 'warning' | 'danger'

export interface ActivityLine {
  group: ActivityGroup
  tone: ActivityTone
  actor: string | null
  text: string
  detail: string | null
}

const GROUP: Partial<Record<EventType, ActivityGroup>> = {
  task_started: 'agents',
  task_finished: 'agents',
  agent_message: 'agents',
  agent_blocked: 'agents',
  tool_called: 'tools',
  tool_result: 'tools',
  tool_rejected: 'tools',
  artifact_saved: 'tools',
  command_finished: 'tools',
  app_started: 'tools',
  app_stopped: 'tools',
  surface_noted: 'tools',
  claim_proposed: 'findings',
  claim_revised: 'findings',
  challenge_recorded: 'findings',
  evidence_checked: 'findings',
  claim_verdict: 'findings',
  regression_test_written: 'findings',
  claim_reviewed: 'findings',
}

/** Events that are noise in a human timeline. */
export const HIDDEN_EVENTS = new Set<EventType>(['worker_heartbeat', 'tool_called', 'artifact_saved'])

/** Tool results whose effect already has its own, clearer event. */
const DUPLICATE_TOOLS = new Set(['note', 'report_blocked', 'note_surface', 'propose_claim', 'revise_claim', 'challenge_claim', 'write_report', 'propose_rule_change', 'start_app', 'run_command', 'get_run_summary', 'get_dna', 'list_claims'])

export function isVisible(e: Envelope): boolean {
  if (HIDDEN_EVENTS.has(e.type)) return false
  if (e.type === 'tool_result' && DUPLICATE_TOOLS.has(String(e.payload.tool))) return false
  return true
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v))

export function describe(e: Envelope, view: RunView): ActivityLine {
  const p = e.payload
  const task = e.taskId ? view.tasks[e.taskId] : undefined
  const actor = task ? `${AGENT[task.role].name} agent` : null
  const claimTitle = (id: unknown) => view.claims[str(id)]?.title ?? 'a finding'
  const line = (text: string, detail: string | null = null, tone: ActivityTone = 'neutral'): ActivityLine => ({ group: GROUP[e.type] ?? 'audit', tone, actor, text, detail })

  switch (e.type) {
    case 'run_created':
      return line(`Audit created for ${str(p.target_name)}`)
    case 'run_started':
      return line('Audit started')
    case 'run_pause_requested':
      return line('Pause requested', 'Agents stop at the next safe point.')
    case 'run_paused':
      return line('Audit paused', null, 'warning')
    case 'run_resumed':
      return line('Audit resumed')
    case 'run_cancel_requested':
      return line('Stop requested', null, 'warning')
    case 'run_cancelled':
      return line('Audit stopped', null, 'warning')
    case 'run_completed':
      return line('Audit completed', null, 'success')
    case 'run_failed':
      return line('Audit failed', str(p.reason), 'danger')
    case 'phase_started':
      return line(`${STEP[str(p.phase) as Phase]?.name ?? str(p.phase)} step started`)
    case 'phase_finished':
      return line(`${STEP[str(p.phase) as Phase]?.name ?? str(p.phase)} step ${str(p.status) === 'done' ? 'finished' : str(p.status)}`, str(p.note) || null, str(p.status) === 'blocked' ? 'warning' : 'neutral')
    case 'round_started':
      return line(`Review round ${str(p.round)} started`)
    case 'task_started':
      return { ...line(`${AGENT[str(p.role) as Role]?.title ?? 'Agent'} started`, `Using ${PROVIDER[str(p.runtime) as keyof typeof PROVIDER]?.name ?? str(p.runtime)}`), actor: null }
    case 'task_finished': {
      const status = str(p.status)
      return {
        ...line(`${AGENT[str(p.role) as Role]?.title ?? 'Agent'} ${status === 'done' ? 'finished' : status}`, str(p.reason) || null, status === 'error' ? 'danger' : status === 'blocked' ? 'warning' : 'neutral'),
        actor: null,
      }
    }
    case 'agent_message':
      return line(str(p.text))
    case 'agent_blocked':
      return line('Blocked', str(p.reason), 'warning')
    case 'tool_result':
      return line(str(p.summary) || str(p.tool), null, p.ok === false ? 'warning' : 'neutral')
    case 'tool_rejected':
      return line(`Action refused: ${str(p.tool)}`, str(p.reason), 'warning')
    case 'command_finished':
      return line(`Ran ${str(p.command)}`, `Exit code ${str(p.exit_code)}`, Number(p.exit_code) === 0 ? 'neutral' : 'warning')
    case 'app_started':
      return line('App is running', str(p.url), 'success')
    case 'app_stopped':
      return line('App stopped', str(p.reason) || null)
    case 'surface_noted':
      return line(`Mapped ${str(p.kind)}: ${str(p.name)}`)
    case 'claim_proposed':
      return line(`Reported: ${str(p.title)}`, null)
    case 'claim_revised':
      return line(`${str(p.action) === 'withdraw' ? 'Withdrew' : 'Updated'}: ${claimTitle(p.claim_id)}`)
    case 'challenge_recorded': {
      const stance = STANCE[str(p.stance) as Stance]
      return line(`${stance?.label ?? str(p.stance)}: ${claimTitle(p.claim_id)}`, str(p.reasoning), str(p.stance) === 'dispute' ? 'warning' : 'neutral')
    }
    case 'evidence_checked': {
      const outcome = str(p.outcome) as EvidenceOutcome
      return { ...line(`${EVIDENCE[outcome]?.label ?? outcome}: ${claimTitle(p.claim_id)}`, str(p.detail) || null), actor: 'Baton' }
    }
    case 'claim_verdict': {
      const status = str(p.status) as ClaimStatus
      const tone: ActivityTone = status === 'confirmed' ? 'danger' : status === 'needs_review' ? 'warning' : status === 'rejected' ? 'success' : 'neutral'
      return { ...line(`${FINDING_STATUS[status]?.label ?? status}: ${claimTitle(p.claim_id)}`, str(p.reason) || null, tone), actor: 'Baton' }
    }
    case 'regression_test_written':
      return { ...line(`Regression test written for ${claimTitle(p.claim_id)}`, p.fails_now ? 'Fails on this build, as expected while the issue exists.' : 'Passes on this build.'), actor: 'Baton' }
    case 'claim_reviewed':
      return line(`${str(p.decision) === 'accepted' ? 'Confirmed' : 'Marked false positive'} by ${str(p.reviewer)}: ${claimTitle(p.claim_id)}`, str(p.reason) || null)
    case 'report_written':
      return line(`Report version ${str(p.version)} written`, str(p.author) || null)
    case 'rule_change_proposed':
      return line(`Suggested playbook change: ${str(p.text)}`)
    case 'rule_change_decided':
      return line(`Playbook suggestion ${str(p.status)}`, str(p.reason) || null)
    case 'dna_versioned':
      return line(`Playbook updated to version ${str(p.version)}`)
    default:
      return line(e.type.replace(/_/g, ' '))
  }
}
