#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  type CoverageToolsOptions,
  createCoverageServer,
  registerCoverageTools,
} from './coverage.js'
import { isMainModule } from './is-main.js'
import type { PillarSetup } from './pillars.js'

/** Parsed, operator-set configuration for the coverage MCP bin (set at launch). */
export interface CoverageBinConfig {
  /** Enable run_scoped (deny-by-default — it executes the project's tests). */
  allowRun: boolean
  /** Project roots run_scoped may execute in. */
  allowedRoots: string[]
  /** Wall-clock cap for a scoped run (ms), or undefined for none. */
  timeoutMs?: number
}

export interface BuiltCoverageServer {
  server: McpServer
  config: CoverageBinConfig
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

/** Parse the operator env into the coverage bin config (single source of truth). */
export function coverageConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): CoverageBinConfig {
  const timeoutRaw = env.SACKVILLE_COVERAGE_TIMEOUT_MS
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw.trim() !== '' ? Number(timeoutRaw) : undefined
  return {
    allowRun: bool(env.SACKVILLE_COVERAGE_ALLOW_RUN),
    allowedRoots: csv(env.SACKVILLE_COVERAGE_PROJECT_ROOTS),
    timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  }
}

function coverageOptions(config: CoverageBinConfig): CoverageToolsOptions {
  return {
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    timeoutMs: config.timeoutMs,
  }
}

/**
 * The aggregate-composition seam (ADR 0019): parse env, return a {@link PillarSetup}
 * that registers the coverage tools onto a (possibly shared) server. Coverage owns no
 * long-lived resources, so there is no `shutdown`.
 */
export function setupCoverageFromEnv(
  env: Record<string, string | undefined> = process.env,
): PillarSetup {
  const opts = coverageOptions(coverageConfigFromEnv(env))
  return { register: (server) => registerCoverageTools(server, opts) }
}

/**
 * Build the coverage MCP server from operator env. `uncovered_in_diff` (read-only) is
 * always available; `run_scoped` runs the project's tests, so it is enabled only with the
 * paired gate — BOTH a truthy `SACKVILLE_COVERAGE_ALLOW_RUN` and a non-empty
 * `SACKVILLE_COVERAGE_PROJECT_ROOTS` allowlist (the allowlist is load-bearing on its own):
 *   SACKVILLE_COVERAGE_ALLOW_RUN=1
 *   SACKVILLE_COVERAGE_PROJECT_ROOTS=/abs/project,/abs/other
 *   SACKVILLE_COVERAGE_TIMEOUT_MS=120000
 */
export function buildCoverageServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltCoverageServer {
  const config = coverageConfigFromEnv(env)
  const server = createCoverageServer(coverageOptions(config))
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (isMainModule(import.meta.url)) {
  const { server } = buildCoverageServerFromEnv()
  await server.connect(new StdioServerTransport())
}
