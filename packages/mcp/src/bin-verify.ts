#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { type CaptureContract, validateCapturedTraffic } from '@strummer/api'
import { ArtifactStore } from '@strummer/artifacts'
import { runScoped } from '@strummer/coverage'
import { changedDependencies } from '@strummer/deps'
import { HistoryStore, runAndRecord } from '@strummer/flake'
import { runMutation } from '@strummer/mutate'
import { Redactor } from '@strummer/safety'
import { depsNetworkConfig } from './bin-deps.js'
import { auditProjectDependencies } from './deps.js'
import { createVerifyServer } from './index.js'
import type { RunDrivingOptions } from './verify.js'

/**
 * Operator-set config for the verify MCP bin (ADR 0013 + Addendum milestone 5c).
 *
 * The COMPOSE-ONLY surface (`request_verdict`) reads ONLY the shared artifacts root
 * (verdict-by-handle) + the capture gate — it must NEVER read a per-pillar
 * `*_ALLOW_RUN` env (§3c: a shared name must not silently grant a future verify path
 * an operator's per-pillar grant).
 *
 * RUN-DRIVING (`verify_change`) is gated "both required" (§gate(b)): it is wired ONLY
 * when `STRUMMER_VERIFY_ENABLE_RUN` is set, AND then each pillar's runner is wired ONLY
 * when that pillar's OWN gate is satisfied (its real `STRUMMER_<PILLAR>_ALLOW_RUN` +
 * roots, the single source of truth shared with the standalone server). So enabling a
 * pillar's server runner never silently lets THIS server run it — that needs the
 * separate, conscious `ENABLE_RUN` opt-in. No tool input can set a gate ("never widen").
 */
export interface VerifyBinConfig {
  artifactsRoot?: string
  allowCapture: boolean
  /** The conscious "this verify server may DRIVE pillar runs" switch (§gate(b)). */
  enableRun: boolean
}

export interface BuiltVerifyServer {
  server: McpServer
  config: VerifyBinConfig
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}
function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
function num(value: string | undefined): number | undefined {
  const n = Number(value)
  return value && Number.isFinite(n) ? n : undefined
}

const EMPTY_COVERAGE = {
  files: [],
  uncovered: [],
  summary: { covered: 0, uncovered: 0, nonExecutable: 0, total: 0, filesWithoutCoverage: 0 },
}

