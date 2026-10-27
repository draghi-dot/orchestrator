import { describe, expect, it } from 'vitest'
import { IllegalTransitionError, canRun, nextAttemptStatus, nextRunState } from '../src/shared/lifecycle'
import { InvalidEventPayloadError, UnknownEventTypeError, validateEvent } from '../src/shared/events'

describe('run lifecycle', () => {
  it('follows the legal path', () => {
    expect(nextRunState('queued', 'start')).toBe('running')
    expect(nextRunState('running', 'request_pause')).toBe('pause_requested')
    expect(nextRunState('pause_requested', 'pause_acknowledged')).toBe('paused')
    expect(nextRunState('paused', 'resume')).toBe('running')
    expect(nextRunState('running', 'complete')).toBe('completed')
  })

  it('rejects illegal transitions instead of returning a wrong state', () => {
    expect(() => nextRunState('queued', 'complete')).toThrow(IllegalTransitionError)
    expect(() => nextRunState('paused', 'complete')).toThrow(IllegalTransitionError)
    expect(() => nextRunState('running', 'pause_acknowledged')).toThrow(IllegalTransitionError)
  })

  it('has no exits from terminal states', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      for (const trigger of ['start', 'request_pause', 'pause_acknowledged', 'resume', 'request_cancel', 'cancel', 'complete', 'fail'] as const) {
        expect(canRun(state, trigger)).toBe(false)
      }
    }
  })

  it('latches cancellation: a cancel-requested run can only end cancelled', () => {
    expect(nextRunState('cancel_requested', 'cancel')).toBe('cancelled')
    expect(() => nextRunState('cancel_requested', 'complete')).toThrow(IllegalTransitionError)
    expect(() => nextRunState('cancel_requested', 'resume')).toThrow(IllegalTransitionError)
  })

  it('closes attempts exactly once', () => {
    expect(nextAttemptStatus('running', 'fail')).toBe('failed')
    expect(() => nextAttemptStatus('failed', 'pass')).toThrow(IllegalTransitionError)
  })
})

describe('event registry', () => {
  it('rejects unknown types and missing fields', () => {
    expect(() => validateEvent('hunt_started', {})).toThrow(UnknownEventTypeError)
    expect(() => validateEvent('attempt_finished', { case_id: 'x' })).toThrow(InvalidEventPayloadError)
    expect(() => validateEvent('run_started', {})).not.toThrow()
  })
})
