/**
 * Pure run and task lifecycle tables (after Kestrel's dispatcher
 * state_machine.py). No clock, no I/O. Any (state, trigger) pair missing from
 * a table is illegal and throws rather than returning a wrong state.
 *
 * A run whose claims were refuted or confirmed still *completes*: `failed` is
 * reserved for the orchestration itself breaking (worker lost, wiring error).
 */

import type { RunState, TaskStatus } from './domain'

export class IllegalTransitionError extends Error {
  constructor(kind: string, from: string, trigger: string) {
    super(`illegal ${kind} transition: state=${from} trigger=${trigger}`)
    this.name = 'IllegalTransitionError'
  }
}

export type RunTrigger =
  | 'start'
  | 'request_pause'
  | 'pause_acknowledged'
  | 'resume'
  | 'request_cancel'
  | 'cancel'
  | 'complete'
  | 'fail'

const RUN_TRANSITIONS: Record<string, RunState> = {
  'queued:start': 'running',
  'queued:cancel': 'cancelled',
  'running:request_pause': 'pause_requested',
  'running:request_cancel': 'cancel_requested',
  'running:complete': 'completed',
  'running:fail': 'failed',
  'pause_requested:pause_acknowledged': 'paused',
  'pause_requested:resume': 'running',
  'pause_requested:request_cancel': 'cancel_requested',
  'pause_requested:complete': 'completed',
  'pause_requested:fail': 'failed',
  'paused:resume': 'running',
  'paused:request_cancel': 'cancel_requested',
  'paused:fail': 'failed',
  // The cancel latch wins: once requested, the only exit is `cancelled`.
  'cancel_requested:cancel': 'cancelled',
}

export function nextRunState(from: RunState, trigger: RunTrigger): RunState {
  const next = RUN_TRANSITIONS[`${from}:${trigger}`]
  if (next === undefined) throw new IllegalTransitionError('run', from, trigger)
  return next
}

export function canRun(from: RunState, trigger: RunTrigger): boolean {
  return RUN_TRANSITIONS[`${from}:${trigger}`] !== undefined
}

export type TaskTrigger = 'finish' | 'block' | 'error' | 'cancel'

const TASK_TRANSITIONS: Record<string, TaskStatus> = {
  'running:finish': 'done',
  'running:block': 'blocked',
  'running:error': 'error',
  'running:cancel': 'cancelled',
}

export function nextTaskStatus(from: TaskStatus, trigger: TaskTrigger): TaskStatus {
  const next = TASK_TRANSITIONS[`${from}:${trigger}`]
  if (next === undefined) throw new IllegalTransitionError('task', from, trigger)
  return next
}

export function triggerForTaskStatus(status: Exclude<TaskStatus, 'running'>): TaskTrigger {
  switch (status) {
    case 'done':
      return 'finish'
    case 'blocked':
      return 'block'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancel'
  }
}
