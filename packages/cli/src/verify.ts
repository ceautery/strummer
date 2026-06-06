import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type CaptureContract,
  type ContractResult,
  loadCollection,
  runRequestToHar,
  validateCapturedTraffic,
} from '@sackville-mcp/api'
import { ArtifactStore } from '@sackville-mcp/artifacts'
import {
  BrowserGate,
  BrowserManager,
  type CaptureRequest,
  type CaptureRuntime,
  createSsrfProxy,
  driveBrowserFlowToHar,
  engineLauncher,
  resolveEngine,
} from '@sackville-mcp/browser'
import { type DiffCoverageReport, runScoped, type TestRunner } from '@sackville-mcp/coverage'
import { changedDependencies, type DependencyAudit, type OsvEcosystem } from '@sackville-mcp/deps'
import { type FlakeVerdict, HistoryStore, runAndRecord } from '@sackville-mcp/flake'
import {
  type MutationRunner,
  type MutationSummary,
  runCosmicRay,
  runMutation,
  runMutmut,
} from '@sackville-mcp/mutate'
import { Redactor } from '@sackville-mcp/safety'
import {
  type CaptureVerdictFacts,
  type ComposeInputs,
  type CompositeVerdict,
  composeVerdict,
  fromContractResults,
  fromDependencyAudits,
  fromDiffCoverage,
  fromFlakeVerdicts,
  fromMutationSummary,
  type Severity,
} from '@sackville-mcp/verdict'
import { type OrchestrateRequest, orchestrate } from '@sackville-mcp/verify'
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
  /** Produce-mode contract capture (drive a browser flow → validate). Injected in tests so
   * the suite never spawns a browser; the real path builds the runtime from CLI flags. */
  contract?: (req: CaptureRequest) => Promise<ContractResult[]>
  /** Produce-API contract capture (drive the api runner → synthesize + validate, 5f).
   * Injected in tests so the suite never fetches; the real path builds it from CLI flags. */
  contractApi?: (req: {
    request: string
    collectionDir?: string
    vars?: Record<string, string>
  }) => Promise<ContractResult[] | CaptureVerdictFacts>
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
 * `sackville verify` — the human surface over the cross-pillar verdict.
 *
 * - `verify [--contract f] [--coverage f] ...` (COMPOSE): fold per-pillar JSON results
 *   on disk into one verdict (ADR 0013 §1). The human supplies each pillar's output.
 * - `verify run <root> [--coverage] [--flake --flake-db f] [--mutate [--mutate-tool T --mutate-config f]] [--deps] [--allow-run] ...`
 *   (RUN-DRIVING, ADR 0013 Addendum 5c/5d): DRIVE the selected pillars and fold them. The
 *   human is the operator, so `--allow-run` is the straight-through gate for the SPAWN
 *   pillars (coverage/flake/mutate) and the typed root is auto-allowed; each pillar's own
 *   `assertAllowed` still denies without it (⇒ `skipReason:gate-not-set`, never run —
 *   "compose, never widen"). `--mutate-tool` picks the mutation engine (stryker default |
 *   cosmic-ray | mutmut; the Python tools diff-scope via a synthesized config from
 *   `--mutate-config`, ADR 0010 addendum 2). `--deps` is gated by NETWORK not spawn (a packument fetch),
 *   so it needs no `--allow-run`; a `--diff` scopes the audit to the changed packages
 *   (`changedDependencies`). `--flow <name>` (5e) DRIVES an operator-authored browser flow
 *   to capture a HAR and validate it against `--openapi`/`--graphql` — gated by the browser
 *   egress flags (`--flows-dir`/`--allow-host` + the mandatory SSRF proxy), not `--allow-run`.
 *   Runners are injectable so the suite never spawns (ADR 0010).
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
      'mutate-tool': { type: 'string' },
      'mutate-config': { type: 'string' },
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
      // contract PRODUCE mode (5e): drive an operator-authored flow → capture → validate.
      // Gated by the browser egress flags (allowlist + the mandatory SSRF proxy), not --allow-run.
      flow: { type: 'string' },
      'flows-dir': { type: 'string' },
      // contract PRODUCE-API mode (5f): drive an operator-authored api request → synthesize
      // + validate. Gated by --allow-unsafe + --allow-host (the api pillar gate), not --allow-run.
      request: { type: 'string' },
      'collection-dir': { type: 'string' },
      'allow-unsafe': { type: 'boolean' },
      'allow-host': { type: 'string', multiple: true },
      var: { type: 'string', multiple: true },
      openapi: { type: 'string' },
      graphql: { type: 'string' },
      'graphql-endpoint': { type: 'string' },
      engine: { type: 'string' },
      'no-sandbox': { type: 'boolean' },
      headed: { type: 'boolean' },
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
    // Fork D: --mutate-tool selects the engine (default stryker); --mutate-config supplies the
    // Python tools' base config (cosmic-ray.toml / pyproject.toml). The runner is injectable so
    // the suite never spawns; --diff/--changed-file scope the run.
    const tool = values['mutate-tool'] ?? 'stryker'
    if (tool !== 'stryker' && tool !== 'cosmic-ray' && tool !== 'mutmut') {
      io.err(`verify run --mutate-tool must be stryker | cosmic-ray | mutmut (got ${tool})\n`)
      return 2
    }
    const configPath = values['mutate-config']
    request.mutate = {
      run: ovr
        ? () => ovr(ctx)
        : async () => {
            const cfg = { projectRoot, allowedRoots, allowRun, timeoutMs }
            const mInput = { mutateFiles: changedFiles, configPath }
            const r =
              tool === 'cosmic-ray'
                ? await runCosmicRay(cfg, mInput, { runner: deps.mutateRunner })
                : tool === 'mutmut'
                  ? await runMutmut(cfg, mInput, { runner: deps.mutateRunner })
                  : await runMutation(cfg, mInput, { runner: deps.mutateRunner })
            return r.summary
          },
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
              // Diff-scope via `vitest related` (changed files are SOURCE files); no change set ⇒
              // whole suite, unchanged. See the MCP bin-verify flake thunk for the rationale.
              { files: changedFiles, related: changedFiles.length > 0 },
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

  if (values.request && values.flow) {
    io.err('verify run: --request and --flow are mutually exclusive\n')
    return 2
  }

  if (values.request) {
    const requestName = values.request
    const vars = parseVars(values.var)
    const ovr = deps.contractApi
    if (ovr) {
      request.contract = {
        source: 'capture-from-HAR',
        run: () => ovr({ request: requestName, collectionDir: values['collection-dir'], vars }),
      }
    } else {
      const colDir = values['collection-dir']
      if (!colDir) {
        io.err('verify run --request needs --collection-dir <dir>\n')
        return 2
      }
      const contract = readCaptureContract(values)
      const store = new ArtifactStore(
        mkdtempSync(join(tmpdir(), 'sackville-verify-cap-')),
        'verify',
      )
      // The human is the operator: --allow-unsafe + --allow-host are the api pillar gate
      // (a mutating request without them dry-runs ⇒ the driver throws ⇒ inconclusive). The
      // run-resolved {{secret:NAME}} pairs are folded into the redactor by the driver, so a
      // fresh Redactor scrubs both the stored HAR AND the findings (NOT the empty `{}` the
      // browser path can use — the synthesized api HAR holds raw bytes until redaction).
      request.contract = {
        source: 'capture-from-HAR',
        run: async () => {
          const out = await runRequestToHar(
            loadCollection(colDir),
            requestName,
            {
              vars,
              allowUnsafe: values['allow-unsafe'] ?? false,
              allowedHosts: values['allow-host'] ?? [],
            },
            { store, redactor: new Redactor(), contract },
          )
          return out.verdict
        },
      }
    }
  }

  if (values.flow) {
    const flow = values.flow
    const vars = parseVars(values.var)
    const ovr = deps.contract
    if (ovr) {
      request.contract = { source: 'capture-from-HAR', run: () => ovr({ flow, vars }) }
    } else {
      if (!values['flows-dir']) {
        io.err('verify run --flow needs --flows-dir <dir>\n')
        return 2
      }
      const flowsDir = values['flows-dir']
      const contract = readCaptureContract(values)
      // The human is the operator: the typed flow's hosts are allowlisted via --allow-host;
      // the mandatory SSRF proxy fronts every request (built in the runtime factory).
      const store = new ArtifactStore(
        mkdtempSync(join(tmpdir(), 'sackville-verify-cap-')),
        'verify',
      )
      request.contract = {
        source: 'capture-from-HAR',
        run: async () => {
          const { harHandle } = await driveBrowserFlowToHar(
            { flow, vars },
            { runtimeFactory: () => captureRuntimeFromFlags(values), store, flowsDir },
          )
          const har = store.get(harHandle)?.body
          if (!har) throw new Error('no HAR was captured for the driven flow')
          return validateCapturedTraffic(har, contract, {}).results
        },
      }
    }
  }

  if (Object.keys(request).length === 0) {
    io.err(
      'verify run needs ≥1 pillar (--coverage / --flake / --mutate / --deps / --flow / --request)\n',
    )
    return 2
  }

  const { verdict } = await orchestrate(request, {
    policy: { failAtOrAbove: failAtOrAbove as Severity | undefined },
  })
  printVerdict(io, verdict, values.json)
  return exitFor(verdict)
}

