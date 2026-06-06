/**
 * The gated, diff-scoped mutation run — the live half of `@sackville-mcp/mutate`. It **spawns**
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

import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type SpawnedRunner, spawnRunner } from '@sackville-mcp/spawn'
import {
  cosmicModulePathRoots,
  mutmutDoNotMutate,
  mutmutPathsToMutate,
  planMutmutScope,
  synthesizeScopedCosmicRayConfig,
  synthesizeScopedMutmutPyproject,
} from './config.js'
import { parseCosmicRayDump } from './cosmic-ray.js'
import { parseMutmutResults } from './mutmut.js'
import { reconcileMutmutScope, reconcileScope, selectMutationScope } from './scope.js'
import { type MutationReport, type MutationSummary, summarizeMutation } from './summarize.js'

/** The zero-mutant summary returned by a pre-spawn noop (folds to no-signal ⇒ inconclusive). */
function emptyMutationSummary(): MutationSummary {
  return summarizeMutation({ files: {} })
}

/** Read a file, or undefined if it is absent (a missing base config is not an error). */
function readFileIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Directories never copied into the mutmut sandbox (heavy / irrelevant / the sticky mutants cache). */
const SANDBOX_EXCLUDE =
  /(?:^|\/)(?:node_modules|\.git|\.venv|venv|__pycache__|mutants|\.mutmut-cache|dist|\.tox)(?:\/|$)/

/** Recursively list the `.py` files under each owned root, repo-relative (FS default for runMutmut). */
function defaultListSources(ownedRoots: string[], projectRoot: string): string[] {
  const out: string[] = []
  for (const root of ownedRoots) {
    const abs = join(projectRoot, root)
    let entries: string[]
    try {
      entries = readdirSync(abs, { recursive: true }) as string[]
    } catch {
      continue // a declared root that is a single file or absent — skip (selectMutationScope handles files)
    }
    for (const rel of entries) {
      const p = rel.replace(/\\/g, '/')
      if (p.endsWith('.py') && !SANDBOX_EXCLUDE.test(p))
        out.push(`${root}/${p}`.replace(/\/+/g, '/'))
    }
  }
  return out
}

/** Copy a project into a fresh sandbox dir, excluding heavy dirs + the sticky `mutants/` cache. */
function copyProjectInto(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !SANDBOX_EXCLUDE.test(src.slice(from.length).replace(/\\/g, '/')),
  })
}

/** Thrown when the paired operator gate denies a run. */
export class MutateGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MutateGateError'
    // Brand as a gate DENIAL (ADR 0013 Addendum, milestone 5c): the run-driving
    // `@sackville-mcp/verify` reads this global-registry symbol via `isGateDenial` to map a
    // denial to `skipReason:'gate-not-set'` (never `errored`) WITHOUT importing engine
    // code. The `Symbol.for` key string is the cross-package contract.
    ;(this as unknown as Record<symbol, unknown>)[Symbol.for('sackville.gate-denial')] = true
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
  /**
   * Changed source files to scope mutation to. Stryker → `--mutate`; the Python tools → a synthesized
   * scoped config (cosmic-ray `module-path` list / mutmut `paths_to_mutate`). `undefined` ⇒ the
   * project default (whole project, today's behavior); a supplied list scopes the run, and a selection
   * that resolves to no mutable in-tree `.py` is a pre-spawn noop (`ran:false`, never a spawn).
   */
  mutateFiles?: string[]
  /** Reuse Stryker's incremental cache (`--incremental`) — faster re-runs. */
  incremental?: boolean
  /** cosmic-ray config path (relative to projectRoot). Default `cosmic-ray.toml`. */
  configPath?: string
  /**
   * OPTIONAL operator source roots the diff scope is confined to (Fork C). A changed `.py` outside
   * them is `unmatched` (report-gap), never scoped. Default: the tool config's declared source tree
   * (cosmic-ray `module-path`).
   */
  ownedRoots?: string[]
}

