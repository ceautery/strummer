import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  classifyHistories,
  classifyHistory,
  type FlakeVerdict,
  type TestHistory,
  wilsonInterval,
} from './classify.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

interface RunHistoryFixture {
  tests: TestHistory[]
}

function loadFixture(): TestHistory[] {
  const raw = readFileSync(resolve(FIXTURES, 'run-history.json'), 'utf8')
  return (JSON.parse(raw) as RunHistoryFixture).tests
}

function byId(verdicts: FlakeVerdict[], id: string): FlakeVerdict {
  const v = verdicts.find((x) => x.id === id)
  if (!v) throw new Error(`no verdict for ${id}`)
  return v
}

describe('wilsonInterval', () => {
  it('matches the hand-computed 95% interval for 2 failures in 10 runs', () => {
    const { lower, center, upper } = wilsonInterval(2, 10)
    // p=0.2, n=10, z=1.96 → center 0.28326, margin 0.22658
    expect(center).toBeCloseTo(0.28326, 4)
    expect(lower).toBeCloseTo(0.05668, 4)
    expect(upper).toBeCloseTo(0.50984, 4)
  })

  it('clamps the bounds to [0, 1] for an all-failure history', () => {
    const { lower, upper } = wilsonInterval(5, 5)
    expect(lower).toBeGreaterThan(0)
    expect(lower).toBeLessThan(1)
    expect(upper).toBe(1)
  })

  it('clamps the lower bound at 0 for an all-pass history', () => {
    const { lower, upper } = wilsonInterval(0, 6)
    expect(lower).toBe(0)
    expect(upper).toBeGreaterThan(0)
    expect(upper).toBeLessThan(1)
  })

  it('honours a wider z (more confidence → wider interval)', () => {
    const narrow = wilsonInterval(2, 10, 1.96)
    const wide = wilsonInterval(2, 10, 2.576)
    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower)
  })

  it('returns a degenerate zero interval for zero runs', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, center: 0, upper: 0 })
  })
})

describe('classifyHistory', () => {
  it('calls a mixed pass/fail history flaky with the observed failure rate', () => {
    const v = classifyHistory({
      id: 't',
      runs: [
        { passed: true },
        { passed: false },
        { passed: true },
        { passed: true },
        { passed: false },
        { passed: true },
        { passed: true },
        { passed: false },
        { passed: true },
        { passed: true },
      ],
    })
    expect(v.state).toBe('flaky')
    expect(v.runs).toBe(10)
    expect(v.passes).toBe(7)
    expect(v.failures).toBe(3)
    expect(v.failureRate).toBeCloseTo(0.3, 6)
    // flakeScore is the conservative (Wilson lower-bound) flakiness magnitude.
    expect(v.flakeScore).toBeCloseTo(v.wilson.lower, 10)
    expect(v.flakeScore).toBeGreaterThan(0)
  })

  it('is flaky on a single mixed observation regardless of run count', () => {
    const v = classifyHistory({ id: 't', runs: [{ passed: true }, { passed: false }] })
    expect(v.state).toBe('flaky')
  })

  it('calls an all-pass history reliable once it clears minRuns', () => {
    const runs = Array.from({ length: 6 }, () => ({ passed: true }))
    const v = classifyHistory({ id: 't', runs })
    expect(v.state).toBe('reliable')
    expect(v.failureRate).toBe(0)
    expect(v.flakeScore).toBe(0)
  })

  it('calls an all-fail history broken once it clears minRuns', () => {
    const runs = Array.from({ length: 5 }, () => ({ passed: false }))
    const v = classifyHistory({ id: 't', runs })
    expect(v.state).toBe('broken')
    expect(v.failureRate).toBe(1)
  })

  it('withholds a reliable/broken verdict below minRuns (insufficient-data)', () => {
    expect(classifyHistory({ id: 't', runs: [{ passed: true }, { passed: true }] }).state).toBe(
      'insufficient-data',
    )
    expect(classifyHistory({ id: 't', runs: [{ passed: false }] }).state).toBe('insufficient-data')
  })

  it('treats an empty history as insufficient-data with a zero interval', () => {
    const v = classifyHistory({ id: 't', runs: [] })
    expect(v.state).toBe('insufficient-data')
    expect(v.runs).toBe(0)
    expect(v.failureRate).toBe(0)
    expect(v.wilson).toEqual({ lower: 0, center: 0, upper: 0 })
  })

  it('respects a custom minRuns threshold', () => {
    const runs = Array.from({ length: 3 }, () => ({ passed: true }))
    expect(classifyHistory({ id: 't', runs }, { minRuns: 3 }).state).toBe('reliable')
    expect(classifyHistory({ id: 't', runs }, { minRuns: 4 }).state).toBe('insufficient-data')
  })
})

describe('classifyHistories over the committed fixture', () => {
  const verdicts = classifyHistories(loadFixture())

  it('classifies every fixture test by its history shape', () => {
    expect(
      byId(verdicts, 'packages/api/src/runner.test.ts > retries a 503 then succeeds').state,
    ).toBe('flaky')
    expect(byId(verdicts, 'packages/core/src/db.test.ts > opens the golden index').state).toBe(
      'reliable',
    )
    expect(
      byId(verdicts, 'packages/browser/src/proxy.test.ts > refuses a rebinding host').state,
    ).toBe('broken')
    expect(
      byId(verdicts, 'packages/deps/src/audit.test.ts > brand new, only run twice').state,
    ).toBe('insufficient-data')
    expect(
      byId(verdicts, 'packages/coverage/src/run.test.ts > flaked once on first sighting').state,
    ).toBe('flaky')
    expect(byId(verdicts, 'packages/safety/src/redactor.test.ts > never been run').state).toBe(
      'insufficient-data',
    )
  })

  it('preserves input order and ignores the non-executable `at` field', () => {
    expect(verdicts.map((v) => v.id)).toEqual(loadFixture().map((t) => t.id))
  })
})
