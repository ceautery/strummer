/**
 * Impact-scoped test runner — the live half of the coverage pillar. Runs ONLY the tests
 * a change touches (via `vitest related <changed files>`) with coverage, then feeds the
 * produced `coverage-final.json` into {@link uncoveredInDiff} to surface the new lines a
 * change introduced that no test exercised.
 *
 * Two ADR-0010 constraints shape this:
 *
 * 1. **It runs code**, so it is behind a *paired* deny-by-default operator gate — an
 *    `allowRun` boolean AND an `allowedRoots` allowlist, with a wall-clock cap. Both are
 *    operator-set (the bin reads `STRUMMER_COVERAGE_ALLOW_RUN` / `_PROJECT_ROOTS` /
 *    `_TIMEOUT_MS`); no caller input can self-authorize a run.
 * 2. **Child-process boundary.** The repo has a single root `vitest.config.ts`, so the
 *    in-process `startVitest` API can't be used from inside the outer Vitest worker
 *    (reentrancy). The actual run is therefore an injected {@link TestRunner} that the
 *    bin wires to a `vitest` *subprocess*; the engine here owns the gate, argv, coverage
 *    collection, and diff wiring, and is unit-tested with a fake runner (no real spawn in
 *    the green gate).
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type DiffCoverageReport, uncoveredInDiff } from './report.js'
import type { FileCoverage } from './uncovered.js'

/** Thrown when the paired operator gate denies a run. */
export class CoverageGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CoverageGateError'
    // Brand as a gate DENIAL (ADR 0013 Addendum, milestone 5c): the run-driving
    // `@strummer/verify` reads this global-registry symbol via `isGateDenial` to map a
    // denial to `skipReason:'gate-not-set'` (never `errored`) WITHOUT importing engine
    // code. The `Symbol.for` key string is the cross-package contract.
    ;(this as unknown as Record<symbol, unknown>)[Symbol.for('strummer.gate-denial')] = true
  }
}

export interface RunScopedConfig {
  /** The project to run tests in. */
  projectRoot: string
  /** OPERATOR allowlist of roots `runScoped` may execute in. Load-bearing even with allowRun. */
  allowedRoots: string[]
  /** OPERATOR opt-in to actually run tests. Deny-by-default. */
  allowRun: boolean
  /** Wall-clock cap (ms) passed to the runner. */
  timeoutMs?: number
}

export interface ScopedRunInput {
  /** Changed source files to scope the test selection to (`vitest related`). */
  changedFiles: string[]
  /** Optional unified diff; when present the result includes the {@link uncoveredInDiff} report. */
  diff?: string
}

/** Injected command runner — executes `vitest <argv>` and yields its exit status. */
export type TestRunner = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export interface ScopedRunResult {
  /** False when there were no changed files (the runner was not invoked). */
  ran: boolean
  exitCode: number
  passed: boolean
  scopedFiles: string[]
  coverage: Record<string, FileCoverage>
  coveragePath?: string
  /** Present when a diff was supplied. */
  report?: DiffCoverageReport
}

/** Build the `vitest related` argv: run once, scoped to the changed files, with v8 JSON coverage. */
function scopedArgv(changedFiles: string[], coverageDir: string): string[] {
  return [
    'related',
    ...changedFiles,
    '--run',
    '--coverage.enabled=true',
    '--coverage.provider=v8',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${coverageDir}`,
  ]
}

/** Default live runner: spawn the local `vitest` as a subprocess (used by the bin, not the gate). */
export const defaultVitestRunner: TestRunner = (argv, opts) =>
  new Promise((res) => {
    execFile(
      'vitest',
      argv,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // vitest exits non-zero on test failure — surface the code, don't reject.
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        res({ exitCode: code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

function assertAllowed(config: RunScopedConfig): void {
  if (!config.allowRun) {
    throw new CoverageGateError(
      'scoped test execution is not enabled (the operator must set allowRun)',
    )
  }
  const root = resolve(config.projectRoot)
  const allowed = config.allowedRoots.map((r) => resolve(r))
  if (!allowed.includes(root)) {
    throw new CoverageGateError(
      `project root ${config.projectRoot} is not in the operator allowlist`,
    )
  }
}

/**
 * Run the tests related to a change, with coverage, behind the operator gate. Returns the
 * collected coverage (and, when a diff is supplied, the uncovered-new-line report). The
 * actual `vitest` invocation is the injected `runner` (default {@link defaultVitestRunner}).
 */
export async function runScoped(
  config: RunScopedConfig,
  input: ScopedRunInput,
  deps: { runner?: TestRunner; coverageDir?: string } = {},
): Promise<ScopedRunResult> {
  assertAllowed(config)

  if (input.changedFiles.length === 0) {
    return { ran: false, exitCode: 0, passed: true, scopedFiles: [], coverage: {} }
  }

  const runner = deps.runner ?? defaultVitestRunner
  const coverageDir = deps.coverageDir ?? mkdtempSync(join(tmpdir(), 'strummer-cov-'))
  const argv = scopedArgv(input.changedFiles, coverageDir)

  const { exitCode } = await runner(argv, { cwd: config.projectRoot, timeoutMs: config.timeoutMs })

  const coveragePath = join(coverageDir, 'coverage-final.json')
  let coverage: Record<string, FileCoverage>
  try {
    coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as Record<string, FileCoverage>
  } catch {
    throw new Error(
      `scoped run did not produce a coverage report at ${coveragePath} (exit code ${exitCode})`,
    )
  }

  const report =
    input.diff !== undefined
      ? uncoveredInDiff(input.diff, coverage, { projectRoot: config.projectRoot })
      : undefined

  return {
    ran: true,
    exitCode,
    passed: exitCode === 0,
    scopedFiles: input.changedFiles,
    coverage,
    coveragePath,
    report,
  }
}
