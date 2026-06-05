#!/usr/bin/env node
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isMainModule } from './is-main.js'
import { createMutateServer, type MutateToolsOptions, registerMutateTools } from './mutate.js'
import type { PillarSetup } from './pillars.js'

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

/** Parse the operator env into the mutate bin config (single source of truth). */
export function mutateConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MutateBinConfig {
  const timeoutRaw = env.SACKVILLE_MUTATE_TIMEOUT_MS
  const timeoutMs =
    timeoutRaw !== undefined && timeoutRaw.trim() !== '' ? Number(timeoutRaw) : undefined
  return {
    allowRun: bool(env.SACKVILLE_MUTATE_ALLOW_RUN),
    allowedRoots: csv(env.SACKVILLE_MUTATE_PROJECT_ROOTS),
    timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    reportPath: env.SACKVILLE_MUTATE_REPORT_PATH || undefined,
  }
}

function mutateOptions(config: MutateBinConfig): MutateToolsOptions {
  return {
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    timeoutMs: config.timeoutMs,
    reportPath: config.reportPath,
  }
}

/**
 * The aggregate-composition seam (ADR 0019): parse env, return a {@link PillarSetup}
 * that registers the mutate tools onto a (possibly shared) server. Mutate owns no
 * long-lived resources, so there is no `shutdown`.
 */
export function setupMutateFromEnv(
  env: Record<string, string | undefined> = process.env,
): PillarSetup {
  const opts = mutateOptions(mutateConfigFromEnv(env))
  return { register: (server) => registerMutateTools(server, opts) }
}

/**
 * Build the mutate MCP server from operator env. `mutate_summarize` (read-only) is always
 * available; `mutate_run` runs Stryker, so it is enabled only with the paired gate — BOTH
 * a truthy `SACKVILLE_MUTATE_ALLOW_RUN` and a non-empty `SACKVILLE_MUTATE_PROJECT_ROOTS`:
 *   SACKVILLE_MUTATE_ALLOW_RUN=1
 *   SACKVILLE_MUTATE_PROJECT_ROOTS=/abs/project,/abs/other
 *   SACKVILLE_MUTATE_TIMEOUT_MS=1800000
 *   SACKVILLE_MUTATE_REPORT_PATH=/abs/project/reports/mutation/mutation.json
 */
export function buildMutateServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltMutateServer {
  const config = mutateConfigFromEnv(env)
  const server = createMutateServer(mutateOptions(config))
  return { server, config }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (isMainModule(import.meta.url)) {
  const { server } = buildMutateServerFromEnv()
  await server.connect(new StdioServerTransport())
}