/** Injected command runner — executes `stryker <argv>` and yields its exit status. */
export type MutationRunner = SpawnedRunner

export interface RunMutationResult {
  ran: boolean
  exitCode: number
  /** Files mutation was scoped to (empty ⇒ the project's configured set). */
  scopedFiles: string[]
  /** Which mutation tool produced the summary. */
  tool?: 'stryker' | 'mutmut' | 'cosmic-ray'
  /**
   * The on-disk JSON report path (Stryker). Optional: the Python tools (mutmut/cosmic-ray) emit
   * their report to STDOUT, so there is no report file to surface.
   */
  reportPath?: string
  summary: MutationSummary
  /** A scope was requested but resolved to no mutable in-tree `.py` ⇒ pre-spawn noop (case (a)). */
  scopeEmpty?: boolean
  /** Changed `.py` files outside the owned tree / deleted — surfaced as a gap (Fork C), never scoped. */
  unmatched?: string[]
  /** The files the run was SELECTED to mutate (before reconciliation) — what we asked the tool for. */
  requestedFiles?: string[]
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
export const defaultStrykerRunner: MutationRunner = spawnRunner('stryker')

/** Default live runner: spawn the local `mutmut` as a subprocess (used by the bin, not the gate). */
export const defaultMutmutRunner: MutationRunner = spawnRunner('mutmut')

/** Default live runner: spawn the local `cosmic-ray` as a subprocess (used by the bin, not the gate). */
export const defaultCosmicRayRunner: MutationRunner = spawnRunner('cosmic-ray')

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
    tool: 'stryker',
    reportPath,
    summary: summarizeMutation(report),
  }
}

/**
 * Transport-completeness guard for the Python tools, mirroring the capture/HAR guards: a run that
 * produced NO mutants (an empty/failed session), or a cosmic-ray session with unexecuted/ambiguous
 * (`Pending`) mutants, is INCONCLUSIVE — it must never be reported as a clean pass
 * (absence-is-never-a-pass). Throws so the caller (verify) folds it to inconclusive.
 */
function assertComplete(tool: string, summary: MutationSummary): void {
  if (summary.metrics.totalMutants === 0) {
    throw new Error(`${tool} produced no mutants — inconclusive (never a clean pass)`)
  }
  if (summary.metrics.counts.pending > 0) {
    throw new Error(
      `${tool} session is incomplete: ${summary.metrics.counts.pending} unexecuted/ambiguous ` +
        'mutant(s) — inconclusive',
    )
  }
}

/**
 * mutmut sibling of {@link runMutation} (ADR 0010 addendum, the lightweight Python option). Spawns
 * `mutmut run` (mutate + test; a non-zero exit just means survivors exist, not an error) then reads
 * `mutmut results --all true` from STDOUT and feeds the pure {@link parseMutmutResults}. No report
 * file. (Diff-scoping is staged — mutmut 3.x scopes via its own config, not a clean CLI file list.)
 */
