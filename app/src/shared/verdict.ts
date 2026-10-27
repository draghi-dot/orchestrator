/**
 * How a claim is settled. Two independent inputs:
 *
 *  - the host's replay of the claim's reproduction settles the FACT: does the
 *    app actually fail the check the claimant says a correct app passes?
 *  - the Thinker's challenge settles the INTERPRETATION: is that check really
 *    what the app is supposed to do?
 *
 * Words never override the replay. When the two disagree, or there is no
 * replay at all, a person decides.
 */

import type { Check, ClaimStatus, ReplayOutcome, Stance } from './domain'

export interface Observation {
  status: number
  bodyText: string
}

export interface CheckResult {
  passed: boolean
  expected: string
  actual: string
}

const show = (v: unknown): string => JSON.stringify(v) ?? 'undefined'

export function readPath(value: unknown, path: string): { found: boolean; value: unknown } {
  let cursor: unknown = value
  for (const key of path.split('.').filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object' || !(key in (cursor as object))) return { found: false, value: undefined }
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return { found: true, value: cursor }
}

/** Evaluate what a CORRECT app would return against what this one did. */
export function evaluateCheck(check: Check, observation: Observation): CheckResult {
  switch (check.kind) {
    case 'status_equals':
      return { passed: observation.status === Number(check.expected), expected: `status ${check.expected}`, actual: `status ${observation.status}` }
    case 'body_contains': {
      const needle = String(check.expected)
      const passed = observation.bodyText.includes(needle)
      return { passed, expected: `body contains ${show(needle)}`, actual: passed ? `body contains ${show(needle)}` : `body does not contain ${show(needle)}` }
    }
    case 'json_equals': {
      const expected = `${check.path} = ${show(check.expected)}`
      let parsed: unknown
      try {
        parsed = JSON.parse(observation.bodyText)
      } catch {
        return { passed: false, expected, actual: 'response is not JSON' }
      }
      const { found, value } = readPath(parsed, check.path ?? '')
      if (!found) return { passed: false, expected, actual: `${check.path} is missing` }
      return { passed: JSON.stringify(value) === JSON.stringify(check.expected), expected, actual: `${check.path} = ${show(value)}` }
    }
  }
}

export function settleClaim(replay: ReplayOutcome, stances: Stance[]): { status: ClaimStatus; reason: string } {
  const disputed = stances.includes('dispute')
  const agreed = stances.length > 0 && stances.every((s) => s === 'agree')
  switch (replay) {
    case 'not_reproduced':
      return { status: 'refuted', reason: 'The host replayed the reproduction and the app passed the check.' }
    case 'reproduced':
      if (agreed) return { status: 'confirmed', reason: 'Reproduced by the host and the challenger agreed.' }
      if (disputed) return { status: 'disputed', reason: 'Reproduced by the host, but the challenger disputes that this is a defect.' }
      return { status: 'disputed', reason: 'Reproduced by the host; the challenger was not sure it is a defect.' }
    case 'error':
      return { status: 'unverified', reason: 'The host could not complete the replay.' }
    case 'no_repro':
      return {
        status: 'unverified',
        reason: disputed ? 'No reproduction, and the challenger disputes it.' : 'No reproduction the host can replay.',
      }
  }
}

/** Is a settled claim a real defect? `null` while a person still has to decide. */
export function claimTruth(status: ClaimStatus, review: 'accepted' | 'rejected' | null): boolean | null {
  if (review === 'accepted') return true
  if (review === 'rejected') return false
  if (status === 'confirmed') return true
  if (status === 'refuted') return false
  return null
}
