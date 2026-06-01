import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseVitestJson, type VitestJsonReport } from './report.js'
import { HistoryStore } from './store.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function loadReport(): VitestJsonReport {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, 'vitest-report.json'), 'utf8'),
  ) as VitestJsonReport
}

describe('parseVitestJson', () => {
  it('extracts a recorded run per pass/fail assertion with a file-qualified id', () => {
    const runs = parseVitestJson(loadReport(), { at: '2026-06-01T00:00:00Z' })
    expect(runs).toEqual([
      {
        testId:
          '/abs/workspace/packages/api/src/runner.test.ts > runner > retries > a 503 then succeeds',
        passed: true,
        at: '2026-06-01T00:00:00Z',
        durationMs: 12.5,
      },
      {
        testId: '/abs/workspace/packages/api/src/runner.test.ts > runner > pins the resolved IP',
        passed: false,
        at: '2026-06-01T00:00:00Z',
        durationMs: 8.0,
      },
      {
        testId: '/abs/workspace/packages/core/src/db.test.ts > openDb > opens the golden index',
        passed: true,
        at: '2026-06-01T00:00:00Z',
        durationMs: 3.2,
      },
    ])
  })

  it('excludes skipped/pending/todo assertions (no pass/fail signal)', () => {
    const runs = parseVitestJson(loadReport(), { at: '2026-06-01T00:00:00Z' })
    expect(runs.some((r) => r.testId.includes('rejects a foreign schema'))).toBe(false)
  })

  it('relativizes file paths against projectRoot', () => {
    const runs = parseVitestJson(loadReport(), {
      at: '2026-06-01T00:00:00Z',
      projectRoot: '/abs/workspace',
    })
    expect(runs[0]?.testId).toBe(
      'packages/api/src/runner.test.ts > runner > retries > a 503 then succeeds',
    )
  })

  it('stamps a runGroup when supplied', () => {
    const runs = parseVitestJson(loadReport(), { at: '2026-06-01T00:00:00Z', runGroup: 'ci-42' })
    expect(runs.every((r) => r.runGroup === 'ci-42')).toBe(true)
  })

  it('falls back to fullName, then title, when ancestorTitles is absent', () => {
    const runs = parseVitestJson(
      {
        testResults: [
          {
            name: 'f.test.ts',
            assertionResults: [
              { fullName: 'full name here', status: 'passed' },
              { title: 'only a title', status: 'failed' },
            ],
          },
        ],
      },
      { at: '2026-06-01T00:00:00Z' },
    )
    expect(runs.map((r) => r.testId)).toEqual([
      'f.test.ts > full name here',
      'f.test.ts > only a title',
    ])
  })

  it('tolerates an empty/degenerate report', () => {
    expect(parseVitestJson({}, { at: 'x' })).toEqual([])
    expect(parseVitestJson({ testResults: [] }, { at: 'x' })).toEqual([])
  })
})

describe('HistoryStore.ingestReport', () => {
  it('records every parsed run and feeds the classifier across repeated ingests', () => {
    const store = HistoryStore.memory()
    try {
      // Ingest the same report twice with different timestamps + a third all-pass run,
      // so the failing test has a mixed history.
      const n1 = store.ingestReport(loadReport(), { at: '2026-06-01T00:00:00Z' })
      expect(n1).toBe(3) // skipped excluded
      store.ingestReport(loadReport(), { at: '2026-06-02T00:00:00Z' })

      const flaky = store.history(
        '/abs/workspace/packages/api/src/runner.test.ts > runner > pins the resolved IP',
      )
      expect(flaky.runs.map((r) => r.passed)).toEqual([false, false])

      const verdicts = store.classify()
      const byId = Object.fromEntries(verdicts.map((v) => [v.id, v]))
      // 2 failures / 2 runs → all-fail but below minRuns(5) → insufficient-data.
      expect(byId[flaky.id]?.failures).toBe(2)
      expect(byId[flaky.id]?.state).toBe('insufficient-data')
    } finally {
      store.close()
    }
  })
})
