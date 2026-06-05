import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ArtifactStore } from '@sackville/artifacts'
import type {
  LspQueryInput,
  LspQueryKind,
  LspQueryResult,
  LspRenameInput,
  LspRenameResult,
  ServerDescription,
  ServerRegistry,
} from '@sackville/lsp'
import { z } from 'zod'

/**
 * The `@sackville/lsp` MCP surface (ADR 0011, slice 5) — pure wiring over an injected gated
 * query engine + the manager's `describe`. There is **no free-read tier**: every navigation
 * answer requires a live, code-executing, indexing daemon, so `lsp_find_definition`/
 * `lsp_find_references`/`lsp_hover` are registered **as a group** only when the operator set
 * `allowRun` + a non-empty `allowedRoots` allowlist + a non-empty server registry. The single
 * always-on, no-spawn tool is `lsp_languages` (reports the bound languages and, once a server
 * has initialized in-session, its capabilities + `serverInfo.version` — **never** the
 * command/path). Large reference lists return a compact head inline + the full list by handle
 * via `@sackville/artifacts` (`sackville://lsp/{id}/{kind}`, registered only when a store is set).
 */

/** Detects the project's toolchain version for a language (the bin wires `core.detectInstalledVersion`). */
export type ToolchainDetector = (
  projectRoot: string,
  language: string,
) => { name: string; version: string | null } | undefined

export interface LspToolsOptions {
  /** The operator registry — its keys are the bindable languages `lsp_languages` reports. */
  registry?: ServerRegistry
  /** Gate: navigation tools register only with allowRun + a non-empty allowlist + a registry. */
  allowRun?: boolean
  allowedRoots?: string[]
  /** The gated query engine's entry (injected; `bin-lsp` wires the real `LspQueryEngine`). */
  query?: (input: LspQueryInput) => Promise<LspQueryResult>
  /**
   * The gated rename engine's entry (injected; `bin-lsp` wires the real `LspRenameEngine`).
   * Present ⇒ `lsp_rename` registers (alongside navigation; both need `allowRun`). Whether a
   * rename APPLIES to disk vs returns a dry-run preview is the engine's internal decision
   * (the operator's `allowWrite`), never a tool input.
   */
  rename?: (input: LspRenameInput) => Promise<LspRenameResult>
  /** Live-server provenance for `lsp_languages` (injected; `bin-lsp` wires `manager.describe`). */
  describeServers?: () => ServerDescription[]
  /** Optional artifact store: enables by-handle large reference lists + the resource. */
  artifacts?: ArtifactStore
  /** Optional toolchain detector, echoed into the query as provenance. */
  detectToolchain?: ToolchainDetector
}

const INSTRUCTIONS = `Sackville drives a real Language Server as a subprocess for semantic code
navigation. \`lsp_languages\` (always available, no spawn) reports which languages the operator
bound a server for, plus — once a server is running — its advertised capabilities and version.

\`lsp_find_definition\`, \`lsp_type_definition\`, \`lsp_find_references\`, and \`lsp_hover\` (present
only when the operator enabled navigation) take a language + project root + file + 1-based
line:column; \`lsp_document_symbols\` takes just a file (the outline, no position); and
\`lsp_workspace_symbols\` takes just a query string (a project-wide symbol search by name — no file,
no position); and \`lsp_diagnostics\` takes just a file and lists its errors/warnings (an empty
result = a clean file). All return the answer with line:column mapped back to human coordinates. Positions are 1-based; columns count
Unicode code points. A result \`status\` is tri-state: "ok", "not_ready" (the server is still
indexing — retry shortly; NOT the same as no result), or "no_result". Navigation requires a live
indexing daemon, so it is operator-gated and confined to allowlisted project roots.

\`lsp_rename\` (write-mode, present only when navigation is) renames a symbol across the project.
It is DRY-RUN by default — it returns the proposed edit as a preview and writes nothing. The
operator must separately enable apply; \`applied\` in the result tells you whether the edit was
written to disk, and \`refused\` explains any non-apply. There is no input that turns writing on.`

