/**
 * How a claim is settled (the judge). Two independent inputs:
 *
 *  - the host's own evidence check settles the FACT: replaying the claim's
 *    requests shows whether the app fails the check a correct app passes,
 *    and a code claim's quoted lines either exist at the cited place or not;
 *  - the Thinker's challenge settles the INTERPRETATION: is that really a
 *    defect, given what the app promises?
 *
 * No claim is confirmed because an agent says so. Words never override the
 * evidence; when evidence holds but the challenger objects, a person decides.
 */

import type { Check, ClaimStatus, EvidenceOutcome, Stance } from './domain'

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
        return { passed: false, expected, actual: `status ${observation.status}, response is not JSON` }
      }
      const { found, value } = readPath(parsed, check.path ?? '')
      if (!found) return { passed: false, expected, actual: `${check.path} is missing (status ${observation.status})` }
      return { passed: JSON.stringify(value) === JSON.stringify(check.expected), expected, actual: `${check.path} = ${show(value)}` }
    }
  }
}

/** Evidence that holds up: the defect reproduced, or the cited code exists. */
export const evidenceHolds = (outcome: EvidenceOutcome) => outcome === 'reproduced' || outcome === 'code_verified'

export function settleClaim(evidence: EvidenceOutcome, stances: Stance[]): { status: ClaimStatus; reason: string } {
  const agreed = stances.length > 0 && stances.every((s) => s === 'agree')
  const disputed = stances.includes('dispute')
  switch (evidence) {
    case 'not_reproduced':
      return { status: 'rejected', reason: 'The host re-ran the reproduction and the app behaved correctly.' }
    case 'code_missing':
      return { status: 'rejected', reason: 'The quoted code is not at the cited location.' }
    case 'reproduced':
      if (agreed) return { status: 'confirmed', reason: 'The host reproduced it and the challenger agreed.' }
      return {
        status: 'needs_review',
        reason: disputed ? 'The host reproduced it, but the challenger disputes that it is a defect.' : 'The host reproduced it; the challenger was not sure it is a defect.',
      }
    case 'code_verified':
      if (agreed) return { status: 'confirmed', reason: 'The cited code exists as quoted and the challenger agreed.' }
      return {
        status: 'needs_review',
        reason: disputed ? 'The cited code exists, but the challenger disputes the conclusion.' : 'The cited code exists; the challenger was not sure.',
      }
    case 'error':
      return { status: 'inconclusive', reason: 'The host could not complete the check.' }
    case 'no_evidence':
      return { status: 'inconclusive', reason: disputed ? 'No reproduction or code quote, and the challenger disputes it.' : 'No reproduction or code quote the host can check.' }
  }
}

/** Is a settled claim a real defect? `null` while it is still open. */
export function claimTruth(status: ClaimStatus, review: 'accepted' | 'rejected' | null): boolean | null {
  if (review === 'accepted') return true
  if (review === 'rejected') return false
  if (status === 'confirmed') return true
  if (status === 'rejected') return false
  return null
}

/** Normalize code for a citation check: whitespace-insensitive. */
export const normalizeCode = (text: string) => text.replace(/\s+/g, ' ').trim()
