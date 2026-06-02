import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  LanguageServerManager,
  LspGateError,
  LspQueryEngine,
  type LspQueryInput,
  type LspQueryKind,
  type LspQueryResult,
  LspRenameEngine,
  type LspRenameInput,
  type LspRenameResult,
  parseServerRegistry,
  type ResultDiagnostic,
  type ResultSymbol,
  type ResultWorkspaceSymbol,
  type ServerDescription,
  type ServerRegistry,
} from '@strummer/lsp'
import type { CliIO } from './index.js'

/** Injected (test) or real engine entries. */
type QueryFn = (input: LspQueryInput) => Promise<LspQueryResult>
type RenameFn = (input: LspRenameInput) => Promise<LspRenameResult>
type DescribeFn = () => ServerDescription[]

export interface LspDeps {
  query?: QueryFn
  rename?: RenameFn
  describeServers?: DescribeFn
}

/**
 * `strummer lsp` — the human surface over `@strummer/lsp`. Single-shot semantic code
 * navigation: each invocation binds the operator's server registry, drives one query against
 * a live Language Server subprocess, then shuts it down.
 *
 * The human IS the operator, so the gates are straight-through flags: `--allow-run` (required
 * for any navigation — it spawns a code-executing indexing daemon, ADR 0011's
 * load-bearing gate) and `--allow-write` (lets `rename` write to disk; default = dry-run
 * preview). The typed `--project` root is the allowlist (explicit operator intent). Per ADR
 * 0011 the engine is **injectable** so the suite never spawns a real server — the production
 * path builds the real `LanguageServerManager`/`LspQueryEngine`/`LspRenameEngine` from flags
 * (mirroring `strummer-lsp-mcp`), and the gate throws *before* any spawn when `--allow-run` is
 * absent.
 *
 * Exit codes: 0 = the query ran (`ok`/`no_result`, or a rename preview/apply); 1 = denied,
 * refused, or error; 2 = `not_ready` (the server was still indexing — retry shortly).
 */
