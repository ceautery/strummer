/**
 * The gated vitest runner — the live half of the flake pillar. It **spawns**
 * `vitest run --reporter=json` (per ADR 0010: flake's execution model is spawn-and-parse,
 * distinct from coverage's child-process coverage run and mutation's Stryker delegation),
 * reads the JSON report, and records every outcome into the {@link HistoryStore}. Run the
 * suite `repeat` times to actually surface flakiness, then classify.
 *
 * Two ADR-0010 constraints, mirroring `@strummer/coverage`'s `runScoped`:
 * 1. **It runs code**, so it is behind a *paired* deny-by-default operator gate — an
 *    `allowRun` boolean AND an `allowedRoots` allowlist (load-bearing on its own), with a
 *    wall-clock cap. All operator-set; no caller input self-authorizes.
 * 2. **Child-process boundary.** The real `vitest` invocation is an injected
 *    {@link TestRunner} (the bin wires a subprocess); the engine owns the gate, argv,
 *    report-file plumbing, ingestion, and classification, and is unit-tested with a fake
 *    runner — no real spawn in the green gate.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FlakeVerdict } from './classify.js'
import type { VitestJsonReport } from './report.js'
import type { HistoryStore } from './store.js'

/** Thrown when the paired operator gate denies a run. */
export class FlakeGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlakeGateError'
  }
}

export interface RunHistoryConfig {
  /** The project to run tests in. */
  projectRoot: string
  /** OPERATOR allowlist of roots the runner may execute in. Load-bearing even with allowRun. */
  allowedRoots: string[]
  /** OPERATOR opt-in to actually run tests. Deny-by-default. */
  allowRun: boolean
  /** Wall-clock cap (ms) per iteration, passed to the runner. */
  timeoutMs?: number
}

export interface RunAndRecordInput {
  /** How many times to run the suite — flakiness needs repeats. Default 1. */
  repeat?: number
  /** Positional vitest file filters; default runs the whole suite. */
  files?: string[]
  /** Batch id; each iteration is recorded under `${runGroup}#<i>`. */
  runGroup?: string
}

/** Injected command runner — executes `vitest <argv>` and yields its exit status. */
export type TestRunner = (
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

export interface RunAndRecordResult {
  /** False only when repeat <= 0 (the runner was never invoked). */
  ran: boolean
  iterations: number
  /** Total runs recorded across all iterations. */
  recorded: number
  results: { exitCode: number; passed: boolean }[]
  /** Classifier verdicts over the store AFTER recording this batch. */
  verdicts: FlakeVerdict[]
}

/** Build the argv for one suite run with the JSON reporter writing to `outFile`. */
function runArgv(files: string[], outFile: string): string[] {
  return ['run', ...files, '--reporter=json', `--outputFile=${outFile}`]
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

function assertAllowed(config: RunHistoryConfig): void {
  if (!config.allowRun) {
    throw new FlakeGateError('test execution is not enabled (the operator must set allowRun)')
  }
  const root = resolve(config.projectRoot)
  const allowed = config.allowedRoots.map((r) => resolve(r))
  if (!allowed.includes(root)) {
    throw new FlakeGateError(`project root ${config.projectRoot} is not in the operator allowlist`)
  }
}

/**
 * Run the suite `repeat` times behind the operator gate, recording every outcome into the
 * store, then classify. The actual `vitest` invocation is the injected `runner` (default
 * {@link defaultVitestRunner}).
 */
export async function runAndRecord(
  store: HistoryStore,
  config: RunHistoryConfig,
  input: RunAndRecordInput,
  deps: { runner?: TestRunner; reportDir?: string } = {},
): Promise<RunAndRecordResult> {
  assertAllowed(config)

  const repeat = input.repeat ?? 1
  if (repeat <= 0) {
    return { ran: false, iterations: 0, recorded: 0, results: [], verdicts: store.classify() }
  }

  const runner = deps.runner ?? defaultVitestRunner
  const reportDir = deps.reportDir ?? mkdtempSync(join(tmpdir(), 'strummer-flake-'))
  const files = input.files ?? []
  const results: { exitCode: number; passed: boolean }[] = []
  let recorded = 0

  for (let i = 0; i < repeat; i++) {
    const outFile = join(reportDir, `report-${i}.json`)
    const { exitCode } = await runner(runArgv(files, outFile), {
      cwd: config.projectRoot,
      timeoutMs: config.timeoutMs,
    })
    let report: VitestJsonReport
    try {
      report = JSON.parse(readFileSync(outFile, 'utf8')) as VitestJsonReport
    } catch {
      throw new Error(
        `flake run did not produce a JSON report at ${outFile} (exit code ${exitCode})`,
      )
    }
    recorded += store.ingestReport(report, {
      at: new Date().toISOString(),
      projectRoot: config.projectRoot,
      runGroup: input.runGroup !== undefined ? `${input.runGroup}#${i}` : undefined,
    })
    results.push({ exitCode, passed: exitCode === 0 })
  }

  return { ran: true, iterations: repeat, recorded, results, verdicts: store.classify() }
}
