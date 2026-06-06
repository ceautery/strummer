/**
 * The gated vitest runner — the live half of the flake pillar. It **spawns**
 * `vitest run --reporter=json` (per ADR 0010: flake's execution model is spawn-and-parse,
 * distinct from coverage's child-process coverage run and mutation's Stryker delegation),
 * reads the JSON report, and records every outcome into the {@link HistoryStore}. Run the
 * suite `repeat` times to actually surface flakiness, then classify.
 *
 * Two ADR-0010 constraints, mirroring `@sackville-mcp/coverage`'s `runScoped`:
 * 1. **It runs code**, so it is behind a *paired* deny-by-default operator gate — an
 *    `allowRun` boolean AND an `allowedRoots` allowlist (load-bearing on its own), with a
 *    wall-clock cap. All operator-set; no caller input self-authorizes.
 * 2. **Child-process boundary.** The real `vitest` invocation is an injected
 *    {@link TestRunner} (the bin wires a subprocess); the engine owns the gate, argv,
 *    report-file plumbing, ingestion, and classification, and is unit-tested with a fake
 *    runner — no real spawn in the green gate.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type SpawnedRunner, spawnRunner } from '@sackville-mcp/spawn'
import type { FlakeVerdict } from './classify.js'
import type { PytestJsonReport } from './pytest.js'
import type { ParseReportOptions, VitestJsonReport } from './report.js'
import type { HistoryStore } from './store.js'

/** Thrown when the paired operator gate denies a run. */
export class FlakeGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlakeGateError'
    // Brand as a gate DENIAL (ADR 0013 Addendum, milestone 5c): the run-driving
    // `@sackville-mcp/verify` reads this global-registry symbol via `isGateDenial` to map a
    // denial to `skipReason:'gate-not-set'` (never `errored`) WITHOUT importing engine
    // code. The `Symbol.for` key string is the cross-package contract.
    ;(this as unknown as Record<symbol, unknown>)[Symbol.for('sackville.gate-denial')] = true
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
export type TestRunner = SpawnedRunner

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

/** Build the argv for one vitest suite run with the JSON reporter writing to `outFile`. */
function vitestArgv(files: string[], outFile: string): string[] {
  return ['run', ...files, '--reporter=json', `--outputFile=${outFile}`]
}

/**
 * Build the argv for one pytest run with the `pytest-json-report` plugin writing to `outFile`
 * (ADR 0010 addendum: json-report now, `pytest-reportlog` staged). No `run` subcommand — pytest
 * takes positional file filters directly. The plugin is an operator-installed dev dependency.
 */
function pytestArgv(files: string[], outFile: string): string[] {
  return ['--json-report', `--json-report-file=${outFile}`, ...files]
}

/** Default live runner: spawn the local `vitest` as a subprocess (used by the bin, not the gate). */
export const defaultVitestRunner: TestRunner = spawnRunner('vitest')

/** Default live runner: spawn the local `pytest` as a subprocess (used by the bin, not the gate). */
export const defaultPytestRunner: TestRunner = spawnRunner('pytest')

/**
 * A test framework's runner specifics: the default subprocess runner, how to build its argv with
 * a per-iteration report file, and how to ingest the parsed report into the store. Everything else
 * (gate, repeat loop, report-file plumbing, classification) is framework-agnostic.
 */
interface FrameworkAdapter {
  defaultRunner: TestRunner
  buildArgv(files: string[], outFile: string): string[]
  ingest(store: HistoryStore, parsed: unknown, opts: ParseReportOptions): number
}

const VITEST: FrameworkAdapter = {
  defaultRunner: defaultVitestRunner,
  buildArgv: vitestArgv,
  ingest: (store, parsed, opts) => store.ingestReport(parsed as VitestJsonReport, opts),
}

const PYTEST: FrameworkAdapter = {
  defaultRunner: defaultPytestRunner,
  buildArgv: pytestArgv,
  ingest: (store, parsed, opts) => store.ingestPytestReport(parsed as PytestJsonReport, opts),
}

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
 * Run a test suite `repeat` times behind the operator gate via the given {@link FrameworkAdapter},
 * recording every outcome into the store, then classify. The actual invocation is the injected
 * `runner` (default = the adapter's subprocess runner); no real spawn in the green gate.
 */
async function runAndRecordWith(
  fw: FrameworkAdapter,
  store: HistoryStore,
  config: RunHistoryConfig,
  input: RunAndRecordInput,
  deps: { runner?: TestRunner; reportDir?: string },
): Promise<RunAndRecordResult> {
  assertAllowed(config)

  const repeat = input.repeat ?? 1
  if (repeat <= 0) {
    return { ran: false, iterations: 0, recorded: 0, results: [], verdicts: store.classify() }
  }

  const runner = deps.runner ?? fw.defaultRunner
  const reportDir = deps.reportDir ?? mkdtempSync(join(tmpdir(), 'sackville-flake-'))
  const files = input.files ?? []
  const results: { exitCode: number; passed: boolean }[] = []
  let recorded = 0

  for (let i = 0; i < repeat; i++) {
    const outFile = join(reportDir, `report-${i}.json`)
    const { exitCode } = await runner(fw.buildArgv(files, outFile), {
      cwd: config.projectRoot,
      timeoutMs: config.timeoutMs,
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8'))
    } catch {
      throw new Error(
        `flake run did not produce a JSON report at ${outFile} (exit code ${exitCode})`,
      )
    }
    recorded += fw.ingest(store, parsed, {
      at: new Date().toISOString(),
      projectRoot: config.projectRoot,
      runGroup: input.runGroup !== undefined ? `${input.runGroup}#${i}` : undefined,
    })
    results.push({ exitCode, passed: exitCode === 0 })
  }

  return { ran: true, iterations: repeat, recorded, results, verdicts: store.classify() }
}

/**
 * Run the vitest suite `repeat` times behind the operator gate, recording every outcome into the
 * store, then classify. The actual `vitest` invocation is the injected `runner` (default
 * {@link defaultVitestRunner}).
 */
export async function runAndRecord(
  store: HistoryStore,
  config: RunHistoryConfig,
  input: RunAndRecordInput,
  deps: { runner?: TestRunner; reportDir?: string } = {},
): Promise<RunAndRecordResult> {
  return runAndRecordWith(VITEST, store, config, input, deps)
}

/**
 * The pytest sibling of {@link runAndRecord} (ADR 0010 addendum): spawn `pytest --json-report`
 * `repeat` times, ingest via the existing `parsePytestJson` (unchanged), classify. Repeats re-run
 * the WHOLE suite — never `pytest-repeat`, whose `[i-N]` nodeid suffix would fragment the
 * one-history-per-nodeid invariant the classifier relies on.
 */
export async function runAndRecordPytest(
  store: HistoryStore,
  config: RunHistoryConfig,
  input: RunAndRecordInput,
  deps: { runner?: TestRunner; reportDir?: string } = {},
): Promise<RunAndRecordResult> {
  return runAndRecordWith(PYTEST, store, config, input, deps)
}
