import { describe, expect, it } from 'vitest'
import {
  atLeast,
  maxSeverity,
  QUALITATIVE_RANK,
  type QualitativeSeverity,
  SEVERITY_RANK,
  type Severity,
} from './index.js'

describe('@sackville-mcp/severity — the shared qualitative scale', () => {
  it('ranks the four qualitative buckets worst-to-best', () => {
    expect(QUALITATIVE_RANK.critical).toBeGreaterThan(QUALITATIVE_RANK.high)
    expect(QUALITATIVE_RANK.high).toBeGreaterThan(QUALITATIVE_RANK.moderate)
    expect(QUALITATIVE_RANK.moderate).toBeGreaterThan(QUALITATIVE_RANK.low)
    expect(QUALITATIVE_RANK.low).toBe(1)
    expect(QUALITATIVE_RANK.critical).toBe(4)
  })

  // The whole point of the extraction: the verdict scale (with `none`) and the deps
  // scale (with `unknown`, built in @sackville-mcp/deps) must share ONE source of truth for
  // the four common buckets, so their ranks can never silently drift apart.
  it('SEVERITY_RANK derives the qualitative entries from QUALITATIVE_RANK, with none at 0', () => {
    expect(SEVERITY_RANK.none).toBe(0)
    for (const k of Object.keys(QUALITATIVE_RANK) as QualitativeSeverity[]) {
      expect(SEVERITY_RANK[k]).toBe(QUALITATIVE_RANK[k])
    }
    // `none` is the unique zero sentinel of the verdict scale; deps' `unknown` is a
    // DELIBERATELY distinct member (it maps to a no-signal pillar, never to none/low).
    expect(SEVERITY_RANK).not.toHaveProperty('unknown')
  })

  it('maxSeverity takes the worst, and is `none` when empty', () => {
    expect(maxSeverity('low', 'critical', 'moderate')).toBe('critical')
    expect(maxSeverity('none', 'low')).toBe('low')
    expect(maxSeverity()).toBe('none')
  })

  it('atLeast compares by rank', () => {
    const high: Severity = 'high'
    expect(atLeast(high, 'moderate')).toBe(true)
    expect(atLeast('low', 'high')).toBe(false)
    expect(atLeast('none', 'none')).toBe(true)
    expect(atLeast('critical', 'critical')).toBe(true)
  })
})
