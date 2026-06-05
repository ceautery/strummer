#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolveSecretStore } from '@strummer/api'
import { ArtifactStore } from '@strummer/artifacts'
import { Redactor } from '@strummer/safety'
import { type ApiToolsOptions, createApiServer, registerApiTools } from './api.js'
import type { PillarSetup } from './pillars.js'

/** Parsed, operator-set configuration for the API MCP bin (set at launch). */
export interface ApiBinConfig {
  allowUnsafe: boolean
  allowedHosts: string[]
  /** Chain the OS keyring ahead of the env secret store. */
  keyring: boolean
  /** Permit loopback/private SSRF targets (default true; STRUMMER_BLOCK_PRIVATE flips it). */
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

/** Parse the operator env into the API bin config (single source of truth). */
export function apiConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ApiBinConfig {
  return {
    allowUnsafe: bool(env.STRUMMER_ALLOW_UNSAFE),
    allowedHosts: csv(env.STRUMMER_ALLOWED_HOSTS),
    keyring: bool(env.STRUMMER_KEYRING),
    allowPrivate: !bool(env.STRUMMER_BLOCK_PRIVATE),
    artifactsRoot: env.STRUMMER_ARTIFACTS_ROOT || undefined,
    allowCapture: bool(env.STRUMMER_VERIFY_ALLOW_CAPTURE),
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
      const m = /^STRUMMER_VERIFY_SECRET_(.+)$/.exec(key)
      if (m?.[1] && value) redactor.register(m[1], value)
    }
    verifyRedact = (v) => redactor.redact(v)
  }

  return {
    allowUnsafe: config.allowUnsafe,
    allowedHosts: config.allowedHosts,
    allowPrivate: config.allowPrivate,
    secrets: config.keyring ? resolveSecretStore({ keyring: true }) : undefined,
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
): PillarSetup {
  const opts = apiOptions(apiConfigFromEnv(env), env)
  return { register: (server) => registerApiTools(server, opts) }
}

/**
 * Build the API MCP server from operator env. Safety is operator-set, never by
 * the agent (see ADR 0004): mutating requests stay dry-run unless BOTH
 * `STRUMMER_ALLOW_UNSAFE` and a `STRUMMER_ALLOWED_HOSTS` allowlist are present.
 *   STRUMMER_ALLOW_UNSAFE=1
 *   STRUMMER_ALLOWED_HOSTS=api.example.com,127.0.0.1
 *   STRUMMER_KEYRING=1        # chain the OS keyring ahead of STRUMMER_SECRET_<NAME>
 *   STRUMMER_BLOCK_PRIVATE=1  # also refuse loopback/RFC1918 SSRF targets (hardened)
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
