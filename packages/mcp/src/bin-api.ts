#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveSecretStore } from '@sackville/api'
import { ArtifactStore } from '@sackville/artifacts'
import { Redactor } from '@sackville/safety'
import { type ApiToolsOptions, createApiServer, registerApiTools } from './api.js'
import type { PillarSetup } from './pillars.js'

/** Parsed, operator-set configuration for the API MCP bin (set at launch). */
export interface ApiBinConfig {
  allowUnsafe: boolean
  allowedHosts: string[]
  /** Chain the OS keyring ahead of the env secret store. */
  keyring: boolean
  /** Permit loopback/private SSRF targets (default true; SACKVILLE_BLOCK_PRIVATE flips it). */
  allowPrivate: boolean
  /** Shared artifacts root — enables `validate_capture` HAR resolution (ADR 0013). */
  artifactsRoot?: string
  /** Operator opt-in to resolve an operator-gated HAR for validation (ADR 0013 §3a). */
  allowCapture: boolean
}

export interface BuiltApiServer {
  server: McpServer
  config: ApiBinConfig
}

function bool(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').toLowerCase())
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

/** Aggregate-mode flag: when true, the api pillar reads its OWN `SACKVILLE_API_*`
 * namespace instead of the bare names (ADR 0019 §A8 — so one bare flag can't
 * unlock api AND verify in a single shared process). Standalone bins pass false. */
export interface AggregateMode {
  aggregate?: boolean
}

/** The api pillar's operator safety gate. In aggregate mode it reads the PREFIXED
 * `SACKVILLE_API_ALLOW_UNSAFE`/`_ALLOWED_HOSTS`/`_BLOCK_PRIVATE`/`_KEYRING`; standalone
 * reads the bare `SACKVILLE_*` names. Shared by the api bin AND verify's produce-api
 * gate so the anti-widening rule is enforced in exactly one place. */
export function apiSafetyGateFromEnv(
  env: Record<string, string | undefined> = process.env,
  { aggregate = false }: AggregateMode = {},
): { allowUnsafe: boolean; allowedHosts: string[]; allowPrivate: boolean; keyring: boolean } {
  const p = aggregate ? 'SACKVILLE_API_' : 'SACKVILLE_'
  return {
    allowUnsafe: bool(env[`${p}ALLOW_UNSAFE`]),
    allowedHosts: csv(env[`${p}ALLOWED_HOSTS`]),
    allowPrivate: !bool(env[`${p}BLOCK_PRIVATE`]),
    keyring: bool(env[`${p}KEYRING`]),
  }
}

/** The env variable prefix the api pillar's secret store reads. Aggregate mode
 * uses its own namespace so a bare `SACKVILLE_SECRET_*` can't be read here. */
export function apiSecretPrefix({ aggregate = false }: AggregateMode = {}): string {
  return aggregate ? 'SACKVILLE_API_SECRET_' : 'SACKVILLE_SECRET_'
}

/** Parse the operator env into the API bin config (single source of truth). */
export function apiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  mode: AggregateMode = {},
): ApiBinConfig {
  return {
    ...apiSafetyGateFromEnv(env, mode),
    artifactsRoot: env.SACKVILLE_ARTIFACTS_ROOT || undefined,
    allowCapture: bool(env.SACKVILLE_VERIFY_ALLOW_CAPTURE),
  }
}

/**
 * Build the exact {@link ApiToolsOptions} object the standalone bin passes to
 * `createApiServer` — the single place that wires the capture→contract bridge.
 * Shared by `buildApiServerFromEnv` and `setupApiFromEnv` so the two surfaces
 * can never drift. The API pillar owns no long-lived resources (the
 * `ArtifactStore` is opened lazily inside `registerApiTools`).
 */
function apiOptions(
  config: ApiBinConfig,
  env: Record<string, string | undefined>,
  mode: AggregateMode = {},
): ApiToolsOptions {
  // The capture→contract bridge (ADR 0013) is wired only when the operator set a
  // shared artifacts root. The store resolves a foreign-prefix HAR handle via the
  // slice-1 cross-prefix rehydrate; verdict detail is stored under the `verify`
  // prefix. Finding messages are redacted with operator-registered secret values.
  let resolveHar: ((handle: string) => Buffer | undefined) | undefined
  let storeVerifyDetail:
    | ((id: string, kind: string, body: string, contentType: string) => string)
    | undefined
  let verifyRedact: ((value: string) => string) | undefined
  if (config.artifactsRoot) {
    const verifyStore = new ArtifactStore(config.artifactsRoot, 'verify')
    resolveHar = (handle) => verifyStore.get(handle)?.body
    storeVerifyDetail = (id, kind, body, contentType) =>
      verifyStore.put(id, kind, body, contentType)
    const redactor = new Redactor()
    for (const [key, value] of Object.entries(env)) {
      const m = /^SACKVILLE_VERIFY_SECRET_(.+)$/.exec(key)
      if (m?.[1] && value) redactor.register(m[1], value)
    }
    verifyRedact = (v) => redactor.redact(v)
  }

  // Standalone: keyring chains over the bare SACKVILLE_SECRET_* (else the runner's
  // default env store). Aggregate: ALWAYS pin the api secret namespace
  // (SACKVILLE_API_SECRET_*) so a bare shared SACKVILLE_SECRET_* is never read here.
  const secrets = mode.aggregate
    ? resolveSecretStore({ keyring: config.keyring, env, envPrefix: apiSecretPrefix(mode) })
    : config.keyring
      ? resolveSecretStore({ keyring: true })
      : undefined

  return {
    allowUnsafe: config.allowUnsafe,
    allowedHosts: config.allowedHosts,
    allowPrivate: config.allowPrivate,
    secrets,
    allowCapture: config.allowCapture,
    resolveHar,
    storeVerifyDetail,
    verifyRedact,
  }
}

/**
 * The aggregate-composition seam (ADR 0019): parse env, return a {@link PillarSetup}
 * that registers the API tools onto a (possibly shared) server. The API pillar owns
 * no long-lived resources, so there is no `shutdown`.
 */
export function setupApiFromEnv(
  env: Record<string, string | undefined> = process.env,
  mode: AggregateMode = {},
): PillarSetup {
  const opts = apiOptions(apiConfigFromEnv(env, mode), env, mode)
  return { register: (server) => registerApiTools(server, opts) }
}

/**
 * Build the API MCP server from operator env. Safety is operator-set, never by
 * the agent (see ADR 0004): mutating requests stay dry-run unless BOTH
 * `SACKVILLE_ALLOW_UNSAFE` and a `SACKVILLE_ALLOWED_HOSTS` allowlist are present.
 *   SACKVILLE_ALLOW_UNSAFE=1
 *   SACKVILLE_ALLOWED_HOSTS=api.example.com,127.0.0.1
 *   SACKVILLE_KEYRING=1        # chain the OS keyring ahead of SACKVILLE_SECRET_<NAME>
 *   SACKVILLE_BLOCK_PRIVATE=1  # also refuse loopback/RFC1918 SSRF targets (hardened)
 */
export function buildApiServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltApiServer {
  const config = apiConfigFromEnv(env)
  const server = createApiServer(apiOptions(config, env))
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildApiServerFromEnv()
  await server.connect(new StdioServerTransport())
}
