/**
 * The private run-history store — `@sackville-mcp/flake`'s own SQLite database.
 *
 * Per ADR 0010 this is a **second SQLite owner**, deliberately OUTSIDE the docs-pillar
 * "only `@sackville-mcp/core` touches SQLite" invariant: it is a new, private store for test
 * run outcomes, not a crossing of the Python↔TS polyglot contract (which remains the
 * `schema/sackville.schema.sql` index that `core` reads). It records each test's pass/fail
 * history over time and reads it back as the `TestHistory[]` the pure classifier consumes.
 *
 * The schema is intentionally tiny: one append-only `test_run` row per recorded outcome,
 * plus a `flake_meta` version marker. Quarantine state is a separate table added by the
 * quarantine slice.
 */

import Database from 'better-sqlite3'
import {
  type ClassifyOptions,
  classifyHistories,
  type FlakeVerdict,
  type TestHistory,
  type TestRun,
} from './classify.js'
import { type PytestJsonReport, parsePytestJson } from './pytest.js'
import { type ParseReportOptions, parseVitestJson, type VitestJsonReport } from './report.js'

const SCHEMA_VERSION = 1

/** A test outcome to record. */
export interface RecordedRun {
  testId: string
  passed: boolean
  /** ISO timestamp; defaults to now. */
  at?: string
  /** Optional wall-clock duration of the run. */
  durationMs?: number
  /** Optional id grouping all tests from one suite execution (a CI run / batch). */
  runGroup?: string
}

export interface HistoryQueryOptions {
  /** Keep only the most recent N runs per test (chronological tail). */
  limitPerTest?: number
  /** Only include runs at/after this ISO timestamp. */
  since?: string
}

interface RunRow {
  test_id: string
  passed: number
  at: string
}

function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS flake_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS test_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id TEXT NOT NULL,
      passed INTEGER NOT NULL,
      at TEXT NOT NULL,
      duration_ms REAL,
      run_group TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_test_run_test_id_at ON test_run(test_id, at, id);
  `)
  const row = db.prepare('SELECT value FROM flake_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined
  if (!row) {
    db.prepare('INSERT INTO flake_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    )
  }
}

export class HistoryStore {
  private readonly db: Database.Database
  private readonly insert: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    migrate(db)
    this.insert = db.prepare(
      'INSERT INTO test_run (test_id, passed, at, duration_ms, run_group) VALUES (?, ?, ?, ?, ?)',
    )
  }

  /** Open (creating if needed) a file-backed history store and run migrations. */
  static open(path: string): HistoryStore {
    return new HistoryStore(new Database(path))
  }

  /** An in-memory store (tests, ephemeral analysis). */
  static memory(): HistoryStore {
    return new HistoryStore(new Database(':memory:'))
  }

  /** The underlying database — shared with sibling tables (e.g. quarantine). */
  get database(): Database.Database {
    return this.db
  }

  recordRun(run: RecordedRun): void {
    this.insert.run(
      run.testId,
      run.passed ? 1 : 0,
      run.at ?? new Date().toISOString(),
      run.durationMs ?? null,
      run.runGroup ?? null,
    )
  }

  /** Record many runs in a single transaction. */
  recordRuns(runs: RecordedRun[]): void {
    const tx = this.db.transaction((batch: RecordedRun[]) => {
      for (const r of batch) this.recordRun(r)
    })
    tx(runs)
  }

  private rows(opts: HistoryQueryOptions): RunRow[] {
    const params: string[] = []
    let sql = 'SELECT test_id, passed, at FROM test_run'
    if (opts.since !== undefined) {
      sql += ' WHERE at >= ?'
      params.push(opts.since)
    }
    sql += ' ORDER BY test_id, at, id'
    return this.db.prepare(sql).all(...params) as RunRow[]
  }

  private static toRun(r: RunRow): TestRun {
    return { passed: r.passed !== 0, at: r.at }
  }

  /** All histories, grouped per test and sorted by test id. */
  histories(opts: HistoryQueryOptions = {}): TestHistory[] {
    const map = new Map<string, TestRun[]>()
    for (const r of this.rows(opts)) {
      const list = map.get(r.test_id) ?? []
      list.push(HistoryStore.toRun(r))
      map.set(r.test_id, list)
    }
    const limit = opts.limitPerTest
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, runs]) => ({ id, runs: limit !== undefined ? runs.slice(-limit) : runs }))
  }

  /** One test's history (empty `runs` when never recorded). */
  history(testId: string, opts: HistoryQueryOptions = {}): TestHistory {
    const params: string[] = [testId]
    let sql = 'SELECT test_id, passed, at FROM test_run WHERE test_id = ?'
    if (opts.since !== undefined) {
      sql += ' AND at >= ?'
      params.push(opts.since)
    }
    sql += ' ORDER BY at, id'
    let runs = (this.db.prepare(sql).all(...params) as RunRow[]).map(HistoryStore.toRun)
    if (opts.limitPerTest !== undefined) runs = runs.slice(-opts.limitPerTest)
    return { id: testId, runs }
  }

  /**
   * Parse a vitest json report and record every pass/fail assertion as a run. Returns the
   * number of runs recorded (skipped/pending/todo assertions are not counted).
   */
  ingestReport(report: VitestJsonReport, opts: ParseReportOptions): number {
    const runs = parseVitestJson(report, opts)
    this.recordRuns(runs)
    return runs.length
  }

  /**
   * Parse a pytest-json-report report and record every pass/fail/error test as a run. Returns
   * the number of runs recorded (skipped/xfailed/xpassed tests are not counted). The Python
   * sibling of {@link ingestReport}.
   */
  ingestPytestReport(report: PytestJsonReport, opts: ParseReportOptions): number {
    const runs = parsePytestJson(report, opts)
    this.recordRuns(runs)
    return runs.length
  }

  /** Classify every test's history straight from the store. */
  classify(opts: ClassifyOptions & HistoryQueryOptions = {}): FlakeVerdict[] {
    return classifyHistories(this.histories(opts), opts)
  }

  close(): void {
    this.db.close()
  }
}
