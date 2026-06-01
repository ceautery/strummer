#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ArtifactStore } from '@strummer/artifacts'
import { detectInstalledVersion, type Ecosystem } from '@strummer/core'
import {
  LanguageServerManager,
  LspQueryEngine,
  parseServerRegistry,
  type ServerRegistry,
} from '@strummer/lsp'
import { createLspServer, type ToolchainDetector } from './lsp.js'

/** Parsed, operator-set configuration for the LSP MCP bin (set at launch). */
export interface LspBinConfig {
  /** Enable the navigation tools (deny-by-default — they need a live, code-executing daemon). */
  allowRun: boolean
  /** Project roots a server may be initialized against (load-bearing even with allowRun). */
  allowedRoots: string[]
  /** Per-request wall-clock cap (ms), or undefined for the manager default. */
  timeoutMs?: number
  /** The operator language→server registry, or undefined when none was bound. */
  registry?: ServerRegistry
  /** Directory backing the by-handle reference-list output (and the resource). */
  artifactDir?: string
  /** Max concurrent servers, or undefined for the manager default. */
  maxServers?: number
  /** Idle TTL (ms) before a server is reaped, or undefined for the manager default. */
  idleTtlMs?: number
}

export interface BuiltLspServer {
  server: McpServer
  config: LspBinConfig
  /** The live manager (present only when a registry was bound), for reaper + shutdown. */
  manager?: LanguageServerManager
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
 * Map a language to the toolchain package whose installed version makes a server answer
 * version-attributable (honoring "answer for the installed version"). Only the node-detectable
 * toolchains are mapped; others yield no toolchain provenance (the warn-on-mismatch heuristic
 * stays conservative rather than guessing).
 */
const LANGUAGE_TOOLCHAIN: Record<string, { pkg: string; ecosystem: Ecosystem }> = {
  typescript: { pkg: 'typescript', ecosystem: 'node' },
  typescriptreact: { pkg: 'typescript', ecosystem: 'node' },
  javascript: { pkg: 'typescript', ecosystem: 'node' },
  javascriptreact: { pkg: 'typescript', ecosystem: 'node' },
}

const detectToolchain: ToolchainDetector = (projectRoot, language) => {
  const mapping = LANGUAGE_TOOLCHAIN[language]
  if (!mapping) return undefined
  const detected = detectInstalledVersion(projectRoot, mapping.pkg, {
    ecosystem: mapping.ecosystem,
  })
  return { name: mapping.pkg, version: detected.version }
}

/**
 * Build the LSP MCP server from operator env. `lsp_languages` is always available; the
 * navigation tools (`lsp_find_definition`/`_references`/`_hover`) run a live indexing daemon, so
 * they are enabled only with the full gate — a truthy `STRUMMER_LSP_ALLOW_RUN`, a non-empty
 * `STRUMMER_LSP_PROJECT_ROOTS` allowlist, AND a non-empty `STRUMMER_LSP_SERVERS` registry:
 *   STRUMMER_LSP_ALLOW_RUN=1
 *   STRUMMER_LSP_PROJECT_ROOTS=/abs/project,/abs/other
 *   STRUMMER_LSP_SERVERS='{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}'
 *   STRUMMER_LSP_TIMEOUT_MS=15000
 *   STRUMMER_LSP_ARTIFACT_DIR=/var/lib/strummer/lsp   # backs by-handle reference lists
 *   STRUMMER_LSP_MAX_SERVERS=8
 *   STRUMMER_LSP_IDLE_TTL_MS=900000
 */
export function buildLspServerFromEnv(
  env: Record<string, string | undefined> = process.env,
): BuiltLspServer {
  const serversRaw = env.STRUMMER_LSP_SERVERS
  const registry =
    serversRaw && serversRaw.trim() !== '' ? parseServerRegistry(serversRaw) : undefined

  const config: LspBinConfig = {
    allowRun: bool(env.STRUMMER_LSP_ALLOW_RUN),
    allowedRoots: csv(env.STRUMMER_LSP_PROJECT_ROOTS),
    timeoutMs: num(env.STRUMMER_LSP_TIMEOUT_MS),
    registry,
    artifactDir: env.STRUMMER_LSP_ARTIFACT_DIR || undefined,
    maxServers: num(env.STRUMMER_LSP_MAX_SERVERS),
    idleTtlMs: num(env.STRUMMER_LSP_IDLE_TTL_MS),
  }

  const artifacts =
    config.artifactDir !== undefined ? new ArtifactStore(config.artifactDir, 'lsp') : undefined

  // A registry is required to spawn anything; without one only lsp_languages (empty) is useful.
  let manager: LanguageServerManager | undefined
  let query: LspQueryEngine | undefined
  if (config.registry !== undefined) {
    manager = new LanguageServerManager({
      registry: config.registry,
      serverSpawn: undefined, // defaults to the real child_process.spawn
      allowedRoots: config.allowedRoots,
      timeoutMs: config.timeoutMs ?? 15_000,
      ...(config.idleTtlMs !== undefined ? { idleTtlMs: config.idleTtlMs } : {}),
      ...(config.maxServers !== undefined ? { maxServers: config.maxServers } : {}),
    })
    query = new LspQueryEngine({
      manager,
      allowRun: config.allowRun,
      allowedRoots: config.allowedRoots,
    })
  }

  const engine = query
  const liveManager = manager
  const server = createLspServer({
    registry: config.registry,
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    artifacts,
    detectToolchain,
    ...(engine ? { query: (input) => engine.query(input) } : {}),
    ...(liveManager ? { describeServers: () => liveManager.describe() } : {}),
  })

  return { server, config, manager }
}

// Executable tail: only run when invoked directly (not when imported by a test).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, manager } = buildLspServerFromEnv()
  manager?.startReaper(60_000)
  const shutdown = async () => {
    await manager?.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await server.connect(new StdioServerTransport())
}
