import { describe, expect, it } from 'vitest'
import { cvssV3BaseScore } from './cvss.js'

describe('cvssV3BaseScore — CVSS v3.0/v3.1 base score from a vector', () => {
  it('scores a critical network vector (scope unchanged) as 9.8', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8)
  })

  it('scores a confidentiality-only network vector as 5.3 (moderate range)', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N')).toBe(5.3)
  })

  it('handles a scope-changed vector (the 1.08 multiplier) — 6.1', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1)
  })

  it('scores a no-impact vector as 0.0', () => {
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0)
  })

  it('accepts CVSS:3.0 vectors with the same base formula', () => {
    expect(cvssV3BaseScore('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8)
  })

  it('returns undefined for a non-v3 vector (v2/v4) or a malformed one', () => {
    expect(cvssV3BaseScore('AV:N/AC:L/Au:N/C:C/I:C/A:C')).toBeUndefined() // CVSS v2
    expect(cvssV3BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H')).toBeUndefined()
    expect(cvssV3BaseScore('CVSS:3.1/AV:N/AC:L')).toBeUndefined() // missing required metrics
    expect(cvssV3BaseScore('not a vector')).toBeUndefined()
  })
})
