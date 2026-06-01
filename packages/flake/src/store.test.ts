import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore } from './store.js'

describe('HistoryStore', () => {
  let store: HistoryStore

  beforeEach(() => {
    store = HistoryStore.memory()
  })
  afterEach(() => {
    store.close()
  })

  it('records a single run and reads it back as a history', () => {
    store.recordRun({ testId: 'a > b', passed: true, at: '2026-06-01T00:00:00Z' })
    const h = store.history('a > b')
    expect(h).toEqual({ id: 'a > b', runs: [{ passed: true, at: '2026-06-01T00:00:00Z' }] })
  })

  it('returns an empty history for an unknown test', () => {
    expect(store.history('nope')).toEqual({ id: 'nope', runs: [] })
  })

  it('records many runs in one transaction and orders them chronologically', () => {
    store.recordRuns([
      { testId: 't', passed: true, at: '2026-06-03T00:00:00Z' },
      { testId: 't', passed: false, at: '2026-06-01T00:00:00Z' },
      { testId: 't', passed: true, at: '2026-06-02T00:00:00Z' },
    ])
    expect(store.history('t').runs.map((r) => r.at)).toEqual([
      '2026-06-01T00:00:00Z',
      '2026-06-02T00:00:00Z',
      '2026-06-03T00:00:00Z',
    ])
  })

  it('groups histories per test, sorted by test id', () => {
    store.recordRuns([
      { testId: 'z', passed: true, at: '2026-06-01T00:00:00Z' },
      { testId: 'a', passed: false, at: '2026-06-01T00:00:00Z' },
      { testId: 'a', passed: true, at: '2026-06-02T00:00:00Z' },
    ])
    const hs = store.histories()
    expect(hs.map((h) => h.id)).toEqual(['a', 'z'])
    expect(hs[0]?.runs).toHaveLength(2)
  })

  it('keeps only the most recent N runs per test with limitPerTest', () => {
    store.recordRuns(
      Array.from({ length: 5 }, (_, i) => ({
        testId: 't',
        passed: i % 2 === 0,
        at: `2026-06-0${i + 1}T00:00:00Z`,
      })),
    )
    const h = store.history('t', { limitPerTest: 2 })
    expect(h.runs.map((r) => r.at)).toEqual(['2026-06-04T00:00:00Z', '2026-06-05T00:00:00Z'])
  })

  it('filters by since', () => {
    store.recordRuns([
      { testId: 't', passed: true, at: '2026-06-01T00:00:00Z' },
      { testId: 't', passed: false, at: '2026-06-05T00:00:00Z' },
    ])
    expect(store.history('t', { since: '2026-06-03T00:00:00Z' }).runs).toEqual([
      { passed: false, at: '2026-06-05T00:00:00Z' },
    ])
  })

  it('classifies straight from the store', () => {
    store.recordRuns([
      ...Array.from({ length: 6 }, (_, i) => ({
        testId: 'reliable',
        passed: true,
        at: `2026-06-0${i + 1}T00:00:00Z`,
      })),
      { testId: 'flaky', passed: true, at: '2026-06-01T00:00:00Z' },
      { testId: 'flaky', passed: false, at: '2026-06-02T00:00:00Z' },
    ])
    const verdicts = store.classify()
    const byId = Object.fromEntries(verdicts.map((v) => [v.id, v.state]))
    expect(byId.reliable).toBe('reliable')
    expect(byId.flaky).toBe('flaky')
  })

  it('defaults `at` to the current time when omitted', () => {
    store.recordRun({ testId: 't', passed: true })
    const at = store.history('t').runs[0]?.at
    expect(at).toBeDefined()
    expect(Number.isNaN(Date.parse(at as string))).toBe(false)
  })

  it('persists across reopen of a file-backed store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-flake-'))
    const path = join(dir, 'history.db')
    try {
      const a = HistoryStore.open(path)
      a.recordRun({ testId: 't', passed: false, at: '2026-06-01T00:00:00Z' })
      a.close()
      const b = HistoryStore.open(path)
      expect(b.history('t').runs).toEqual([{ passed: false, at: '2026-06-01T00:00:00Z' }])
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
