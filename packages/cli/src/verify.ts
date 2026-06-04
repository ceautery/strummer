import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { ContractResult } from '@strummer/api'
import { type DiffCoverageReport, runScoped, type TestRunner } from '@strummer/coverage'
import { changedDependencies, type DependencyAudit, type OsvEcosystem } from '@strummer/deps'
import { type FlakeVerdict, HistoryStore, runAndRecord } from '@strummer/flake'
import { type MutationRunner, type MutationSummary, runMutation } from '@strummer/mutate'
import {
  type ComposeInputs,
  type CompositeVerdict,
  composeVerdict,
  fromContractResults,
  fromDependencyAudits,
  fromDiffCoverage,
  fromFlakeVerdicts,
  fromMutationSummary,
  type Severity,
} from '@strummer/verdict'
import { type OrchestrateRequest, orchestrate } from '@strummer/verify'
import { auditProjectScoped, makeFetcher, type PackumentFetcher, registriesFrom } from './deps.js'
import type { CliIO } from './index.js'

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'none']

const EMPTY_COVERAGE: DiffCoverageReport = {
  files: [],
  uncovered: [],
  summary: { covered: 0, uncovered: 0, nonExecutable: 0, total: 0, filesWithoutCoverage: 0 },
}

/**
 * Per-pillar run thunk overrides — the test seam (mirrors the MCP `RunDrivingOptions`
 * shape). When absent, `verify run` builds the REAL engine-backed thunk; tests inject
 * fakes so the suite never spawns. The engine runner seams (`TestRunner`/`MutationRunner`)
 * are also injectable for the realistic path.
 */
export interface VerifyRunDeps {
  coverage?: (ctx: RunCtx) => Promise<DiffCoverageReport>
  flake?: (ctx: RunCtx) => Promise<FlakeVerdict[]>
  mutate?: (ctx: RunCtx) => Promise<MutationSummary>
  deps?: (ctx: RunCtx) => Promise<{ audits: DependencyAudit[]; osvSnapshotLoaded: boolean }>
  coverageRunner?: TestRunner
  flakeRunner?: TestRunner
  mutateRunner?: MutationRunner
  /** Injected packument fetcher for the realistic deps path (keeps the suite offline). */
  depsFetcher?: PackumentFetcher
  historyStore?: HistoryStore
}

interface RunCtx {
  projectRoot: string
  changedFiles: string[]
  diff?: string
}

/**
 * `strummer verify` — the human surface over the cross-pillar verdict.
 *
 * - `verify [--contract f] [--coverage f] ...` (COMPOSE): fold per-pillar JSON results
 *   on disk into one verdict (ADR 0013 §1). The human supplies each pillar's output.
 * - `verify run <root> [--coverage] [--flake --flake-db f] [--mutate] [--deps] [--allow-run] ...`
 *   (RUN-DRIVING, ADR 0013 Addendum 5c/5d): DRIVE the selected pillars and fold them. The
 *   human is the operator, so `--allow-run` is the straight-through gate for the SPAWN
 *   pillars (coverage/flake/mutate) and the typed root is auto-allowed; each pillar's own
 *   `assertAllowed` still denies without it (⇒ `skipReason:gate-not-set`, never run —
 *   "compose, never widen"). `--deps` is gated by NETWORK not spawn (a packument fetch),
 *   so it needs no `--allow-run`; a `--diff` scopes the audit to the changed packages
 *   (`changedDependencies`). Runners are injectable so the suite never spawns (ADR 0010).
 *
 * Exit codes (both modes): 0 pass / 1 fail|warn / 2 inconclusive.
 */
export async function runVerify(
  args: string[],
  io: CliIO,
  deps: VerifyRunDeps = {},
): Promise<number> {
  if (args[0] === 'run') return cmdVerifyRun(args.slice(1), io, deps)
  return runVerifyCompose(args, io)
}

function printVerdict(io: CliIO, verdict: CompositeVerdict, json: boolean | undefined): void {
  if (json) {
    io.out(`${JSON.stringify(verdict, null, 2)}\n`)
    return
  }
  io.out(`verdict: ${verdict.status.toUpperCase()} (worst severity ${verdict.worstSeverity})\n`)
  for (const p of verdict.pillars) {
    const sev = p.severity !== 'none' ? ` [${p.severity}]` : ''
    const why = p.skipReason ? ` (skipped: ${p.skipReason})` : p.errorReason ? ' (errored)' : ''
    io.out(`  ${p.pillar}: ${p.status}${sev}${why} — ${p.headline}\n`)
  }
}

