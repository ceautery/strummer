#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ArtifactStore } from '@strummer/artifacts'
import { detectInstalledVersion, type Ecosystem } from '@strummer/core'
import {
  defaultListFiles,
  LanguageServerManager,
  LspQueryEngine,
  LspRenameEngine,
  parseServerRegistry,
  type ServerRegistry,
} from '@strummer/lsp'
import { createLspServer, type ToolchainDetector } from './lsp.js'

/** Parsed, operator-set configuration for the LSP MCP bin (set at launch). */
export interface LspBinConfig {
  /** Enable the navigation tools (deny-by-default — they need a live, code-executing daemon). */
  allowRun: boolean
  /** Enable `lsp_rename` to WRITE edits to disk (deny-by-default). Requires allowRun. */
  allowWrite: boolean
  /** Apply a rename even when the completeness guard flags it `suspect` (open-files-scoped server
   * → likely partial edit). Deny-by-default: a suspect rename is refused for write without this. */
  allowPartialRename: boolean
  /** Apply a DESTRUCTIVE resource op — `overwrite` on a CreateFile/RenameFile (truncate-and-replace
   * an existing regular file). Deny-by-default; requires allowWrite. Recursive/dir delete +
   * symlink/dir targets stay refused even when set. */
  allowDestructiveResourceOps: boolean
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
 *   STRUMMER_LSP_ALLOW_WRITE=1   # lets lsp_rename WRITE edits to disk; default off = dry-run only.
 *                                # Requires STRUMMER_LSP_ALLOW_RUN (hard startup error otherwise).
 *   STRUMMER_LSP_ALLOW_PARTIAL_RENAME=1  # apply a rename the completeness guard flags `suspect`
 *                                # (an open-files-scoped server like pyright → likely partial edit);
 *                                # default off = a suspect rename is refused for write.
 *   STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS=1  # apply a server `overwrite` on a Create/Rename
 *                                # (truncate-and-replace an EXISTING regular file). Default off.
 *                                # Requires STRUMMER_LSP_ALLOW_WRITE (hard startup error otherwise).
 *                                # A symlink/directory target, recursive/dir delete, and `overwrite`
 *                                # on a delete STAY refused even when set.
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
    allowWrite: bool(env.STRUMMER_LSP_ALLOW_WRITE),
    allowPartialRename: bool(env.STRUMMER_LSP_ALLOW_PARTIAL_RENAME),
    allowDestructiveResourceOps: bool(env.STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS),
    allowedRoots: csv(env.STRUMMER_LSP_PROJECT_ROOTS),
    timeoutMs: num(env.STRUMMER_LSP_TIMEOUT_MS),
    registry,
    artifactDir: env.STRUMMER_LSP_ARTIFACT_DIR || undefined,
    maxServers: num(env.STRUMMER_LSP_MAX_SERVERS),
    idleTtlMs: num(env.STRUMMER_LSP_IDLE_TTL_MS),
  }

  // allowWrite implies allowRun — you cannot apply an edit without a live server computing it.
  // Reject the contradictory combination LOUDLY at startup rather than silently ignoring it.
  if (config.allowWrite && !config.allowRun) {
    throw new Error('STRUMMER_LSP_ALLOW_WRITE requires STRUMMER_LSP_ALLOW_RUN')
  }
  // A destructive overwrite is meaningless without write-mode; reject the contradiction loudly.
  if (config.allowDestructiveResourceOps && !config.allowWrite) {
    throw new Error('STRUMMER_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS requires STRUMMER_LSP_ALLOW_WRITE')
  }

  const artifacts =
    config.artifactDir !== undefined ? new ArtifactStore(config.artifactDir, 'lsp') : undefined

  // A registry is required to spawn anything; without one only lsp_languages (empty) is useful.
  let manager: LanguageServerManager | undefined
  let query: LspQueryEngine | undefined
  let renameEngine: LspRenameEngine | undefined
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
    renameEngine = new LspRenameEngine({
      manager,
      allowRun: config.allowRun,
      allowedRoots: config.allowedRoots,
      allowWrite: config.allowWrite,
      allowPartialRename: config.allowPartialRename,
      allowDestructiveResourceOps: config.allowDestructiveResourceOps,
      // Wire the real source-tree walker so the partial-rename guard is ACTIVE on this surface
      // (it is inert in the engine until a lister is provided — cf. the redactor).
      listFiles: defaultListFiles,
      // default stage-then-commit writer; LSP has no operator secret source (the only surfaced
      // content is the renamed identifier token), so the engine's identity redactor is used.
    })
  }

  const engine = query
  const writeEngine = renameEngine
  const liveManager = manager
  const server = createLspServer({
    registry: config.registry,
    allowRun: config.allowRun,
    allowedRoots: config.allowedRoots,
    artifacts,
    detectToolchain,
    ...(engine ? { query: (input) => engine.query(input) } : {}),
    ...(writeEngine ? { rename: (input) => writeEngine.rename(input) } : {}),
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