export async function runMutmut(
  config: RunMutationConfig,
  input: RunMutationInput,
  deps: {
    runner?: MutationRunner
    /** Existence check for the selected files (FS by default; injected in tests). */
    exists?: (path: string) => boolean
    /** Enumerate the `.py` files under the owned roots (for `also_copy`); FS walk by default. */
    listSourceFiles?: (ownedRoots: string[], projectRoot: string) => string[]
    /** The fresh sandbox cwd to run in (the sticky `mutants/` cache can't leak). Default mkdtemp. */
    sandboxDir?: string
  } = {},
): Promise<RunMutationResult> {
  assertAllowed(config)
  const runner = deps.runner ?? defaultMutmutRunner

  // Whole-project (today's behavior) in projectRoot when no scope is requested.
  if (input.mutateFiles === undefined) {
    const opts = { cwd: config.projectRoot, timeoutMs: config.timeoutMs }
    await runner(['run'], opts)
    const { exitCode, stdout } = await runner(['results', '--all', 'true'], opts)
    const summary = summarizeMutation(parseMutmutResults(stdout))
    assertComplete('mutmut', summary)
    return { ran: true, exitCode, scopedFiles: [], tool: 'mutmut', summary }
  }

  // Diff-scoped: confine to the owned tree, then select mutable existing .py files.
  const pyprojectPath = input.configPath ?? 'pyproject.toml'
  const basePyproject = readFileIfExists(join(config.projectRoot, pyprojectPath)) ?? ''
  const ownedRoots = input.ownedRoots ?? mutmutPathsToMutate(basePyproject)
  const exists = deps.exists ?? ((p: string) => existsSync(join(config.projectRoot, p)))
  const { files, unmatched } = selectMutationScope(input.mutateFiles, ownedRoots, exists)
  const unmatchedOut = unmatched.length > 0 ? unmatched : undefined

  // Case (a): nothing mutable in-tree remains — DO NOT spawn (noop).
  if (files.length === 0) {
    return {
      ran: false,
      exitCode: 0,
      scopedFiles: [],
      tool: 'mutmut',
      summary: emptyMutationSummary(),
      scopeEmpty: true,
      unmatched: unmatchedOut,
      requestedFiles: [],
    }
  }

  // Plan the scope: paths_to_mutate = selected files; also_copy = the rest of the source tree so
  // unscoped tests still import (slice 0); strip a colliding inherited do_not_mutate glob.
  const listSources = deps.listSourceFiles ?? defaultListSources
  const allSources = listSources(ownedRoots, config.projectRoot)
  const plan = planMutmutScope(files, allSources, mutmutDoNotMutate(basePyproject))
  const scopedPyproject = synthesizeScopedMutmutPyproject(basePyproject, plan)

  // Fresh sandbox cwd (the mutants/ cache is sticky), with the scoped pyproject written over the copy.
  const sandbox = deps.sandboxDir ?? mkdtempSync(join(tmpdir(), 'sackville-mutmut-'))
  copyProjectInto(config.projectRoot, sandbox)
  writeFileSync(join(sandbox, 'pyproject.toml'), scopedPyproject)

  const opts = { cwd: sandbox, timeoutMs: config.timeoutMs }
  await runner(['run'], opts)
  const { exitCode, stdout } = await runner(['results', '--all', 'true'], opts)
  const summary = summarizeMutation(parseMutmutResults(stdout))
  // A broken scoped baseline yields "not checked" ⇒ Pending ⇒ assertComplete throws (slice 0): this
  // IS the baseline-smoke gate. Total-zero is likewise inconclusive (case b).
  assertComplete('mutmut', summary)
  // Case (c): mutmut emits NO record for a 0-mutant selected file (Fork B2), so a selected file with
  // no matching mutated module was never mutated ⇒ inconclusive (conservative; never a false pass).
  const { mutatedFiles, missing } = reconcileMutmutScope(files, summary)
  if (missing.length > 0) {
    throw new Error(
      `mutmut under-scoped: ${missing.join(', ')} selected but produced no mutants — inconclusive`,
    )
  }
  return {
    ran: true,
    exitCode,
    scopedFiles: mutatedFiles,
    tool: 'mutmut',
    summary,
    requestedFiles: files,
    unmatched: unmatchedOut,
  }
}

/**
 * cosmic-ray sibling of {@link runMutation} (ADR 0010 addendum, the PRIMARY Python tool — its dump
 * carries real file:line:operator, so survivors are actionable). Drives the three-step workflow
 * against an operator-authored config (`input.configPath`, default `cosmic-ray.toml` — it carries
 * the project's test-command + module scope) over a throwaway session DB: `init` → `exec` → `dump`,
 * reading the `dump` JSON-lines from STDOUT and feeding the pure {@link parseCosmicRayDump}. The
 * {@link assertComplete} guard makes an empty or partially-executed session inconclusive, never a
 * clean pass. (Diff-scoping by synthesizing the per-run config from `mutateFiles` is staged.)
 */
