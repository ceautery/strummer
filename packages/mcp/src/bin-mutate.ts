#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMutateServer } from './mutate.js'

/** Parsed, operator-set configuration for the mutate MCP bin (set at launch). */
export interface MutateBinConfig {
  /** Enable mutate_run (deny-by-default — it runs Stryker over the project). */
  allowRun: boolean
  /** Project roots mutate_run may execute in. */
  allowedRoots: string[]
  /** Wall-clock cap for a mutation run (ms), or undefined for none. */
  timeoutMs?: number
  /** Override the Stryker JSON report path, or undefined for the Stryker default. */
  reportPath?: string
}

export interface BuiltMutateServer {
  server: McpServer
  config: MutateBinConfig
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
 * Build the mutate MCP server from operator env. `mutate_summarize` (read-only) is always
 * available; `mutate_run` runs Stryker, so it is enabled only with the paired gate — BOTH
 * a truthy `STRUMMER_MUTATE_ALLOW_RUN` and a non-empty `STRUMMER_MUTATE_PROJECT_ROOTS`:
 *   STRUMMER_MUTATE_ALLOW_RUN=1
 *   STRUMMER_MUTATE_PROJECT_ROOTS=/abs/project,/abs/other
 *   STRUMMER_MUTATE_TIMEOUT_MS=1800000
 *   STRUMMER_MUTATE_REPORT_PATH=/abs/project/reports/mutation/mutation.json
 */
export function buildMutateServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltMutateServer {
  const timeoutRaw = env.STRUMMER_MUTATE_TIMEOUT_MS
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw.trim() !== '' ? Number(timeoutRaw) : undefined
  const config: MutateBinConfig = {
    allowRun: bool(env.STRUMMER_MUTATE_ALLOW_RUN),
    allowedRoots: csv(env.STRUMMER_MUTATE_PROJECT_ROOTS),
    timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    reportPath: env.STRUMMER_MUTATE_REPORT_PATH || undefined,
  }
  const server = createMutateServer({
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    timeoutMs: config.timeoutMs,
    reportPath: config.reportPath,
  })
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = buildMutateServerFromEnv()
  await server.connect(new StdioServerTransport())
}