/** Parse repeated `--var k=v` flags into a map (non-secret flow vars). */
function parseVars(pairs: string[] | undefined): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const p of pairs ?? []) {
    const i = p.indexOf('=')
    if (i > 0) vars[p.slice(0, i)] = p.slice(i + 1)
  }
  return vars
}

/** Build the capture→contract from the openapi/graphql flags (≥1 needed, like the MCP tool). */
function readCaptureContract(values: {
  openapi?: string
  graphql?: string
  'graphql-endpoint'?: string
}): CaptureContract {
  const contract: CaptureContract = {}
  if (values.openapi) contract.openapi = JSON.parse(readFileSync(values.openapi, 'utf8'))
  if (values.graphql) {
    contract.graphql = {
      endpointPath: values['graphql-endpoint'] ?? '/graphql',
      sdl: readFileSync(values.graphql, 'utf8'),
    }
  }
  return contract
}

/** Build a single-shot CaptureRuntime from the CLI's browser egress flags (mirrors
 * `sackville browser`): a gated, proxy-fronted manager with HAR recording armed. */
/**
 * BrowserGate options for the `--flow` capture path, from the parsed CLI flags.
 * Exported for testing: a flow with `fill`/`click` steps is a MUTATION, so it
 * needs `--allow-unsafe` — without it every interaction dry-runs and the
 * flow-completeness guard fails the capture (the human typing the flag is the
 * operator, exactly as `sackville browser run --unsafe`).
 */
