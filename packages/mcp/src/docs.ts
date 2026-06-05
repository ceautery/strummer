import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  detectInstalledVersion,
  getDoc,
  listVersions,
  openDb,
  resolveVersion,
  searchDocs,
} from '@sackville/core'
import { type Embedder, QueryEmbedder } from '@sackville/embed'
import type DatabaseType from 'better-sqlite3'
import { z } from 'zod'
import type { PillarSetup } from './pillars.js'

export interface ServerOptions {
  /** When provided, queries are embedded and fused with FTS (hybrid search). */
  embedder?: Embedder
}

/** Options for {@link registerDocsTools}: the open index db + optional embedder. */
export interface DocsToolsOptions extends ServerOptions {
  db: DatabaseType.Database
}

const INSTRUCTIONS = `Sackville serves version-pinned library documentation.

Use \`search_docs\` to find fragments — it returns COMPACT results (title, symbol,
a short snippet, and a \`resourceUri\`), never full bodies. To read the full text
of a hit, call \`get_doc\` with its \`id\` or read its \`sackville://doc/{id}\`
resource. Always pass \`library\` (and \`version\` when known) so results match the
version actually installed in the project.`

const DOC_FIELDS = {
  id: z.number().int(),
  library: z.string(),
  version: z.string(),
  title: z.string(),
  symbol: z.string().nullable(),
  type: z.string().nullable(),
  headingPath: z.string().nullable(),
  url: z.string().nullable(),
  attribution: z.string().nullable(),
  body: z.string(),
}

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

/**
 * Register the docs-pillar tools (`search_docs`/`get_doc`/`detect_version`/
 * `list_versions`) + the `sackville://doc/{id}` resource onto an existing server.
 * This is the composition seam used by both the standalone docs bin and the
 * aggregate server (ADR 0019).
 */
