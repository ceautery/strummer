import { describe, expect, it } from 'vitest'
import type { FlakeVerdict } from './classify.js'
import { Quarantine, QuarantineGateError, quarantineCandidates } from './quarantine.js'
import { HistoryStore } from './store.js'

const NOW = '2026-06-01T00:00:00Z'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const IN_BOUNDS = '2026-06-03T00:00:00Z' // +2 days
const OUT_OF_BOUNDS = '2026-07-01T00:00:00Z' // +30 days

function open(policy: Partial<ConstructorParameters<typeof Quarantine>[1]> = {}) {
  const store = HistoryStore.memory()
  const q = new Quarantine(store, { allowQuarantine: true, maxExpiryMs: WEEK_MS, ...policy })
  return { store, q }
}

describe('Quarantine gate', () => {
  it('denies a write when allowQuarantine is false (deny-by-default)', () => {
    const { q } = open({ allowQuarantine: false })
    expect(() =>
      q.quarantine({ testId: 't', reason: 'flaky', expiresAt: IN_BOUNDS, now: NOW }),
    ).toThrow(QuarantineGateError)
  })

  it('denies a write when no expiry bound is configured (maxExpiryMs is load-bearing)', () => {
    const { q } = open({ maxExpiryMs: 0 })
    expect(() =>
      q.quarantine({ testId: 't', reason: 'flaky', expiresAt: IN_BOUNDS, now: NOW }),
    ).toThrow(QuarantineGateError)
  })

  it('refuses an expiry beyond the operator cap (fails loud, no silent clamp)', () => {
    const { q } = open()
    expect(() =>
      q.quarantine({ testId: 't', reason: 'flaky', expiresAt: OUT_OF_BOUNDS, now: NOW }),
    ).toThrow(/cap/i)
  })

  it('refuses a non-future / unparseable expiry and a missing reason', () => {
    const { q } = open()
    expect(() => q.quarantine({ testId: 't', reason: 'x', expiresAt: NOW, now: NOW })).toThrow()
    expect(() =>
      q.quarantine({ testId: 't', reason: 'x', expiresAt: 'not-a-date', now: NOW }),
    ).toThrow()
    expect(() =>
      q.quarantine({ testId: 't', reason: '  ', expiresAt: IN_BOUNDS, now: NOW }),
    ).toThrow(/reason/i)
  })

  it('records a bounded quarantine and reports it active before expiry', () => {
    const { q } = open()
    const entry = q.quarantine({
      testId: 't',
      reason: 'fails ~30% on CI',
      expiresAt: IN_BOUNDS,
      flakeScore: 0.42,
      now: NOW,
    })
    expect(entry).toEqual({
      testId: 't',
      reason: 'fails ~30% on CI',
      flakeScore: 0.42,
      quarantinedAt: NOW,
      expiresAt: IN_BOUNDS,
    })
    expect(q.isQuarantined('t', NOW)).toBe(true)
    expect(q.active(NOW).map((e) => e.testId)).toEqual(['t'])
  })

  it('treats an expired quarantine as inactive (auto-expiry)', () => {
    const { q } = open()
    q.quarantine({ testId: 't', reason: 'x', expiresAt: IN_BOUNDS, now: NOW })
    const later = '2026-06-10T00:00:00Z'
    expect(q.isQuarantined('t', later)).toBe(false)
    expect(q.active(later)).toEqual([])
    // ...but the row is retained for audit until released.
    expect(q.all().map((e) => e.testId)).toEqual(['t'])
  })

  it('upserts on re-quarantine of the same test', () => {
    const { q } = open()
    q.quarantine({ testId: 't', reason: 'first', expiresAt: IN_BOUNDS, now: NOW })
    q.quarantine({ testId: 't', reason: 'second', expiresAt: IN_BOUNDS, now: NOW })
    expect(q.all()).toHaveLength(1)
    expect(q.all()[0]?.reason).toBe('second')
  })

  it('release is ungated (re-enabling a test can only make the gate stricter)', () => {
    const { q } = open({ allowQuarantine: false })
    // Seed via an allowed instance, then release with a denied one.
    const { q: allowed, store } = open()
    allowed.quarantine({ testId: 't', reason: 'x', expiresAt: IN_BOUNDS, now: NOW })
    const denied = new Quarantine(store, { allowQuarantine: false, maxExpiryMs: 0 })
    expect(denied.release('t')).toBe(true)
    expect(denied.release('t')).toBe(false)
    expect(denied.isQuarantined('t', NOW)).toBe(false)
    void q
  })
})

describe('quarantineCandidates', () => {
  const verdicts: FlakeVerdict[] = [
    {
      id: 'low',
      state: 'flaky',
      runs: 10,
      passes: 9,
      failures: 1,
      failureRate: 0.1,
      wilson: { lower: 0.02, center: 0.2, upper: 0.4 },
      flakeScore: 0.02,
    },
    {
      id: 'high',
      state: 'flaky',
      runs: 20,
      passes: 8,
      failures: 12,
      failureRate: 0.6,
      wilson: { lower: 0.39, center: 0.6, upper: 0.78 },
      flakeScore: 0.39,
    },
    {
      id: 'reliable',
      state: 'reliable',
      runs: 10,
      passes: 10,
      failures: 0,
      failureRate: 0,
      wilson: { lower: 0, center: 0, upper: 0.3 },
      flakeScore: 0,
    },
    {
      id: 'broken',
      state: 'broken',
      runs: 10,
      passes: 0,
      failures: 10,
      failureRate: 1,
      wilson: { lower: 0.7, center: 1, upper: 1 },
      flakeScore: 0.7,
    },
  ]

  it('selects flaky verdicts above the score floor, highest first; never broken/reliable', () => {
    const c = quarantineCandidates(verdicts, { minFlakeScore: 0.1 })
    expect(c.map((v) => v.id)).toEqual(['high'])
  })

  it('returns all flaky tests sorted by flakeScore desc when no floor given', () => {
    const c = quarantineCandidates(verdicts)
    expect(c.map((v) => v.id)).toEqual(['high', 'low'])
  })
})
