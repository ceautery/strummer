import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getDoc, searchDocs } from '@strummer/core'
import type DatabaseType from 'better-sqlite3'
import { z } from 'zod'

const INSTRUCTIONS = `Strummer serves version-pinned library documentation.

Use \`search_docs\` to find fragments — it returns COMPACT results (title, symbol,
a short snippet, and a \`resourceUri\`), never full bodies. To read the full text
of a hit, call \`get_doc\` with its \`id\` or read its \`strummer://doc/{id}\`
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
 * Build a Strummer MCP server over an open index. The caller owns the db handle
 * (open it with `openDb` from `@strummer/core`) and its lifecycle.
 */
export function createStrummerServer(db: DatabaseType.Database): McpServer {
  const server = new McpServer(
    { name: 'strummer', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )

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
        version: z.string().optional().describe('restrict to a doc version, e.g. "19.0"'),
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
      },
    },
    (args) => {
      const results = searchDocs(db, args.query, {
        library: args.library,
        version: args.version,
        type: args.type,
        limit: args.limit,
      }).map((r) => ({ ...r, resourceUri: `strummer://doc/${r.id}` }))
      const structured = { results }
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

  server.registerResource(
    'doc',
    new ResourceTemplate('strummer://doc/{id}', { list: undefined }),
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

  return server
}