export function captureGateOptionsFromFlags(values: {
  'allow-host'?: string[]
  'allow-unsafe'?: boolean
}): { allowedHosts: string[]; allowUnsafe: boolean } {
  return {
    allowedHosts: values['allow-host'] ?? [],
    allowUnsafe: values['allow-unsafe'] ?? false,
  }
}

/**
 * Build the secret resolver + redactor for the `--flow` capture path from the
 * `SACKVILLE_BROWSER_SECRET_<NAME>` env — mirrors `sackville browser run` and the
 * browser MCP server. Without it a flow's `{{secret:NAME}}` step fails closed and
 * a secret value could land in the captured HAR. Exported for testing.
 */
export function browserCaptureSecretsFromEnv(env: Record<string, string | undefined>): {
  redact: (value: string) => string
  resolveSecret: (name: string) => string | undefined
} {
  const redactor = new Redactor()
  const secrets = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    const m = /^SACKVILLE_BROWSER_SECRET_(.+)$/.exec(key)
    if (m?.[1] && value) {
      redactor.register(m[1], value)
      secrets.set(m[1], value)
    }
  }
  return { redact: (s) => redactor.redact(s), resolveSecret: (name) => secrets.get(name) }
}

async function captureRuntimeFromFlags(values: {
  'allow-host'?: string[]
  'allow-unsafe'?: boolean
  'allow-private'?: boolean
  'no-sandbox'?: boolean
  headed?: boolean
  engine?: string
}): Promise<CaptureRuntime> {
  const gate = new BrowserGate(captureGateOptionsFromFlags(values))
  const proxy = await createSsrfProxy({ allowPrivate: values['allow-private'] ?? false })
  const harDir = mkdtempSync(join(tmpdir(), 'sackville-verify-har-'))
  const manager = new BrowserManager({
    gate,
    harDir,
    launch: engineLauncher(resolveEngine(values.engine), {
      headless: !values.headed,
      proxyServer: proxy.url,
      noSandbox: values['no-sandbox'] ?? false,
    }),
  })
  const { redact, resolveSecret } = browserCaptureSecretsFromEnv(process.env)
  return {
    manager,
    gate,
    redact,
    resolveSecret,
    config: { harDir },
    shutdown: async () => {
      await manager.shutdown()
      await proxy.close()
    },
  }
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
