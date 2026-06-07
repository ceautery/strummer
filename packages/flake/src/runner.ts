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

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type ScopeMode, selectPytestScope } from '@sackville-mcp/pyscope'
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
  /**
   * Diff-scope the run: treat `files` as CHANGED SOURCE files and repeat only the tests they
   * touch, instead of positional filters — a pre-commit/PR flake check then exercises only the
   * tests a change actually affects (mirrors `@sackville-mcp/coverage`'s `runScoped`). For vitest
   * this is the native `vitest related <files> --run`; for pytest (no native equivalent) the
   * changed sources are mapped to their mirrored tests via `@sackville-mcp/pyscope`
   * `selectPytestScope`. `related` with an empty `files` set — or, for pytest in the default
   * `report-gap` mode, one where NO source maps to a test — is a pre-spawn noop (`ran:false`),
   * NEVER a whole-suite run. Default false.
   */
  related?: boolean
  /**
   * pytest related-scoping only: the fallback when a changed source maps to no mirrored test.
   * `report-gap` (default) repeats the matched tests and surfaces the unmatched source in
   * `unmatched`; `widen` repeats the whole suite. Ignored by vitest (its `related` is native).
   */
  scopeMode?: ScopeMode
  /** Batch id; each iteration is recorded under `${runGroup}#<i>`. */
  runGroup?: string
}

/** Injected command runner — executes `vitest <argv>` and yields its exit status. */
export type TestRunner = SpawnedRunner

export interface RunAndRecordResult {
  /** False when the runner was never invoked (repeat <= 0, or a related run that mapped to no test). */
  ran: boolean
  /** Diff-scoped changed sources that mapped to no test (pytest report-gap) — surfaced, never dropped. */
  unmatched: string[]
  iterations: number
  /** Total runs recorded across all iterations. */
  recorded: number
  results: { exitCode: number; passed: boolean }[]
  /** Classifier verdicts over the store AFTER recording this batch. */
  verdicts: FlakeVerdict[]
}

/**
 * Build the argv for one vitest suite run with the JSON reporter writing to `outFile`. When
 * `related` is set, `files` are CHANGED SOURCE files and we run `vitest related <files> --run`
 * (the tests depending on them) — the exact `related` invocation `@sackville-mcp/coverage`'s
 * `runScoped` uses — instead of treating them as positional test-file filters.
 */
function vitestArgv(files: string[], outFile: string, related: boolean): string[] {
  if (related) {
    return ['related', ...files, '--run', '--reporter=json', `--outputFile=${outFile}`]
  }
  return ['run', ...files, '--reporter=json', `--outputFile=${outFile}`]
}

/**
 * Build the argv for one pytest run with the `pytest-json-report` plugin writing to `outFile`
 * (ADR 0010 addendum: json-report now, `pytest-reportlog` staged). No `run` subcommand — pytest
 * takes positional file filters directly. The plugin is an operator-installed dev dependency.
 */
function pytestArgv(files: string[], outFile: string, _related: boolean): string[] {
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
/** The operands + gap for a related (diff-scoped) run, derived from changed SOURCE files. */
interface RelatedScope {
  /** What to hand the runner: vitest = the changed sources (native `related`); pytest = mirrored tests. */
  operands: string[]
  /** Changed sources with no confident mirrored test (pytest report-gap). */
  unmatched: string[]
  /** True when the no-test fallback widened to the whole suite. */
  widened: boolean
}

/** FS + mode context for resolving a related scope (the predicate is injected so the gate never hits disk). */
interface ResolveScopeDeps {
  projectRoot: string
  mode: ScopeMode
  testExists: (path: string) => boolean
}

interface FrameworkAdapter {
  defaultRunner: TestRunner
  /**
   * Resolve a related (diff-scoped) run's operands from CHANGED SOURCE files. Omitted ⇒ identity
   * (vitest: its native `related <sources>` resolves the dependency graph itself). pytest maps
   * sources → their mirrored tests via `selectPytestScope`. Only called when `related` is set.
   */
  resolveRelated?(files: string[], deps: ResolveScopeDeps): RelatedScope
  buildArgv(files: string[], outFile: string, related: boolean): string[]
  ingest(store: HistoryStore, parsed: unknown, opts: ParseReportOptions): number
}

const VITEST: FrameworkAdapter = {
  defaultRunner: defaultVitestRunner,
  buildArgv: vitestArgv,
  ingest: (store, parsed, opts) => store.ingestReport(parsed as VitestJsonReport, opts),
}

const PYTEST: FrameworkAdapter = {
  defaultRunner: defaultPytestRunner,
  // pytest has no native `related`, so map changed sources → mirrored tests (the same shared
  // heuristic `@sackville-mcp/coverage` uses). The resolved tests become pytest's positional operands.
  resolveRelated: (files, deps) => {
    const scope = selectPytestScope(files, deps.mode, deps.testExists)
    return { operands: scope.selectors, unmatched: scope.unmatched, widened: scope.widened }
  },
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
  deps: { runner?: TestRunner; reportDir?: string; testExists?: (path: string) => boolean },
): Promise<RunAndRecordResult> {
  assertAllowed(config)

  // A run that never spawns the suite. `unmatched` carries any diff-scoped sources that mapped to
  // no test, so the caller still sees the gap — never a silent drop, never a whole-suite fallback.
  const noop = (unmatched: string[] = []): RunAndRecordResult => ({
    ran: false,
    unmatched,
    iterations: 0,
    recorded: 0,
    results: [],
    verdicts: store.classify(),
  })

  const repeat = input.repeat ?? 1
  if (repeat <= 0) return noop()

  const runner = deps.runner ?? fw.defaultRunner
  const reportDir = deps.reportDir ?? mkdtempSync(join(tmpdir(), 'sackville-flake-'))

  const related = input.related ?? false
  let files = input.files ?? []
  let unmatched: string[] = []
  if (related) {
    // `related` with no changed files would run with no operands — meaningless; noop without spawning.
    if (files.length === 0) return noop()
    if (fw.resolveRelated) {
      const testExists = deps.testExists ?? ((p: string) => existsSync(join(config.projectRoot, p)))
      const scope = fw.resolveRelated(files, {
        projectRoot: config.projectRoot,
        mode: input.scopeMode ?? 'report-gap',
        testExists,
      })
      unmatched = scope.unmatched
      // Mapped to ZERO tests and not widening ⇒ noop. Crucially NOT a whole-suite run (pytest with
      // no positional selectors = every test — the opposite of diff-scoping).
      if (!scope.widened && scope.operands.length === 0) return noop(unmatched)
      files = scope.operands // [] only when widened ⇒ deliberately the whole suite
    }
  }

  const results: { exitCode: number; passed: boolean }[] = []
  let recorded = 0

  for (let i = 0; i < repeat; i++) {
    const outFile = join(reportDir, `report-${i}.json`)
    const { exitCode } = await runner(fw.buildArgv(files, outFile, related), {
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

  return { ran: true, unmatched, iterations: repeat, recorded, results, verdicts: store.classify() }
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
  deps: { runner?: TestRunner; reportDir?: string; testExists?: (path: string) => boolean } = {},
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
  deps: { runner?: TestRunner; reportDir?: string; testExists?: (path: string) => boolean } = {},
): Promise<RunAndRecordResult> {
  return runAndRecordWith(PYTEST, store, config, input, deps)
}