export function buildVerifyServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltVerifyServer {
  const config: VerifyBinConfig = {
    artifactsRoot: env.STRUMMER_ARTIFACTS_ROOT || undefined,
    allowCapture: bool(env.STRUMMER_VERIFY_ALLOW_CAPTURE),
    enableRun: bool(env.STRUMMER_VERIFY_ENABLE_RUN),
  }

  // The operator redactor (registered secret values) — applied to capture findings AND
  // an errored pillar's surfaced message before it enters the verdict.
  const redactor = new Redactor()
  for (const [key, value] of Object.entries(env)) {
    const m = /^STRUMMER_VERIFY_SECRET_(.+)$/.exec(key)
    if (m?.[1] && value) redactor.register(m[1], value)
  }
  const redact = (v: string) => redactor.redact(v)

  let storeVerdict:
    | ((id: string, kind: string, body: string, contentType: string) => string)
    | undefined
  let resolveVerdict:
    | ((handle: string) => { contentType: string; body: Buffer } | undefined)
    | undefined
  let harStore: ArtifactStore | undefined
  if (config.artifactsRoot) {
    const store = new ArtifactStore(config.artifactsRoot, 'verify')
    harStore = store
    storeVerdict = (id, kind, body, contentType) => store.put(id, kind, body, contentType)
    resolveVerdict = (handle) => {
      const a = store.get(handle)
      return a ? { contentType: a.contentType, body: a.body } : undefined
    }
  }

  // RUN-DRIVING: only past the ENABLE_RUN switch do we read per-pillar gates. Each
  // pillar's runner is wired ONLY when its own gate is satisfied; otherwise a requested
  // pillar surfaces as `skipReason:'gate-not-set'` (the verify_change tool's denied
  // thunk). verify_change registers only when ≥1 runner is wired (deny-by-default).
  let runDriving: RunDrivingOptions | undefined
  if (config.enableRun) {
    const rd: RunDrivingOptions = { redact }

    const covRoots = csv(env.STRUMMER_COVERAGE_PROJECT_ROOTS)
    if (bool(env.STRUMMER_COVERAGE_ALLOW_RUN) && covRoots.length > 0) {
      const timeoutMs = num(env.STRUMMER_COVERAGE_TIMEOUT_MS)
      rd.coverage = async (ctx) => {
        const r = await runScoped(
          { projectRoot: ctx.projectRoot, allowedRoots: covRoots, allowRun: true, timeoutMs },
          { changedFiles: ctx.changedFiles, diff: ctx.diff },
        )
        return r.report ?? EMPTY_COVERAGE
      }
    }

    const flakeRoots = csv(env.STRUMMER_FLAKE_PROJECT_ROOTS)
    const flakeDb = env.STRUMMER_FLAKE_DB
    if (bool(env.STRUMMER_FLAKE_ALLOW_RUN) && flakeRoots.length > 0 && flakeDb) {
      const timeoutMs = num(env.STRUMMER_FLAKE_TIMEOUT_MS)
      rd.flake = async (ctx) => {
        const store = HistoryStore.open(flakeDb)
        try {
          const r = await runAndRecord(
            store,
            { projectRoot: ctx.projectRoot, allowedRoots: flakeRoots, allowRun: true, timeoutMs },
            { files: ctx.changedFiles },
            {},
          )
          return r.verdicts
        } finally {
          store.close()
        }
      }
    }

    const mutRoots = csv(env.STRUMMER_MUTATE_PROJECT_ROOTS)
    if (bool(env.STRUMMER_MUTATE_ALLOW_RUN) && mutRoots.length > 0) {
      const timeoutMs = num(env.STRUMMER_MUTATE_TIMEOUT_MS)
      const reportPath = env.STRUMMER_MUTATE_REPORT_PATH
      rd.mutate = async (ctx) => {
        const r = await runMutation(
          { projectRoot: ctx.projectRoot, allowedRoots: mutRoots, allowRun: true, timeoutMs },
          { mutateFiles: ctx.changedFiles },
          { reportPath },
        )
        return r.summary
      }
    }

    // Deps run-driving: its OWN gate is NETWORK (deps fetches packuments, it does not
    // run project code), so it is wired under ENABLE_RUN iff STRUMMER_DEPS_ALLOW_NETWORK
    // is set — the same single source as the deps server bin. The diff scopes the audit
    // to the changed packages (`changedDependencies`); a diff that changed no deps (or an
    // ecosystem whose lockfile diff is staged) falls back to the whole project.
    const deps = depsNetworkConfig(env)
    if (deps.allowNetwork && deps.fetchPackument) {
      const fetchPackument = deps.fetchPackument
      const osvDir = deps.osvDir
      rd.deps = async (ctx) => {
        const scoped = ctx.diff ? changedDependencies(ctx.diff, 'npm') : []
        const { audits, osvSnapshotLoaded } = await auditProjectDependencies({
          project: ctx.projectRoot,
          ecosystem: 'npm',
          names: scoped.length > 0 ? scoped : undefined,
          osvDir,
          fetchPackument,
        })
        return { audits, osvSnapshotLoaded }
      }
    }

    // The consume-only contract bridge: its OWN gate is the capture gate (allowCapture
    // + a shared artifacts root to resolve the foreign-prefix browser HAR by handle).
    if (config.allowCapture && harStore) {
      const store = harStore
      rd.contract = async (ctx) => {
        const har = store.get(ctx.harHandle)?.body
        if (!har) throw new Error(`no stored HAR for ${ctx.harHandle}`)
        const contract: CaptureContract = {}
        if (ctx.openapiSpec !== undefined) {
          contract.openapi = ctx.openapiSpec as CaptureContract['openapi']
        }
        if (ctx.graphqlSchema) {
          contract.graphql = {
            endpointPath: ctx.graphqlEndpoint ?? '/graphql',
            sdl: ctx.graphqlSchema,
          }
        }
        return validateCapturedTraffic(har, contract, { redact }).results
      }
    }

    runDriving = rd
  }

  const server = createVerifyServer({ storeVerdict, resolveVerdict, runDriving })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildVerifyServerFromEnv()
  await server.connect(new StdioServerTransport())
}
