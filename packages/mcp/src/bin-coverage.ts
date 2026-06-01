#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createCoverageServer } from './coverage.js'

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

/**
 * Build the coverage MCP server from operator env. `uncovered_in_diff` (read-only) is
 * always available; `run_scoped` runs the project's tests, so it is enabled only with the
 * paired gate — BOTH a truthy `STRUMMER_COVERAGE_ALLOW_RUN` and a non-empty
 * `STRUMMER_COVERAGE_PROJECT_ROOTS` allowlist (the allowlist is load-bearing on its own):
 *   STRUMMER_COVERAGE_ALLOW_RUN=1
 *   STRUMMER_COVERAGE_PROJECT_ROOTS=/abs/project,/abs/other
 *   STRUMMER_COVERAGE_TIMEOUT_MS=120000
 */
export function buildCoverageServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltCoverageServer {
  const timeoutRaw = env.STRUMMER_COVERAGE_TIMEOUT_MS
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw.trim() !== '' ? Number(timeoutRaw) : undefined
  const config: CoverageBinConfig = {
    allowRun: bool(env.STRUMMER_COVERAGE_ALLOW_RUN),
    allowedRoots: csv(env.STRUMMER_COVERAGE_PROJECT_ROOTS),
    timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  }
  const server = createCoverageServer({
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    timeoutMs: config.timeoutMs,
  })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildCoverageServerFromEnv()
  await server.connect(new StdioServerTransport())
}
