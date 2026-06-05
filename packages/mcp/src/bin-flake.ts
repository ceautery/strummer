#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HistoryStore } from '@sackville-mcp/flake'
import { createFlakeServer, type FlakeToolsOptions, registerFlakeTools } from './flake.js'
import { isMainModule } from './is-main.js'
import type { PillarSetup } from './pillars.js'

/** Parsed, operator-set configuration for the flake MCP bin (set at launch). */
export interface FlakeBinConfig {
  /** Path to the private run-history SQLite DB (created on first use). */
  dbPath: string
  /** Enable flake_run (deny-by-default — it executes the project's tests). */
  allowRun: boolean
  /** Project roots flake_run may execute in (load-bearing even with allowRun). */
  allowedRoots: string[]
  /** Wall-clock cap per run iteration (ms), or undefined for none. */
  timeoutMs?: number
  /** Enable flake_quarantine writes (deny-by-default). */
  allowQuarantine: boolean
  /** Operator cap on quarantine duration (ms); load-bearing — 0 denies all writes. */
  maxExpiryMs: number
}

export interface BuiltFlakeServer {
  server: McpServer
  store: HistoryStore
  config: FlakeBinConfig
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
  if (value === undefined || value.trim() === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Parse the operator env into the flake bin config (single source of truth). */
export function flakeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): FlakeBinConfig {
  const dbPath = env.SACKVILLE_FLAKE_DB
  if (!dbPath) {
    throw new Error('SACKVILLE_FLAKE_DB must be set to the run-history database path')
  }
  return {
    dbPath,
    allowRun: bool(env.SACKVILLE_FLAKE_ALLOW_RUN),
    allowedRoots: csv(env.SACKVILLE_FLAKE_PROJECT_ROOTS),
    timeoutMs: num(env.SACKVILLE_FLAKE_TIMEOUT_MS),
    allowQuarantine: bool(env.SACKVILLE_FLAKE_ALLOW_QUARANTINE),
    maxExpiryMs: num(env.SACKVILLE_FLAKE_MAX_EXPIRY_MS) ?? 0,
  }
}

/**
 * Open the owned HistoryStore and assemble the FlakeToolsOptions from a parsed config — the
 * ONE place the store is constructed, shared by the standalone bin and the aggregate seam.
 * No injected runner ⇒ the engine uses the live vitest subprocess (defaultVitestRunner).
 */
function flakeOptions(config: FlakeBinConfig): { store: HistoryStore; opts: FlakeToolsOptions } {
  const store = HistoryStore.open(config.dbPath)
  const opts: FlakeToolsOptions = {
    store,
    runConfig: {
      allowRun: config.allowRun,
      allowedRoots: config.allowedRoots,
      timeoutMs: config.timeoutMs,
    },
    quarantinePolicy: {
      allowQuarantine: config.allowQuarantine,
      maxExpiryMs: config.maxExpiryMs,
    },
  }
  return { store, opts }
}

/**
 * The aggregate-composition seam (ADR 0019): parse env, open the OWNED run-history store, and
 * return a {@link PillarSetup} that registers the flake tools onto a (possibly shared) server.
 * Flake owns the SQLite HistoryStore, so `shutdown` closes it for the aggregate's teardown.
 */
export function setupFlakeFromEnv(
  env: Record<string, string | undefined> = process.env,
): PillarSetup {
  const { store, opts } = flakeOptions(flakeConfigFromEnv(env))
  return {
    register: (server) => registerFlakeTools(server, opts),
    shutdown: () => store.close(),
  }
}

/**
 * Build the flake MCP server from operator env. The read tools (status/candidates/release)
 * are always available once a DB path is set; the code-running and write tools are each
 * behind their own paired deny-by-default gate:
 *   SACKVILLE_FLAKE_DB=/var/lib/sackville/flake-history.db   # required
 *   SACKVILLE_FLAKE_ALLOW_RUN=1                             # + non-empty PROJECT_ROOTS → flake_run
 *   SACKVILLE_FLAKE_PROJECT_ROOTS=/abs/project,/abs/other
 *   SACKVILLE_FLAKE_TIMEOUT_MS=300000
 *   SACKVILLE_FLAKE_ALLOW_QUARANTINE=1                      # + MAX_EXPIRY_MS>0 → flake_quarantine
 *   SACKVILLE_FLAKE_MAX_EXPIRY_MS=604800000                 # 7 days
 */
export function buildFlakeServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltFlakeServer {
  const config = flakeConfigFromEnv(env)
  const { store, opts } = flakeOptions(config)
  const server = createFlakeServer(opts)
  return { server, store, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (isMainModule(import.meta.url)) {
  const { server } = buildFlakeServerFromEnv()
  await server.connect(new StdioServerTransport())
}