function exitFor(verdict: CompositeVerdict): number {
  if (verdict.status === 'pass') return 0
  if (verdict.status === 'inconclusive') return 2
  return 1
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

async function cmdVerifyRun(args: string[], io: CliIO, deps: VerifyRunDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      coverage: { type: 'boolean' },
      flake: { type: 'boolean' },
      mutate: { type: 'boolean' },
      deps: { type: 'boolean' },
      'allow-run': { type: 'boolean' },
      'changed-file': { type: 'string', multiple: true },
      diff: { type: 'string' },
      'flake-db': { type: 'string' },
      // deps run-driving: its gate is NETWORK (a packument fetch), not spawn — the human
      // typing --deps is the operator intent, so it needs no --allow-run.
      'osv-db': { type: 'string' },
      registry: { type: 'string' },
      'allow-private': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'fail-at-or-above': { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const projectRoot = positionals[0]
  if (!projectRoot) {
    io.err('verify run needs a <project-root>\n')
    return 2
  }
  const failAtOrAbove = values['fail-at-or-above']
  if (failAtOrAbove !== undefined && !SEVERITIES.includes(failAtOrAbove)) {
    io.err(`--fail-at-or-above must be one of ${SEVERITIES.join('|')}\n`)
    return 2
  }

  const allowRun = values['allow-run'] ?? false
  const allowedRoots = [resolve(projectRoot)]
  const changedFiles = values['changed-file'] ?? []
  const diff = values.diff !== undefined ? readFileSync(values.diff, 'utf8') : undefined
  const timeoutMs = num(values['timeout-ms'])
  const ctx: RunCtx = { projectRoot, changedFiles, diff }

  const request: OrchestrateRequest = {}
  if (values.coverage) {
    const ovr = deps.coverage
    request.coverage = {
      run: ovr
        ? () => ovr(ctx)
        : async () => {
            const r = await runScoped(
              { projectRoot, allowedRoots, allowRun, timeoutMs },
              { changedFiles, diff },
              { runner: deps.coverageRunner },
            )
            return r.report ?? EMPTY_COVERAGE
          },
    }
  }
  if (values.mutate) {
    const ovr = deps.mutate
    request.mutate = {
      run: ovr
        ? () => ovr(ctx)
        : async () =>
            (
              await runMutation(
                { projectRoot, allowedRoots, allowRun, timeoutMs },
                { mutateFiles: changedFiles },
                { runner: deps.mutateRunner },
              )
            ).summary,
    }
  }
  if (values.flake) {
    const ovr = deps.flake
    if (ovr) {
      request.flake = { run: () => ovr(ctx) }
    } else {
      const dbPath = values['flake-db']
      const store = deps.historyStore ?? (dbPath ? HistoryStore.open(dbPath) : undefined)
      if (!store) {
        io.err('verify run --flake needs --flake-db <path>\n')
        return 2
      }
      request.flake = {
        run: async () => {
          try {
            const r = await runAndRecord(
              store,
              { projectRoot, allowedRoots, allowRun, timeoutMs },
              { files: changedFiles },
              { runner: deps.flakeRunner },
            )
            return r.verdicts
          } finally {
            if (!deps.historyStore && dbPath) store.close()
          }
        },
      }
    }
  }

  if (values.deps) {
    const ovr = deps.deps
    if (ovr) {
      request.deps = { run: () => ovr(ctx) }
    } else {
      // npm-first (matches the deps run-wiring); the diff scopes the audit to the
      // changed packages, falling back to the whole project when none changed.
      const ecosystem: OsvEcosystem = 'npm'
      const fetchPackument = deps.depsFetcher ?? makeFetcher(registriesFrom(values))
      const osvDir = values['osv-db']
      request.deps = {
        run: async () => {
          const scoped = diff ? changedDependencies(diff, ecosystem) : []
          const { audits, osvSnapshotLoaded } = await auditProjectScoped({
            project: projectRoot,
            ecosystem,
            names: scoped.length > 0 ? scoped : undefined,
            osvDir,
            fetchPackument,
          })
          return { audits, osvSnapshotLoaded }
        },
      }
    }
  }

  if (Object.keys(request).length === 0) {
    io.err('verify run needs ≥1 pillar (--coverage / --flake / --mutate / --deps)\n')
    return 2
  }

  const { verdict } = await orchestrate(request, {
    policy: { failAtOrAbove: failAtOrAbove as Severity | undefined },
  })
  printVerdict(io, verdict, values.json)
  return exitFor(verdict)
}

function runVerifyCompose(args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    options: {
      contract: { type: 'string' },
      source: { type: 'string' },
      coverage: { type: 'string' },
      deps: { type: 'string' },
      'osv-snapshot-loaded': { type: 'boolean' },
      flake: { type: 'string' },
      mutate: { type: 'string' },
      'fail-at-or-above': { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const failAtOrAbove = values['fail-at-or-above']
  if (failAtOrAbove !== undefined && !SEVERITIES.includes(failAtOrAbove)) {
    io.err(`--fail-at-or-above must be one of ${SEVERITIES.join('|')}\n`)
    return 2
  }

  const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
  const inputs: ComposeInputs = {}

  if (values.contract) {
    const c = readJson(values.contract) as ContractResult[] | { results?: ContractResult[] }
    const results = Array.isArray(c) ? c : (c.results ?? [])
    inputs.contract = fromContractResults(
      results,
      values.source === 'run' ? 'run' : 'capture-from-HAR',
    )
  }
  if (values.coverage) {
    inputs.coverage = fromDiffCoverage(
      readJson(values.coverage) as Parameters<typeof fromDiffCoverage>[0],
    )
  }
  if (values.deps) {
    inputs.deps = fromDependencyAudits(
      readJson(values.deps) as Parameters<typeof fromDependencyAudits>[0],
      { osvSnapshotLoaded: values['osv-snapshot-loaded'] ?? false },
    )
  }
  if (values.flake) {
    inputs.flake = fromFlakeVerdicts(
      readJson(values.flake) as Parameters<typeof fromFlakeVerdicts>[0],
    )
  }
  if (values.mutate) {
    inputs.mutate = fromMutationSummary(
      readJson(values.mutate) as Parameters<typeof fromMutationSummary>[0],
    )
  }

  const verdict = composeVerdict(inputs, { failAtOrAbove: failAtOrAbove as Severity | undefined })
  printVerdict(io, verdict, values.json)
  return exitFor(verdict)
}
