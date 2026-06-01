#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HistoryStore } from '@strummer/flake'
import { createFlakeServer } from './flake.js'

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

/**
 * Build the flake MCP server from operator env. The read tools (status/candidates/release)
 * are always available once a DB path is set; the code-running and write tools are each
 * behind their own paired deny-by-default gate:
 *   STRUMMER_FLAKE_DB=/var/lib/strummer/flake-history.db   # required
 *   STRUMMER_FLAKE_ALLOW_RUN=1                             # + non-empty PROJECT_ROOTS → flake_run
 *   STRUMMER_FLAKE_PROJECT_ROOTS=/abs/project,/abs/other
 *   STRUMMER_FLAKE_TIMEOUT_MS=300000
 *   STRUMMER_FLAKE_ALLOW_QUARANTINE=1                      # + MAX_EXPIRY_MS>0 → flake_quarantine
 *   STRUMMER_FLAKE_MAX_EXPIRY_MS=604800000                 # 7 days
 */
export function buildFlakeServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltFlakeServer {
  const dbPath = env.STRUMMER_FLAKE_DB
  if (!dbPath) {
    throw new Error('STRUMMER_FLAKE_DB must be set to the run-history database path')
  }
  const config: FlakeBinConfig = {
    dbPath,
    allowRun: bool(env.STRUMMER_FLAKE_ALLOW_RUN),
    allowedRoots: csv(env.STRUMMER_FLAKE_PROJECT_ROOTS),
    timeoutMs: num(env.STRUMMER_FLAKE_TIMEOUT_MS),
    allowQuarantine: bool(env.STRUMMER_FLAKE_ALLOW_QUARANTINE),
    maxExpiryMs: num(env.STRUMMER_FLAKE_MAX_EXPIRY_MS) ?? 0,
  }
  const store = HistoryStore.open(config.dbPath)
  const server = createFlakeServer({
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
    // No injected runner ⇒ the engine uses the live vitest subprocess (defaultVitestRunner).
  })
  return { server, store, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildFlakeServerFromEnv()
  await server.connect(new StdioServerTransport())
}
