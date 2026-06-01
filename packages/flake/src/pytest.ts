/**
 * pytest-json-report ingestion — turns a `pytest --json-report` report into the
 * {@link RecordedRun}s the history store records. The Python sibling of {@link parseVitestJson}.
 *
 * The store / classifier / quarantine are all **test-id-opaque** (they operate on the
 * `testId` string + pass/fail only), so the Python adapter is purely this shape converter —
 * no change to the engine. Like the vitest parser this module is pure: no spawning, no I/O.
 *
 * Two things differ from the vitest report:
 *   - **Stable id:** pytest's `nodeid` (`tests/test_x.py::TestC::test_y`) is already
 *     file-qualified, rootdir-relative, and stable, so we use it **verbatim** — none of the
 *     `ancestorTitles + title` reconstruction the lossy vitest `fullName` forces.
 *   - **Durations are seconds, split across phases.** pytest-json-report records a per-phase
 *     `{setup, call, teardown}` duration in *seconds*; we sum the present phases and convert
 *     to milliseconds to match {@link RecordedRun.durationMs} (and istanbul/vitest's ms unit).
 *
 * Outcome mapping (mirrors the vitest "pass/fail-signal vs no-signal" split):
 *   - `passed`  → recorded as a pass.
 *   - `failed`  → recorded as a failure.
 *   - `error`   → recorded as a failure: an errored test (a flaky fixture / setup / teardown)
 *                 did not pass, and that nondeterminism is exactly what the flake pillar hunts.
 *   - `skipped` / `xfailed` / `xpassed` → dropped: no clean pass/fail flake signal (an
 *                 `xfailed` test behaved as declared; a strict `xpassed` surfaces as `failed`).
 */

import { isAbsolute, relative } from 'node:path'
import type { ParseReportOptions } from './report.js'
import type { RecordedRun } from './store.js'

/** One phase (setup/call/teardown) of a pytest test item; `duration` is in seconds. */
export interface PytestPhase {
  duration?: number | null
  outcome?: string
}

/** The subset of a pytest-json-report test item we read. */
export interface PytestTest {
  nodeid?: string
  outcome?: string
  setup?: PytestPhase
  call?: PytestPhase
  teardown?: PytestPhase
}

export interface PytestJsonReport {
  tests?: PytestTest[]
}

/** A status that carries a pass/fail signal; everything else returns undefined (dropped). */
function outcome(status: string | undefined): boolean | undefined {
  if (status === 'passed') return true
  if (status === 'failed' || status === 'error') return false
  return undefined
}

/** Sum the present phase durations (seconds) → milliseconds, or undefined when none exist. */
function durationMs(t: PytestTest): number | undefined {
  let seconds = 0
  let seen = false
  for (const phase of [t.setup, t.call, t.teardown]) {
    if (typeof phase?.duration === 'number') {
      seconds += phase.duration
      seen = true
    }
  }
  // Round to microsecond precision (in ms) to shed float-sum artifacts.
  return seen ? Math.round(seconds * 1_000_000) / 1000 : undefined
}

/**
 * Make a nodeid machine-stable. The nodeid is `<file>::<test path>`; pytest already emits
 * `<file>` rootdir-relative, so normally we pass it through. Only when a `projectRoot` is given
 * AND the file part is absolute do we relativize *just that part*, preserving the `::` structure
 * (a blind `relative()` over the whole string would mangle the `::`-delimited test path).
 */
function stableId(nodeid: string, projectRoot?: string): string {
  if (projectRoot === undefined) return nodeid
  const sep = nodeid.indexOf('::')
  const file = sep === -1 ? nodeid : nodeid.slice(0, sep)
  if (!isAbsolute(file)) return nodeid
  const rel = relative(projectRoot, file)
  return sep === -1 ? rel : rel + nodeid.slice(sep)
}

/**
 * Parse a pytest-json-report report into recorded runs — one per pass/fail/error test.
 * Skipped / xfailed / xpassed tests are dropped (no pass/fail signal). Pure: no spawning, no I/O.
 */
export function parsePytestJson(report: PytestJsonReport, opts: ParseReportOptions): RecordedRun[] {
  const runs: RecordedRun[] = []
  for (const t of report.tests ?? []) {
    const passed = outcome(t.outcome)
    if (passed === undefined) continue
    const run: RecordedRun = {
      testId: stableId(t.nodeid ?? '<unknown>', opts.projectRoot),
      passed,
      at: opts.at,
    }
    const ms = durationMs(t)
    if (ms !== undefined) run.durationMs = ms
    if (opts.runGroup !== undefined) run.runGroup = opts.runGroup
    runs.push(run)
  }
  return runs
}