const HEAD = 50 // inline at most this many locations; the rest go by handle.

/** Shared optional multi-root input field — additional allowlisted roots bound to the same server. */
const workspaceRootsField = {
  workspaceRoots: z
    .array(z.string())
    .optional()
    .describe(
      'OPTIONAL additional project roots to bind as workspace folders on the same server ' +
        '(multi-root, e.g. a monorepo) so cross-root navigation and rename resolve; each must ' +
        'be operator-allowlisted (an out-of-allowlist root is refused).',
    ),
}

/** Pull the optional `workspaceRoots` off tool args (spread into the query input when present). */
function wsRoots(args: Record<string, unknown>): { workspaceRoots?: string[] } {
  return args.workspaceRoots ? { workspaceRoots: args.workspaceRoots as string[] } : {}
}

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

// Servers whose reported `serverInfo.version` IS the language toolchain's version, so a differing
// MAJOR is a real "answering for the wrong version" signal. `typescript-language-server` is
// deliberately EXCLUDED — its `serverInfo.version` is the WRAPPER's, NOT the bundled tsserver, so a
// major-compare would mis-fire. A real cross-version resolution matrix (server↔toolchain) is staged.
const LANGUAGE_SERVER_IS_TOOLCHAIN = new Set(['rust-analyzer', 'gopls'])

function majorOf(v: string): number | undefined {
  const m = /\d+/.exec(v)
  return m ? Number(m[0]) : undefined
}

/**
 * A CONSERVATIVE warn-on-toolchain-mismatch (ADR 0011): only for a server whose version IS the
 * toolchain version (the allowlist — no guessing), only on a differing MAJOR, and never a hard
 * fail. Returns undefined otherwise. The engine's serverInfo-ABSENT `versionWarning` takes
 * precedence; this is the fallback when the engine emitted none (so we never double-warn).
 */
export function toolchainMismatchWarning(
  serverInfo: { name: string; version?: string | null } | undefined,
  toolchain: { name: string; version: string | null } | undefined,
): string | undefined {
  if (!serverInfo?.version || !toolchain?.version) return undefined
  if (!LANGUAGE_SERVER_IS_TOOLCHAIN.has(serverInfo.name)) return undefined
  const sv = majorOf(serverInfo.version)
  const tv = majorOf(toolchain.version)
  if (sv === undefined || tv === undefined || sv === tv) return undefined
  return `the language server reports version ${serverInfo.version} but the project's ${toolchain.name} toolchain is ${toolchain.version}; navigation/rename may not reflect the installed version`
}

/** The shared provenance/status envelope on every navigation result. */
function envelope(result: LspQueryResult) {
  const versionWarning =
    result.versionWarning ?? toolchainMismatchWarning(result.serverInfo, result.toolchain)
  return {
    status: result.status,
    kind: result.kind,
    encoding: result.encoding,
    ...(result.serverInfo ? { serverInfo: result.serverInfo } : {}),
    ...(result.toolchain ? { toolchain: result.toolchain } : {}),
    ...(versionWarning ? { versionWarning } : {}),
  }
}

