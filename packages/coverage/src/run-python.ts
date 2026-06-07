/**
 * Python impact-scoped coverage runner (ADR 0010 addendum) — the coverage.py sibling of
 * {@link runScoped}. Runs `pytest --cov=<target> --cov-report=json` scoped to the tests a change
 * touched, converts the report via the shipped {@link coveragePyToIstanbul} (unchanged), and feeds
 * {@link uncoveredInDiff} (unchanged) to surface the new lines no test exercised.
 *
 * Two coverage.py / pytest specifics drive the design:
 *
 * 1. **No `vitest related`.** pytest has no built-in changed-files test selection, so we derive a
 *    scope with {@link selectPytestScope}: a changed TEST file is a selector directly; a changed
 *    SOURCE file maps to a mirrored test (`test_<x>.py` / `tests/test_<x>.py`) when one exists. When
 *    a changed source maps to NO confident test, the ratified fallback is operator-visible:
 *    `report-gap` (default — run the matched tests, report the unmatched source as a coverage gap)
 *    or `widen` (run the whole suite). testmon is intentionally NOT used (a stale `.testmondata`
 *    silently deselects tests → false clean, violating absence-is-never-a-pass).
 *
 * 2. **pytest exit codes are not vitest's.** Exit 5 (no tests collected), 2/3/4 (usage/internal) are
 *    NOT a clean pass — they map to `inconclusive`, and the run never produces a (misleading) clean
 *    report. Only 0 (passed) / 1 (tests failed) carry a real result.
 *
 * The `pytest`/coverage.py invocation is the injected {@link TestRunner}; no real spawn in the gate.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type PytestScope, type ScopeMode, selectPytestScope } from '@sackville-mcp/pyscope'
import { type CoveragePyReport, coveragePyToIstanbul } from './coveragepy.js'
import { uncoveredInDiff } from './report.js'
import {
  assertAllowed,
  defaultPytestCovRunner,
  type RunScopedConfig,
  type ScopedRunInput,
  type ScopedRunResult,
  type TestRunner,
} from './run.js'
import type { FileCoverage } from './uncovered.js'

// The pytest "mirrored-test" scope heuristic now lives in the zero-dep @sackville-mcp/pyscope leaf
// (shared with @sackville-mcp/flake). Re-export the public primitives so coverage's surface
// (src/index.ts) is unchanged.
export { type PytestScope, type ScopeMode, selectPytestScope }

export interface ScopedPythonInput extends ScopedRunInput {
  /** coverage.py measurement targets (`--cov=<target>`). Required — coverage.py needs explicit scope. */
  measureTargets: string[]
  /** Fallback when a changed source maps to no test. Default `report-gap`. */
  scopeMode?: ScopeMode
}

export interface ScopedPythonResult extends ScopedRunResult {
  /** pytest produced a non-test-result exit (no tests collected / usage / internal) ⇒ not a pass. */
  inconclusive?: boolean
  /** Changed source files with no confident mirrored test — the coverage gap (never a silent pass). */
  unmatched?: string[]
  /** True when the no-test fallback widened the run to the whole suite. */
  widened?: boolean
}

/** Build the `pytest --cov` argv with a JSON report at `jsonPath` and the selected test targets. */
function pytestArgv(measureTargets: string[], selectors: string[], jsonPath: string): string[] {
  return [...measureTargets.map((t) => `--cov=${t}`), `--cov-report=json:${jsonPath}`, ...selectors]
}

/** A pytest exit code that is NOT a test result (no tests collected / usage / internal). */
function isInconclusiveExit(exitCode: number): boolean {
  return exitCode === 2 || exitCode === 3 || exitCode === 4 || exitCode === 5
}

/**
 * Run the pytest tests related to a change, with coverage.py, behind the operator gate. Returns the
 * converted coverage (and, when a diff is supplied, the uncovered-new-line report). The actual
 * `pytest` invocation is the injected `runner` (default {@link defaultPytestCovRunner}).
 */
export async function runScopedPython(
  config: RunScopedConfig,
  input: ScopedPythonInput,
  deps: {
    runner?: TestRunner
    coverageDir?: string
    /** Existence check for mirrored tests (FS by default; injected in tests). */
    testExists?: (path: string) => boolean
  } = {},
): Promise<ScopedPythonResult> {
  assertAllowed(config)

  if (input.changedFiles.length === 0) {
    return { ran: false, exitCode: 0, passed: true, scopedFiles: [], coverage: {} }
  }

  const mode = input.scopeMode ?? 'report-gap'
  const testExists = deps.testExists ?? ((p: string) => existsSync(join(config.projectRoot, p)))
  const scope = selectPytestScope(input.changedFiles, mode, testExists)

  // Nothing Python to run (e.g. only non-.py files changed, and nothing widened): a no-op.
  if (scope.selectors.length === 0 && !scope.widened && scope.unmatched.length === 0) {
    return { ran: false, exitCode: 0, passed: true, scopedFiles: [], coverage: {} }
  }

  const runner = deps.runner ?? defaultPytestCovRunner
  const coverageDir = deps.coverageDir ?? mkdtempSync(join(tmpdir(), 'sackville-cov-py-'))
  const jsonPath = join(coverageDir, 'coverage.json')
  const argv = pytestArgv(input.measureTargets, scope.selectors, jsonPath)

  const { exitCode } = await runner(argv, { cwd: config.projectRoot, timeoutMs: config.timeoutMs })
  const inconclusive = isInconclusiveExit(exitCode)

  let coverage: Record<string, FileCoverage> = {}
  try {
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as CoveragePyReport
    coverage = coveragePyToIstanbul(report)
  } catch {
    // A genuine run (passed/failed) must produce a report; an inconclusive exit may not.
    if (!inconclusive) {
      throw new Error(
        `scoped pytest run did not produce a coverage report at ${jsonPath} (exit code ${exitCode})`,
      )
    }
  }

  // Never produce a (misleading) clean report from an inconclusive run.
  const report =
    input.diff !== undefined && !inconclusive && Object.keys(coverage).length > 0
      ? uncoveredInDiff(input.diff, coverage, { projectRoot: config.projectRoot })
      : undefined

  return {
    ran: true,
    exitCode,
    passed: exitCode === 0,
    inconclusive: inconclusive || undefined,
    scopedFiles: input.changedFiles,
    unmatched: scope.unmatched.length > 0 ? scope.unmatched : undefined,
    widened: scope.widened || undefined,
    coverage,
    coveragePath: jsonPath,
    report,
  }
}