export async function runLsp(args: string[], io: CliIO, deps: LspDeps = {}): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'languages':
      return cmdLanguages(rest, io, deps)
    case 'definition':
      return cmdQuery('definition', rest, io, deps)
    case 'type-definition':
      return cmdQuery('typeDefinition', rest, io, deps)
    case 'references':
      return cmdQuery('references', rest, io, deps)
    case 'hover':
      return cmdQuery('hover', rest, io, deps)
    case 'symbols':
      return cmdQuery('documentSymbols', rest, io, deps)
    case 'diagnostics':
      return cmdQuery('diagnostics', rest, io, deps)
    case 'workspace-symbols':
      return cmdWorkspaceSymbols(rest, io, deps)
    case 'call-hierarchy':
      return cmdQuery('callHierarchy', rest, io, deps)
    case 'rename':
      return cmdRename(rest, io, deps)
    default:
      io.err(`unknown lsp subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

const GATE_OPTIONS = {
  project: { type: 'string' },
  servers: { type: 'string' },
  'allow-run': { type: 'boolean' },
  'allow-write': { type: 'boolean' },
  'timeout-ms': { type: 'string' },
  json: { type: 'boolean' },
} as const

function num(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

interface Engines {
  query: QueryFn
  rename: RenameFn
  describeServers: DescribeFn
  shutdown: () => Promise<void>
  projectRoot: string
}

/**
 * Build the query/rename engines — injected stubs in tests, else the real manager + engines
 * from the operator registry (`--servers`/`STRUMMER_LSP_SERVERS`), gated by `--allow-run` /
 * `--allow-write` and confined to the `--project` root. Returns null on a config error (the
 * caller has already had the message written).
 */
function makeEngines(values: Record<string, unknown>, io: CliIO, deps: LspDeps): Engines | null {
  const projectRoot = resolve((values.project as string) ?? process.cwd())
  if (deps.query || deps.rename || deps.describeServers) {
    return {
      query: deps.query ?? (async () => fail('query')),
      rename: deps.rename ?? (async () => fail('rename')),
      describeServers: deps.describeServers ?? (() => []),
      shutdown: async () => {},
      projectRoot,
    }
  }
  const raw = (values.servers as string) ?? io.env?.STRUMMER_LSP_SERVERS
  if (!raw || raw.trim() === '') {
    io.err('no servers bound: pass --servers <json> or set STRUMMER_LSP_SERVERS\n')
    return null
  }
  let registry: ServerRegistry
  try {
    registry = parseServerRegistry(raw)
  } catch (e) {
    io.err(`invalid --servers registry: ${(e as Error).message}\n`)
    return null
  }
  const allowedRoots = [projectRoot]
  const manager = new LanguageServerManager({
    registry,
    allowedRoots,
    timeoutMs: num(values['timeout-ms'] as string) ?? 15_000,
  })
  const query = new LspQueryEngine({
    manager,
    allowRun: (values['allow-run'] as boolean) ?? false,
    allowedRoots,
  })
  const rename = new LspRenameEngine({
    manager,
    allowRun: (values['allow-run'] as boolean) ?? false,
    allowedRoots,
    allowWrite: (values['allow-write'] as boolean) ?? false,
  })
  return {
    query: (input) => query.query(input),
    rename: (input) => rename.rename(input),
    describeServers: () => manager.describe(),
    shutdown: () => manager.shutdown(),
    projectRoot,
  }
}

function fail(what: string): never {
  throw new Error(`no ${what} engine available`)
}

function cmdLanguages(args: string[], io: CliIO, deps: LspDeps): number {
  const { values } = parseArgs({ args, allowPositionals: true, options: GATE_OPTIONS })
  const raw = (values.servers as string) ?? io.env?.STRUMMER_LSP_SERVERS
  let languages: string[] = []
  if (raw && raw.trim() !== '') {
    try {
      languages = Object.keys(parseServerRegistry(raw)).sort()
    } catch (e) {
      io.err(`invalid --servers registry: ${(e as Error).message}\n`)
      return 1
    }
  }
  const servers = (deps.describeServers ?? (() => []))()
  if (values.json) {
    io.out(`${JSON.stringify({ languages, servers }, null, 2)}\n`)
    return 0
  }
  io.out(languages.length ? `bound languages: ${languages.join(', ')}\n` : 'no languages bound\n')
  for (const s of servers) {
    const v = s.serverInfo
      ? `${s.serverInfo.name}${s.serverInfo.version ? ` ${s.serverInfo.version}` : ''}`
      : '(no serverInfo)'
    io.out(`  ${s.language} @ ${s.projectRoot}  ${v}\n`)
  }
  return 0
}

/** Tri-state status → exit code (ok/no_result ran; not_ready is transient). */
function statusExit(status: string): number {
  return status === 'not_ready' ? 2 : 0
}

function rangeStr(r: {
  start: { line: number; column: number }
  end: { line: number; column: number }
}): string {
  return `${r.start.line}:${r.start.column}-${r.end.line}:${r.end.column}`
}

function printHeader(io: CliIO, r: LspQueryResult): void {
  const info = r.serverInfo
    ? `${r.serverInfo.name}${r.serverInfo.version ? ` ${r.serverInfo.version}` : ''}`
    : 'unknown server'
  io.out(`status: ${r.status}  [${r.kind}, ${r.encoding}, ${info}]\n`)
  if (r.versionWarning) io.err(`warning: ${r.versionWarning}\n`)
}

function printSymbols(io: CliIO, symbols: ResultSymbol[], depth: number): void {
  for (const s of symbols) {
    const detail = s.detail ? `  ${s.detail}` : ''
    io.out(`${'  '.repeat(depth + 1)}${s.name}  [${s.kindName}]  ${rangeStr(s.range)}${detail}\n`)
    if (s.children && s.children.length > 0) printSymbols(io, s.children, depth + 1)
  }
}

async function cmdQuery(
  kind: LspQueryKind,
  args: string[],
  io: CliIO,
  deps: LspDeps,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...GATE_OPTIONS, direction: { type: 'string' } },
  })
  const positionLess = kind === 'documentSymbols' || kind === 'diagnostics'
  const [language, file, lineRaw, colRaw] = positionals
  if (!language || !file || (!positionLess && (lineRaw === undefined || colRaw === undefined))) {
    io.err(
      positionLess
        ? `lsp ${kindCommand(kind)} needs <language> <file>\n`
        : `lsp ${kindCommand(kind)} needs <language> <file> <line> <column>\n`,
    )
    return 1
  }

  const engines = makeEngines(values, io, deps)
  if (!engines) return 1
  try {
    const input: LspQueryInput = {
      language,
      projectRoot: engines.projectRoot,
      file,
      kind,
      ...(positionLess ? {} : { line: Number(lineRaw), column: Number(colRaw) }),
      ...(kind === 'callHierarchy'
        ? { direction: (values.direction as 'incoming' | 'outgoing') ?? 'incoming' }
        : {}),
    }
    const result = await engines.query(input)

    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      return statusExit(result.status)
    }

    printHeader(io, result)
    if (result.status === 'not_ready') {
      io.out('the server is still indexing — retry shortly\n')
      return 2
    }
    if (kind === 'hover') {
      io.out(result.hover ? `${result.hover.value}\n` : 'no hover info\n')
    } else if (kind === 'documentSymbols') {
      const symbols = result.symbols ?? []
      io.out(`${symbols.length} symbol(s):\n`)
      printSymbols(io, symbols, 0)
    } else if (kind === 'diagnostics') {
      const diags = result.diagnostics ?? []
      io.out(`${diags.length} diagnostic(s):\n`)
      for (const d of diags) {
        printDiagnostic(io, d)
      }
    } else if (kind === 'callHierarchy') {
      const groups = result.callHierarchy ?? []
      for (const g of groups) {
        io.out(`${g.source.name}  [${g.source.kindName}]  (${g.direction})\n`)
        for (const c of g.calls) {
          io.out(`  ${c.item.name}  ${c.item.uri}  ${c.fromRanges.map(rangeStr).join(', ')}\n`)
        }
      }
    } else {
      const locations = result.locations ?? []
      io.out(`${locations.length} location(s):\n`)
      for (const loc of locations) {
        io.out(`  ${loc.uri}  ${rangeStr(loc.range)}${loc.mapped ? '' : '  (unmapped)'}\n`)
      }
    }
    return statusExit(result.status)
  } catch (e) {
    if (e instanceof LspGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  } finally {
    await engines.shutdown()
  }
}

/**
 * `workspace-symbols <language> <query> [anchorFile]` — position-less project-wide symbol search.
 * The optional `[anchorFile]` is opened first to establish the project; pass it for servers (like
 * `typescript-language-server`) that only build a project once a file is open.
 */
async function cmdWorkspaceSymbols(args: string[], io: CliIO, deps: LspDeps): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: GATE_OPTIONS })
  const [language, query, anchorFile] = positionals
  if (!language || query === undefined) {
    io.err('lsp workspace-symbols needs <language> <query> [anchorFile]\n')
    return 1
  }

  const engines = makeEngines(values, io, deps)
  if (!engines) return 1
  try {
    const result = await engines.query({
      language,
      projectRoot: engines.projectRoot,
      kind: 'workspaceSymbol',
      query,
      ...(anchorFile !== undefined ? { file: anchorFile } : {}),
    })

    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      return statusExit(result.status)
    }

    printHeader(io, result)
    if (result.status === 'not_ready') {
      io.out('the server is still indexing — retry shortly\n')
      return 2
    }
    const symbols = result.workspaceSymbols ?? []
    io.out(`${symbols.length} symbol(s):\n`)
    for (const s of symbols) {
      printWorkspaceSymbol(io, s)
    }
    return statusExit(result.status)
  } catch (e) {
    if (e instanceof LspGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  } finally {
    await engines.shutdown()
  }
}

function printDiagnostic(io: CliIO, d: ResultDiagnostic): void {
  const sev = d.severityName ?? (d.severity !== undefined ? `severity ${d.severity}` : 'Diagnostic')
  const where = `${d.range.start.line}:${d.range.start.column}`
  const code = d.code !== undefined ? ` [${d.source ? `${d.source} ` : ''}${d.code}]` : ''
  io.out(`  ${where}  ${sev}${code}  ${d.message}\n`)
  for (const r of d.related ?? []) {
    io.out(`      ↳ ${r.uri} ${r.range.start.line}:${r.range.start.column}  ${r.message}\n`)
  }
}

function printWorkspaceSymbol(io: CliIO, s: ResultWorkspaceSymbol): void {
  const container = s.container ? `  (in ${s.container})` : ''
  const loc = s.range ? `  ${rangeStr(s.range)}${s.mapped ? '' : '  (unmapped)'}` : ''
  io.out(`  ${s.name}  [${s.kindName}]  ${s.uri}${loc}${container}\n`)
}

/** Map a query kind back to its CLI subcommand name (for error messages). */
function kindCommand(kind: LspQueryKind): string {
  if (kind === 'typeDefinition') return 'type-definition'
  if (kind === 'documentSymbols') return 'symbols'
  if (kind === 'callHierarchy') return 'call-hierarchy'
  return kind
}

async function cmdRename(args: string[], io: CliIO, deps: LspDeps): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: GATE_OPTIONS,
  })
  const [language, file, lineRaw, colRaw, newName] = positionals
  if (!language || !file || lineRaw === undefined || colRaw === undefined || !newName) {
    io.err('lsp rename needs <language> <file> <line> <column> <newName>\n')
    return 1
  }
  const engines = makeEngines(values, io, deps)
  if (!engines) return 1
  try {
    const result = await engines.rename({
      language,
      projectRoot: engines.projectRoot,
      file,
      line: Number(lineRaw),
      column: Number(colRaw),
      newName,
    })

    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      printRename(io, result)
    }
    if (result.status === 'not_ready') return 2
    if (result.refused) return 1
    return 0
  } catch (e) {
    if (e instanceof LspGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  } finally {
    await engines.shutdown()
  }
}

function printRename(io: CliIO, r: LspRenameResult): void {
  const info = r.serverInfo
    ? `${r.serverInfo.name}${r.serverInfo.version ? ` ${r.serverInfo.version}` : ''}`
    : 'unknown server'
  const mode = r.applied ? 'APPLIED to disk' : 'dry-run (not applied)'
  io.out(`status: ${r.status}  ${mode}  [${r.encoding}, ${info}]\n`)
  if (r.versionWarning) io.err(`warning: ${r.versionWarning}\n`)
  if (r.refused) {
    io.err(`refused: ${r.refused}\n`)
    return
  }
  io.out(`rename → ${r.newName}: ${r.totalEditCount} edit(s) across ${r.fileCount} file(s)\n`)
  for (const f of r.edits) {
    io.out(`  ${f.file}  ${f.editCount} edit(s)${f.outOfRoot ? '  (out of project root)' : ''}\n`)
    for (const h of f.hunks ?? []) {
      io.out(`    ${rangeStr(h.range)}  ${h.oldText} → ${h.newText}\n`)
    }
  }
  for (const d of r.digests ?? []) {
    io.out(`  digest ${d.file}: ${d.before.slice(0, 12)} → ${d.after.slice(0, 12)}\n`)
  }
}
