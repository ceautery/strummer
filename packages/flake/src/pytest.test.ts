import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type PytestJsonReport, parsePytestJson } from './pytest.js'
import { HistoryStore } from './store.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function loadReport(): PytestJsonReport {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, 'pytest-report.json'), 'utf8'),
  ) as PytestJsonReport
}

describe('parsePytestJson', () => {
  it('extracts a recorded run per pass/fail test, keyed by the stable nodeid', () => {
    const runs = parsePytestJson(loadReport(), { at: '2026-06-01T00:00:00Z' })
    expect(runs).toEqual([
      {
        testId: 'tests/test_runner.py::test_retries_then_succeeds',
        passed: true,
        at: '2026-06-01T00:00:00Z',
        durationMs: 12.5,
      },
      {
        testId: 'tests/test_runner.py::TestPinning::test_pins_resolved_ip',
        passed: false,
        at: '2026-06-01T00:00:00Z',
        durationMs: 8,
      },
      {
        // An errored test (e.g. a flaky fixture/setup) did not pass — a real flake signal.
        testId: 'tests/test_db.py::test_opens_golden_index',
        passed: false,
        at: '2026-06-01T00:00:00Z',
        durationMs: 2,
      },
    ])
  })

  it('drops skipped and xfailed/xpassed outcomes (no pass/fail flake signal)', () => {
    const runs = parsePytestJson(loadReport(), { at: '2026-06-01T00:00:00Z' })
    expect(runs.some((r) => r.testId.includes('rejects_foreign_schema'))).toBe(false)
    expect(runs.some((r) => r.testId.includes('known_xfail'))).toBe(false)
  })

  it('uses the pytest nodeid verbatim — no reconstruction (already file-qualified + stable)', () => {
    const runs = parsePytestJson(
      { tests: [{ nodeid: 'a/b/test_x.py::TestC::test_y', outcome: 'passed' }] },
      { at: '2026-06-01T00:00:00Z' },
    )
    expect(runs[0]?.testId).toBe('a/b/test_x.py::TestC::test_y')
  })

  it('relativizes only an absolute nodeid file part against projectRoot (preserving ::)', () => {
    const runs = parsePytestJson(
      { tests: [{ nodeid: '/abs/workspace/py/tests/test_x.py::test_y', outcome: 'failed' }] },
      { at: '2026-06-01T00:00:00Z', projectRoot: '/abs/workspace/py' },
    )
    expect(runs[0]?.testId).toBe('tests/test_x.py::test_y')
  })

  it('omits durationMs when no phase carries a duration', () => {
    const runs = parsePytestJson(
      { tests: [{ nodeid: 't.py::a', outcome: 'passed' }] },
      { at: '2026-06-01T00:00:00Z' },
    )
    expect(runs[0]).toEqual({ testId: 't.py::a', passed: true, at: '2026-06-01T00:00:00Z' })
  })

  it('stamps a runGroup when supplied', () => {
    const runs = parsePytestJson(loadReport(), { at: '2026-06-01T00:00:00Z', runGroup: 'ci-42' })
    expect(runs.every((r) => r.runGroup === 'ci-42')).toBe(true)
  })

  it('tolerates an empty/degenerate report', () => {
    expect(parsePytestJson({}, { at: 'x' })).toEqual([])
    expect(parsePytestJson({ tests: [] }, { at: 'x' })).toEqual([])
  })
})

describe('HistoryStore.ingestPytestReport', () => {
  it('records every pass/fail/error run and feeds the classifier across repeated ingests', () => {
    const store = HistoryStore.memory()
    try {
      const n1 = store.ingestPytestReport(loadReport(), { at: '2026-06-01T00:00:00Z' })
      expect(n1).toBe(3) // skipped + xfailed excluded; error counted
      store.ingestPytestReport(loadReport(), { at: '2026-06-02T00:00:00Z' })

      const failing = store.history('tests/test_runner.py::TestPinning::test_pins_resolved_ip')
      expect(failing.runs.map((r) => r.passed)).toEqual([false, false])

      const byId = Object.fromEntries(store.classify().map((v) => [v.id, v]))
      // 2 failures / 2 runs → all-fail but below minRuns(5) → insufficient-data.
      expect(byId[failing.id]?.failures).toBe(2)
      expect(byId[failing.id]?.state).toBe('insufficient-data')
    } finally {
      store.close()
    }
  })
})