/** Register the LSP tools. Navigation tools are gated as a group; `lsp_languages` is always on. */
export function registerLspTools(server: McpServer, opts: LspToolsOptions = {}): void {
  const languages = opts.registry ? Object.keys(opts.registry).sort() : []
  const describeServers = opts.describeServers ?? (() => [])

  // Always-on, no-spawn: which languages are bound + any live-server provenance. Reports the
  // language id, capabilities, and serverInfo — NEVER the operator command/argv/path.
  server.registerTool(
    'lsp_languages',
    {
      title: 'Bound languages + live server provenance',
      description:
        'READ-ONLY, no spawn: the languages the operator bound a server for, plus — for any ' +
        'server already running — its advertised capabilities and serverInfo.version. Never ' +
        'reports the server command or path.',
      inputSchema: {},
    },
    () => {
      const structured = { languages, servers: describeServers() }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  const allowedRoots = opts.allowedRoots ?? []
  const query = opts.query
  const navEnabled =
    Boolean(opts.allowRun) && allowedRoots.length > 0 && languages.length > 0 && query

  if (navEnabled && query) {
    let seq = 0
    const artifacts = opts.artifacts

    const positionSchema = {
      language: z.string().describe('a language bound in the operator registry'),
      projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
      file: z
        .string()
        .describe('the file to query, relative to projectRoot (or absolute within it)'),
      line: z.number().int().describe('1-based line'),
      column: z.number().int().describe('1-based column (counts Unicode code points)'),
    }
    // Read-navigation AND write-mode rename accept multi-root: edits confine to the allowlisted
    // root GROUP (primary ∪ workspaceRoots), so a cross-root rename in a monorepo applies.
    const navSchema = { ...positionSchema, ...workspaceRootsField }

    const runNavigation = async (kind: LspQueryKind, args: Record<string, unknown>) => {
      const language = args.language as string
      const projectRoot = args.projectRoot as string
      const toolchain = opts.detectToolchain?.(projectRoot, language)
      const result = await query({
        language,
        projectRoot,
        file: args.file as string,
        line: args.line as number,
        column: args.column as number,
        kind,
        ...wsRoots(args),
        ...(toolchain ? { toolchain } : {}),
      })

      if (kind === 'hover') {
        const structured = { ...envelope(result), hover: result.hover }
        return { content: [text(structured)], structuredContent: structured }
      }

      const locations = result.locations ?? []
      let structured: Record<string, unknown> = {
        ...envelope(result),
        locationCount: locations.length,
        locations,
      }
      // A long reference list is metadata, not a file body — but still capped inline; the full
      // list goes by handle when a store is configured (the deps/coverage rule).
      if (locations.length > HEAD && artifacts) {
        const id = `${kind}-${seq++}`
        const fullHandle = artifacts.put(
          id,
          'locations',
          JSON.stringify(locations, null, 2),
          'application/json',
        )
        structured = {
          ...envelope(result),
          locationCount: locations.length,
          locations: locations.slice(0, HEAD),
          truncated: true,
          fullHandle,
        }
      }
      return { content: [text(structured)], structuredContent: structured }
    }

    server.registerTool(
      'lsp_find_definition',
      {
        title: 'Go to definition',
        description:
          'Resolve the definition of the symbol at a 1-based line:column. Operator-gated ' +
          '(requires a live indexing server) and confined to allowlisted project roots. ' +
          'Returns tri-state status + locations mapped back to human 1-based line:column.',
        inputSchema: navSchema,
      },
      (args) => runNavigation('definition', args),
    )

    server.registerTool(
      'lsp_type_definition',
      {
        title: 'Go to type definition',
        description:
          'Resolve the TYPE definition of the symbol at a 1-based line:column (the declaration ' +
          "of the symbol's type — e.g. the class/interface a variable is an instance of, not " +
          'the variable). Operator-gated; tri-state status + locations in human 1-based line:column.',
        inputSchema: navSchema,
      },
      (args) => runNavigation('typeDefinition', args),
    )

    server.registerTool(
      'lsp_find_references',
      {
        title: 'Find references',
        description:
          'Find all references to the symbol at a 1-based line:column. Operator-gated and ' +
          'confined to allowlisted project roots. A large list is capped inline; the full list ' +
          'is returned by handle when an artifact store is configured.',
        inputSchema: navSchema,
      },
      (args) => runNavigation('references', args),
    )

    server.registerTool(
      'lsp_hover',
      {
        title: 'Hover',
        description:
          'Get the hover info (type/signature/docs) for the symbol at a 1-based line:column. ' +
          'Operator-gated and confined to allowlisted project roots.',
        inputSchema: navSchema,
      },
      (args) => runNavigation('hover', args),
    )

    server.registerTool(
      'lsp_document_symbols',
      {
        title: 'Document symbols (file outline)',
        description:
          'List the symbols declared in a file (classes/functions/methods/…), as a hierarchical ' +
          'outline with each range in human 1-based line:column. No position needed. Operator-' +
          'gated and confined to allowlisted project roots. A large outline is capped inline; the ' +
          'full tree is returned by handle when an artifact store is configured.',
        inputSchema: {
          language: z.string().describe('a language bound in the operator registry'),
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          file: z
            .string()
            .describe('the file to outline, relative to projectRoot (or absolute within it)'),
          ...workspaceRootsField,
        },
      },
      async (args) => {
        const language = args.language as string
        const projectRoot = args.projectRoot as string
        const toolchain = opts.detectToolchain?.(projectRoot, language)
        const result = await query({
          language,
          projectRoot,
          file: args.file as string,
          kind: 'documentSymbols',
          ...wsRoots(args),
          ...(toolchain ? { toolchain } : {}),
        })
        const symbols = result.symbols ?? []
        let structured: Record<string, unknown> = {
          ...envelope(result),
          symbolCount: symbols.length,
          symbols,
        }
        if (symbols.length > HEAD && artifacts) {
          const id = `documentSymbols-${seq++}`
          const fullHandle = artifacts.put(
            id,
            'symbols',
            JSON.stringify(symbols, null, 2),
            'application/json',
          )
          structured = {
            ...envelope(result),
            symbolCount: symbols.length,
            symbols: symbols.slice(0, HEAD),
            truncated: true,
            fullHandle,
          }
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )

    server.registerTool(
      'lsp_diagnostics',
      {
        title: 'Diagnostics (errors / warnings) for a file',
        description:
          'List the diagnostics (errors/warnings/hints) the language server reports for a file — ' +
          'each with severity, message, code/source, and range in human 1-based line:column. No ' +
          'position needed. PUSH model: the server publishes diagnostics after it analyses the open ' +
          'file, so a cold call waits out project indexing — status "not_ready" means retry shortly. ' +
          'An EMPTY result is a clean file (no problems). Operator-gated and confined to allowlisted ' +
          'project roots. A large list is capped inline; the full list is returned by handle when an ' +
          'artifact store is configured.',
        inputSchema: {
          language: z.string().describe('a language bound in the operator registry'),
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          file: z
            .string()
            .describe('the file to diagnose, relative to projectRoot (or absolute within it)'),
          ...workspaceRootsField,
        },
      },
      async (args) => {
        const language = args.language as string
        const projectRoot = args.projectRoot as string
        const toolchain = opts.detectToolchain?.(projectRoot, language)
        const result = await query({
          language,
          projectRoot,
          file: args.file as string,
          kind: 'diagnostics',
          ...wsRoots(args),
          ...(toolchain ? { toolchain } : {}),
        })
        const diagnostics = result.diagnostics ?? []
        let structured: Record<string, unknown> = {
          ...envelope(result),
          diagnosticCount: diagnostics.length,
          diagnostics,
        }
        if (diagnostics.length > HEAD && artifacts) {
          const id = `diagnostics-${seq++}`
          const fullHandle = artifacts.put(
            id,
            'diagnostics',
            JSON.stringify(diagnostics, null, 2),
            'application/json',
          )
          structured = {
            ...envelope(result),
            diagnosticCount: diagnostics.length,
            diagnostics: diagnostics.slice(0, HEAD),
            truncated: true,
            fullHandle,
          }
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )

    server.registerTool(
      'lsp_workspace_symbols',
      {
        title: 'Workspace symbol search',
        description:
          'Search the WHOLE project for symbols by name (classes/functions/methods/…). Takes a ' +
          'query string and NO position. Returns each match with its uri + range in human 1-based ' +
          'line:column. Operator-gated and confined to allowlisted project roots. A large result ' +
          'is capped inline; the full list is returned by handle when an artifact store is ' +
          'configured. Pass `file` (any file in the project) as an anchor when the server only ' +
          'builds a project once a file is open — typescript-language-server needs this; eager ' +
          'indexers (gopls, rust-analyzer) do not.',
        inputSchema: {
          language: z.string().describe('a language bound in the operator registry'),
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          query: z.string().describe('the symbol name (or fragment) to search for'),
          file: z
            .string()
            .optional()
            .describe(
              'optional anchor file (relative to projectRoot) to open so the project loads; ' +
                'required for typescript-language-server, unused by eager indexers',
            ),
          ...workspaceRootsField,
        },
      },
      async (args) => {
        const language = args.language as string
        const projectRoot = args.projectRoot as string
        const toolchain = opts.detectToolchain?.(projectRoot, language)
        const result = await query({
          language,
          projectRoot,
          query: args.query as string,
          ...(args.file !== undefined ? { file: args.file as string } : {}),
          kind: 'workspaceSymbol',
          ...wsRoots(args),
          ...(toolchain ? { toolchain } : {}),
        })
        const symbols = result.workspaceSymbols ?? []
        let structured: Record<string, unknown> = {
          ...envelope(result),
          symbolCount: symbols.length,
          workspaceSymbols: symbols,
        }
        if (symbols.length > HEAD && artifacts) {
          const id = `workspaceSymbol-${seq++}`
          const fullHandle = artifacts.put(
            id,
            'workspace-symbols',
            JSON.stringify(symbols, null, 2),
            'application/json',
          )
          structured = {
            ...envelope(result),
            symbolCount: symbols.length,
            workspaceSymbols: symbols.slice(0, HEAD),
            truncated: true,
            fullHandle,
          }
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )

    server.registerTool(
      'lsp_call_hierarchy',
      {
        title: 'Call hierarchy (callers / callees)',
        description:
          'Resolve the symbol at a 1-based line:column and list its callers (`direction: ' +
          '"incoming"`, the default) or callees (`direction: "outgoing"`), each with the call-site ' +
          'ranges in human 1-based line:column. Operator-gated; tri-state status. Overloaded ' +
          'symbols yield multiple groups (all kept). A large result goes by handle when a store is set.',
        inputSchema: {
          ...navSchema,
          direction: z
            .enum(['incoming', 'outgoing'])
            .optional()
            .describe('callers ("incoming", default) or callees ("outgoing")'),
        },
      },
      async (args) => {
        const language = args.language as string
        const projectRoot = args.projectRoot as string
        const toolchain = opts.detectToolchain?.(projectRoot, language)
        const result = await query({
          language,
          projectRoot,
          file: args.file as string,
          line: args.line as number,
          column: args.column as number,
          kind: 'callHierarchy',
          direction: (args.direction as 'incoming' | 'outgoing') ?? 'incoming',
          ...wsRoots(args),
          ...(toolchain ? { toolchain } : {}),
        })
        const groups = result.callHierarchy ?? []
        const callCount = groups.reduce((n, g) => n + g.calls.length, 0)
        // Call-hierarchy edges are bounded metadata (a symbol's direct callers/callees), so they
        // are inlined in full — unlike a reference list, there is no large-body case to offload.
        const structured = {
          ...envelope(result),
          direction: args.direction ?? 'incoming',
          callCount,
          callHierarchy: groups,
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )

    // Write-mode (ADR 0011 addendum). Present whenever navigation is (rename needs a live server).
    // DRY-RUN vs APPLY is the engine's internal decision (operator allowWrite) — NOT a tool input.
    const rename = opts.rename
    if (rename) {
      server.registerTool(
        'lsp_rename',
        {
          title: 'Rename a symbol (write)',
          description:
            'Rename the symbol at a 1-based line:column to `newName` across the project. DRY-RUN ' +
            'by default: returns the proposed edit (per-file hunks, old→new) with NO disk writes. ' +
            'The operator separately enables apply (allowWrite); when enabled the edit is written ' +
            'to disk — single- or multi-file, atomically, INCLUDING file create/rename/delete ' +
            '(e.g. a module rename that renames its backing file) — and per-file SHA-256 digests ' +
            'are returned. `applied` says which happened; `refused` explains any non-apply (not ' +
            'renameable, out-of-root, drift, an unsupported v1 cut); `partial` flags a terminal ' +
            'mid-commit fault (reconcile via VCS). Tri-state status. No tool input can turn ' +
            'writing on.',
          inputSchema: {
            ...positionSchema,
            newName: z.string().describe('the new identifier for the symbol'),
            ...workspaceRootsField,
          },
        },
        async (args) => {
          const language = args.language as string
          const projectRoot = args.projectRoot as string
          const toolchain = opts.detectToolchain?.(projectRoot, language)
          const result = await rename({
            language,
            projectRoot,
            file: args.file as string,
            line: args.line as number,
            column: args.column as number,
            newName: args.newName as string,
            ...wsRoots(args),
            ...(toolchain ? { toolchain } : {}),
          })
          const renameVersionWarning =
            result.versionWarning ?? toolchainMismatchWarning(result.serverInfo, result.toolchain)
          const head = {
            status: result.status,
            kind: result.kind,
            applied: result.applied,
            ...(result.refused ? { refused: result.refused } : {}),
            newName: result.newName,
            fileCount: result.fileCount,
            totalEditCount: result.totalEditCount,
            encoding: result.encoding,
            ...(result.serverInfo ? { serverInfo: result.serverInfo } : {}),
            ...(result.toolchain ? { toolchain: result.toolchain } : {}),
            ...(renameVersionWarning ? { versionWarning: renameVersionWarning } : {}),
            ...(result.resourceOps ? { resourceOps: result.resourceOps } : {}),
            ...(result.digests ? { digests: result.digests } : {}),
            // A destructive overwrite clobbered an existing file — the agent must SEE it explicitly,
            // not infer it from a digest diff (operator-gated; landed only).
            ...(result.overwritten?.length ? { overwritten: result.overwritten } : {}),
            ...(result.partial ? { partial: true } : {}),
            ...(result.partialError ? { partialError: result.partialError } : {}),
            // Partial-rename guard: the agent must see when an edit is likely incomplete (an
            // open-files-scoped server). A `suspect` verdict refuses the WRITE deny-by-default.
            ...(result.completeness ? { completeness: result.completeness } : {}),
            ...(result.suspectedMissedFiles
              ? { suspectedMissedFiles: result.suspectedMissedFiles }
              : {}),
          }
          let structured: Record<string, unknown> = { ...head, edits: result.edits }
          // A large edit set is offloaded by handle (already redacted by the engine); the inline
          // result keeps a capped per-file head. Applied edits store an `applied-edit` audit blob.
          if (result.totalEditCount > HEAD && artifacts) {
            const kind = result.applied ? 'applied-edit' : 'rename-preview'
            const fullHandle = artifacts.put(
              `${kind}-${seq++}`,
              kind,
              JSON.stringify(result, null, 2),
              'application/json',
            )
            structured = {
              ...head,
              edits: result.edits.slice(0, HEAD),
              truncated: true,
              fullHandle,
            }
          }
          return { content: [text(structured)], structuredContent: structured }
        },
      )
    }
  }

  // Large reference lists are emitted by handle, served by one resource when a store is set.
  if (opts.artifacts !== undefined) {
    const store = opts.artifacts
    server.registerResource(
      'lsp-artifact',
      new ResourceTemplate('sackville://lsp/{id}/{kind}', { list: undefined }),
      {
        title: 'LSP artifact',
        description: 'A stored LSP artifact (a full reference/location list) by handle',
        mimeType: 'application/json',
      },
      (uri, variables) => {
        const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
        const handle = `sackville://lsp/${pick(variables.id)}/${pick(variables.kind)}`
        const artifact = store.get(handle)
        if (!artifact) {
          throw new Error(`No stored LSP artifact for ${handle}`)
        }
        return {
          contents: [
            { uri: uri.href, mimeType: artifact.contentType, text: artifact.body.toString('utf8') },
          ],
        }
      },
    )
  }
}

/** Build a standalone Sackville LSP MCP server over an injected query engine + describe. */
export function createLspServer(opts: LspToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'sackville-lsp', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerLspTools(server, opts)
  return server
}