export function registerDocsTools(server: McpServer, opts: DocsToolsOptions): void {
  const { db, embedder } = opts

  server.registerTool(
    'search_docs',
    {
      title: 'Search documentation',
      description:
        'Full-text search over indexed docs. Returns compact hits with a resourceUri; ' +
        'call get_doc (or read the resource) for full text. Filter by library/version/type.',
      inputSchema: {
        query: z.string().describe('search terms, e.g. "useState" or "how to memoize a value"'),
        library: z.string().optional().describe('restrict to a library, e.g. "react"'),
        version: z.string().optional().describe('restrict to an exact doc version, e.g. "19.2"'),
        installed: z
          .string()
          .optional()
          .describe(
            'the version/range installed in the project (e.g. "^18.2.0"); resolved to the ' +
              'best matching doc release. Requires `library`.',
          ),
        project: z
          .string()
          .optional()
          .describe(
            'absolute path to the project root; auto-detects the installed version of `library` ' +
              'from the project manifests. Precedence: version > installed > project.',
          ),
        ecosystem: z
          .enum(['node', 'python', 'ruby'])
          .optional()
          .describe('restrict project auto-detection to one ecosystem (default: auto-probe)'),
        type: z.string().optional().describe('restrict to a kind, e.g. "function" | "guide"'),
        limit: z.number().int().min(1).max(25).optional().describe('max results (default 8)'),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.number().int(),
            title: z.string(),
            symbol: z.string().nullable(),
            type: z.string().nullable(),
            library: z.string(),
            version: z.string(),
            score: z.number(),
            snippet: z.string(),
            resourceUri: z.string(),
          }),
        ),
        resolvedVersion: z.string().nullable().optional(),
        detectedVersion: z.string().nullable().optional(),
        versionNote: z.string().optional(),
      },
    },
    async (args) => {
      // Version filter precedence: explicit version > installed range > auto-detect.
      let effectiveVersion = args.version
      let resolvedVersion: string | null | undefined
      let detectedVersion: string | null | undefined
      let versionNote: string | undefined
      if (!args.version && (args.installed || args.project)) {
        if (!args.library) {
          versionNote = 'provide `library` to resolve a version'
        } else {
          let requested = args.installed
          if (!requested && args.project) {
            const detected = detectInstalledVersion(args.project, args.library, {
              ecosystem: args.ecosystem,
            })
            detectedVersion = detected.version
            if (detected.version) {
              requested = detected.version
            } else {
              versionNote = `could not detect ${args.library} in ${args.project}`
            }
          }
          if (requested) {
            const res = resolveVersion(listVersions(db, args.library), requested)
            resolvedVersion = res.resolved
            versionNote = res.note
            if (res.resolved) effectiveVersion = res.resolved
          }
        }
      }

      // Embed the query for hybrid search; fall back to FTS-only if it fails.
      let queryVector: number[] | undefined
      if (embedder) {
        try {
          queryVector = await embedder.embed(args.query)
        } catch {
          queryVector = undefined
        }
      }
      const results = searchDocs(db, args.query, {
        library: args.library,
        version: effectiveVersion,
        type: args.type,
        limit: args.limit,
        queryVector,
      }).map((r) => ({ ...r, resourceUri: `sackville://doc/${r.id}` }))

      const structured =
        args.installed || args.project
          ? {
              results,
              resolvedVersion: resolvedVersion ?? null,
              detectedVersion: detectedVersion ?? null,
              versionNote,
            }
          : { results }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'get_doc',
    {
      title: 'Get a documentation fragment',
      description: 'Fetch the full text of one fragment by id (the only call that returns bodies).',
      inputSchema: { id: z.number().int().describe('fragment id from a search_docs result') },
      outputSchema: DOC_FIELDS,
    },
    (args) => {
      const doc = getDoc(db, args.id)
      if (!doc) {
        throw new Error(`No document with id ${args.id}`)
      }
      // Spread to a fresh object literal so it satisfies the SDK's
      // structuredContent index-signature type.
      return { content: [text(doc)], structuredContent: { ...doc } }
    },
  )

  server.registerTool(
    'detect_version',
    {
      title: 'Detect installed version',
      description:
        'Detect the installed version of a library in a project (Node, Python, or Ruby ' +
        'manifests) and resolve it to the best matching indexed doc release.',
      inputSchema: {
        project: z.string().describe('absolute path to the project root'),
        library: z.string().describe('library / package name, e.g. "react" or "django"'),
        ecosystem: z
          .enum(['node', 'python', 'ruby'])
          .optional()
          .describe(
            'restrict detection to one ecosystem (default: auto-probe node → python → ruby)',
          ),
      },
      outputSchema: {
        library: z.string(),
        detectedVersion: z.string().nullable(),
        detectedSource: z.string(),
        resolvedVersion: z.string().nullable(),
        exact: z.boolean(),
        note: z.string(),
        available: z.array(z.string()),
      },
    },
    (args) => {
      const detected = detectInstalledVersion(args.project, args.library, {
        ecosystem: args.ecosystem,
      })
      const available = listVersions(db, args.library)
      const res = detected.version
        ? resolveVersion(available, detected.version)
        : {
            resolved: null,
            exact: false,
            note: `could not detect ${args.library} in ${args.project}`,
            available,
          }
      const structured = {
        library: args.library,
        detectedVersion: detected.version,
        detectedSource: detected.source,
        resolvedVersion: res.resolved,
        exact: res.exact,
        note: res.note,
        available: res.available,
      }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'list_versions',
    {
      title: 'List indexed versions',
      description: 'List the documentation versions indexed for a library, newest first.',
      inputSchema: { library: z.string().describe('library name, e.g. "react"') },
      outputSchema: { library: z.string(), versions: z.array(z.string()) },
    },
    (args) => {
      const structured = { library: args.library, versions: listVersions(db, args.library) }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerResource(
    'doc',
    new ResourceTemplate('sackville://doc/{id}', { list: undefined }),
    {
      title: 'Documentation fragment',
      description: 'Full doc fragment by id',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const raw = Array.isArray(variables.id) ? variables.id[0] : variables.id
      const id = Number(raw)
      const doc = getDoc(db, id)
      if (!doc) {
        throw new Error(`No document with id ${id}`)
      }
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(doc, null, 2) },
        ],
      }
    },
  )
}

/**
 * Build a standalone Sackville docs MCP server over an open index. The caller owns
 * the db handle (open it with `openDb` from `@sackville/core`) and its lifecycle.
 */
export function createSackvilleServer(
  db: DatabaseType.Database,
  options: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: 'sackville', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerDocsTools(server, { db, embedder: options.embedder })
  return server
}

/**
 * The aggregate-composition seam (ADR 0019): open the configured index + query
 * embedder and return a {@link PillarSetup} that registers the docs tools onto a
 * (possibly shared) server. The docs pillar OWNS the sqlite handle, so its
 * `shutdown` closes it. Returns `undefined` (a LOUD DISABLE) when no
 * `SACKVILLE_INDEX` is configured — the curated default enables docs, but without
 * an index there is nothing to serve, so the aggregate logs it and skips (the
 * effective zero-config default is api+deps+verify until an index is present).
 */
export function setupDocsFromEnv(
  env: Record<string, string | undefined> = process.env,
): PillarSetup | undefined {
  const indexPath = env.SACKVILLE_INDEX
  if (!indexPath) return undefined
  const db = openDb(indexPath)
  const embedder = new QueryEmbedder()
  return {
    register: (server) => registerDocsTools(server, { db, embedder }),
    shutdown: () => {
      db.close()
    },
  }
}