export async function runCosmicRay(
  config: RunMutationConfig,
  input: RunMutationInput,
  deps: {
    runner?: MutationRunner
    sessionDir?: string
    /** Existence check for the selected files (FS by default; injected in tests). */
    exists?: (path: string) => boolean
    /** Scoped config filename written into projectRoot (relative). Default `.sackville-cosmic.toml`. */
    scopedConfigName?: string
  } = {},
): Promise<RunMutationResult> {
  assertAllowed(config)
  const runner = deps.runner ?? defaultCosmicRayRunner
  const opts = { cwd: config.projectRoot, timeoutMs: config.timeoutMs }
  const configPath = input.configPath ?? 'cosmic-ray.toml'
  const sessionDir = deps.sessionDir ?? mkdtempSync(join(tmpdir(), 'sackville-mutate-'))
  const session = join(sessionDir, 'session.sqlite')

  // Whole-project (today's behavior) when no scope is requested.
  if (input.mutateFiles === undefined) {
    await runner(['init', configPath, session], opts)
    const exec = await runner(['exec', configPath, session], opts)
    const { stdout } = await runner(['dump', session], opts)
    const summary = summarizeMutation(parseCosmicRayDump(stdout))
    assertComplete('cosmic-ray', summary)
    return { ran: true, exitCode: exec.exitCode, scopedFiles: [], tool: 'cosmic-ray', summary }
  }

  // Diff-scoped: confine the changed files to the owned source tree, then select mutable existing .py.
  const baseToml = readFileSync(join(config.projectRoot, configPath), 'utf8')
  const ownedRoots = input.ownedRoots ?? cosmicModulePathRoots(baseToml)
  const exists = deps.exists ?? ((p: string) => existsSync(join(config.projectRoot, p)))
  const { files, unmatched } = selectMutationScope(input.mutateFiles, ownedRoots, exists)
  const unmatchedOut = unmatched.length > 0 ? unmatched : undefined

  // Case (a): a scope was requested but nothing mutable in-tree remains — DO NOT spawn (noop).
  if (files.length === 0) {
    return {
      ran: false,
      exitCode: 0,
      scopedFiles: [],
      tool: 'cosmic-ray',
      summary: emptyMutationSummary(),
      scopeEmpty: true,
      unmatched: unmatchedOut,
      requestedFiles: [],
    }
  }

  // Synthesize a scoped config (module-path = selected files, excluded-modules reconciled). It must
  // live in projectRoot so its RELATIVE module-path resolves there (cosmic-ray then reports relative
  // module_path keys, which reconcileScope compares against the selected files directly).
  const scoped = synthesizeScopedCosmicRayConfig(baseToml, files)
  const scopedName = deps.scopedConfigName ?? '.sackville-cosmic.toml'
  const scopedAbs = join(config.projectRoot, scopedName)
  writeFileSync(scopedAbs, scoped.toml)
  try {
    await runner(['init', scopedName, session], opts)
    const exec = await runner(['exec', scopedName, session], opts)
    const { stdout } = await runner(['dump', session], opts)
    const summary = summarizeMutation(parseCosmicRayDump(stdout))
    assertComplete('cosmic-ray', summary) // case (b): total-zero / pending ⇒ inconclusive
    // Case (c): a selected file the tool never SAW was silently never mutated ⇒ inconclusive.
    const { mutatedFiles, missing } = reconcileScope(files, summary)
    if (missing.length > 0) {
      throw new Error(
        `cosmic-ray under-scoped: ${missing.join(', ')} selected but never mutated — inconclusive`,
      )
    }
    // Case (d): clean scoped run — report what was GENUINELY mutated, not what was requested.
    return {
      ran: true,
      exitCode: exec.exitCode,
      scopedFiles: mutatedFiles,
      tool: 'cosmic-ray',
      summary,
      requestedFiles: files,
      unmatched: unmatchedOut,
    }
  } finally {
    rmSync(scopedAbs, { force: true })
  }
}
