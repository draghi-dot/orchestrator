/**
 * The closed QA DNA event vocabulary (after Kestrel's wire/envelope.py).
 *
 * Every durable event has a gap-free global `seq`. A writer must use a
 * registered `type` and supply its required payload fields; anything else is
 * rejected at publish time and never stored.
 */

export interface Envelope {
  seq: number
  eventId: string
  runId: string
  taskId: string | null
  type: EventType
  ts: string
  payload: Record<string, unknown>
}

export const EVENT_SCHEMAS = {
  run_created: ['target_name', 'mode', 'roster', 'initiator', 'dna_version'],
  run_started: [],
  run_pause_requested: ['by'],
  run_paused: [],
  run_resumed: ['by'],
  run_cancel_requested: ['by'],
  run_cancelled: ['mode'],
  run_completed: ['summary'],
  run_failed: ['reason'],
  phase_started: ['phase'],
  phase_finished: ['phase', 'status', 'note'],
  task_started: ['role', 'phase', 'runtime', 'worker_id', 'attempt_number'],
  task_finished: ['role', 'phase', 'status', 'reason'],
  worker_heartbeat: ['worker_id'],
  agent_message: ['text'],
  agent_blocked: ['reason'],
  tool_called: ['tool_call_id', 'tool', 'args'],
  tool_result: ['tool_call_id', 'tool', 'ok', 'summary'],
  tool_rejected: ['tool_call_id', 'tool', 'reason'],
  artifact_saved: ['artifact_id', 'sha256', 'mime', 'label', 'bytes'],
  command_finished: ['command', 'exit_code', 'duration_ms'],
  app_started: ['url', 'command'],
  app_stopped: ['url', 'reason'],
  surface_noted: ['kind', 'name'],
  claim_proposed: ['claim_id', 'title', 'severity', 'area', 'has_repro'],
  challenge_recorded: ['claim_id', 'stance', 'reasoning'],
  replay_finished: ['claim_id', 'outcome', 'detail'],
  claim_verdict: ['claim_id', 'status', 'reason'],
  claim_reviewed: ['claim_id', 'decision', 'reason', 'reviewer'],
  report_written: ['report_id', 'version', 'author'],
  rule_change_proposed: ['change_id', 'op', 'role', 'text'],
  rule_change_decided: ['change_id', 'status', 'by', 'reason'],
  dna_versioned: ['dna_id', 'version'],
} as const satisfies Record<string, readonly string[]>

export type EventType = keyof typeof EVENT_SCHEMAS

export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[]

/** Events that change read models outside the run workspace (lists, counts,
 * review queue, DNA). */
export const SHARED_FACT_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'run_created',
  'run_started',
  'run_pause_requested',
  'run_paused',
  'run_resumed',
  'run_cancel_requested',
  'run_cancelled',
  'run_completed',
  'run_failed',
  'phase_finished',
  'claim_verdict',
  'claim_reviewed',
  'rule_change_proposed',
  'rule_change_decided',
  'dna_versioned',
])

export class UnknownEventTypeError extends Error {
  constructor(type: string) {
    super(`unknown event type: ${type}`)
    this.name = 'UnknownEventTypeError'
  }
}

export class InvalidEventPayloadError extends Error {
  constructor(type: string, missing: string[]) {
    super(`event ${type} missing required payload fields: ${missing.join(', ')}`)
    this.name = 'InvalidEventPayloadError'
  }
}

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, value)
}

export function validateEvent(type: string, payload: Record<string, unknown>): asserts type is EventType {
  if (!isEventType(type)) throw new UnknownEventTypeError(type)
  const missing = EVENT_SCHEMAS[type].filter((field) => !(field in payload))
  if (missing.length > 0) throw new InvalidEventPayloadError(type, missing)
}

/** Bounded text for anything a model, a remote server, or a build produced. */
export function bounded(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`
}
