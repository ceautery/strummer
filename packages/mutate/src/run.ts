/**
 * The gated, diff-scoped mutation run — the live half of `@strummer/mutate`. It **spawns**
 * Stryker (`stryker run`, an injected subprocess like flake's `vitest` and coverage's
 * `vitest related`), then reads the JSON report Stryker writes and feeds it to the pure
 * {@link summarizeMutation}.
 *
 * Per ADR 0010 (+ its 2026-06-01 spike update):
 * 1. **It runs code** — and a mutation run is *expensive* (the suite re-runs per mutant) —
 *    so it sits behind the house paired deny-by-default operator gate (`allowRun` +
 *    `allowedRoots` allowlist, load-bearing on its own, + a wall-clock cap). All
 *    operator-set; no caller input self-authorizes.
 * 2. **Stryker is NOT a dependency of this package.** A real mutation run is slow and
 *    non-deterministic, so it never runs in `pnpm gate`. The `stryker` invocation is the
 *    injected {@link MutationRunner} (the bin spawns the operator's local Stryker); the
 *    engine owns the gate, argv, report plumbing, and summary, and is unit-tested with a
 *    fake runner.
 * 3. **Diff-scoped.** `mutateFiles` (the changed source files) become Stryker's `--mutate`
 *    glob list, and `--incremental` reuses Stryker's cache — so a change mutates only what
 *    it touched, not the whole tree.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type MutationReport, type MutationSummary, summarizeMutation } from './summarize.js'

/** Thrown when the paired operator gate denies a run. */
export class MutateGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutateGateError'
    // Brand as a gate DENIAL (ADR 0013 Addendum, milestone 5c): the run-driving
    // `@strummer/verify` reads this global-registry symbol via `isGateDenial` to map a
    // denial to `skipReason:'gate-not-set'` (never `errored`) WITHOUT importing engine
    // code. The `Symbol.for` key string is the cross-package contract.
    ;(this as unknown as Record<symbol, unknown>)[Symbol.for('strummer.gate-denial')] = true
  }
}

export interface RunMutationConfig {
  /** The project to run Stryker in. */
  projectRoot: string
  /** OPERATOR allowlist of roots the runner may execute in. Load-bearing even with allowRun. */
  allowedRoots: string[]
  /** OPERATOR opt-in to actually run mutation testing. Deny-by-default. */
  allowRun: boolean
  /** Wall-clock cap (ms) passed to the runner. */
  timeoutMs?: number
}

export interface RunMutationInput {
  /** Changed source files to scope mutation to (Stryker `--mutate`). Empty ⇒ project default. */
  mutateFiles?: string[]
  /** Reuse Stryker's incremental cache (`--incremental`) — faster re-runs. */
  incremental?: boolean
}

/** Injected command runner — executes `stryker <argv>` and yields its exit status. */
export type MutationRunner = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export interface RunMutationResult {
  ran: boolean
  exitCode: number
  /** Files mutation was scoped to (empty ⇒ the project's configured set). */
  scopedFiles: string[]
  reportPath: string
  summary: MutationSummary
}

/** Stryker's default JSON-report location, relative to the project root. */
function defaultReportPath(projectRoot: string): string {
  return join(projectRoot, 'reports', 'mutation', 'mutation.json')
}

/** Build the `stryker run` argv: JSON reporter, optional diff scope + incremental cache. */
function runArgv(input: RunMutationInput): string[] {
  const argv = ['run', '--reporters', 'json']
  if (input.mutateFiles && input.mutateFiles.length > 0) {
    argv.push('--mutate', input.mutateFiles.join(','))
  }
  if (input.incremental) argv.push('--incremental')
  return argv
}

/** Default live runner: spawn the local `stryker` as a subprocess (used by the bin, not the gate). */
export const defaultStrykerRunner: MutationRunner = (argv, opts) =>
  new Promise((res) => {
    execFile(
      'stryker',
      argv,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
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

function assertAllowed(config: RunMutationConfig): void {
  if (!config.allowRun) {
    throw new MutateGateError('mutation runs are not enabled (the operator must set allowRun)')
  }
  const root = resolve(config.projectRoot)
  const allowed = config.allowedRoots.map((r) => resolve(r))
  if (!allowed.includes(root)) {
    throw new MutateGateError(`project root ${config.projectRoot} is not in the operator allowlist`)
  }
}

/**
 * Run mutation testing behind the operator gate and summarize the report. The actual
 * `stryker` invocation is the injected `runner` (default {@link defaultStrykerRunner}); the
 * JSON report is read from `deps.reportPath` (default: Stryker's
 * `<projectRoot>/reports/mutation/mutation.json`).
 */
export async function runMutation(
  config: RunMutationConfig,
  input: RunMutationInput,
  deps: { runner?: MutationRunner; reportPath?: string } = {},
): Promise<RunMutationResult> {
  assertAllowed(config)

  const runner = deps.runner ?? defaultStrykerRunner
  const reportPath = deps.reportPath ?? defaultReportPath(config.projectRoot)
  const argv = runArgv(input)

  const { exitCode } = await runner(argv, {
    cwd: config.projectRoot,
    timeoutMs: config.timeoutMs,
  })

  let report: MutationReport
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as MutationReport
  } catch {
    throw new Error(
      `mutation run did not produce a JSON report at ${reportPath} (exit code ${exitCode}); ` +
        'ensure the project enables the Stryker `json` reporter',
    )
  }

  return {
    ran: true,
    exitCode,
    scopedFiles: input.mutateFiles ?? [],
    reportPath,
    summary: summarizeMutation(report),
  }
}
