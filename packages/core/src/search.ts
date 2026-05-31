import type Database from 'better-sqlite3'
import type { SearchOptions, SearchResult } from './types.js'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25

/**
 * Full-text search over the docs index (FTS5 / bm25). Hybrid vector reranking
 * lands in a later step; this is the FTS branch the MCP `search_docs` tool
 * wraps. Version/library/type filters are applied in SQL.
 */
export function searchDocs(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const where = ['docs_fts MATCH @query']
  const params: Record<string, string | number> = { query, limit }
  if (options.library !== undefined) {
    where.push('d.library = @library')
    params.library = options.library
  }
  if (options.version !== undefined) {
    where.push('d.version = @version')
    params.version = options.version
  }
  if (options.type !== undefined) {
    where.push('d.type = @type')
    params.type = options.type
  }

  const sql = `
    SELECT d.id        AS id,
           d.title     AS title,
           d.symbol    AS symbol,
           d.type      AS type,
           d.library   AS library,
           d.version   AS version,
           bm25(docs_fts) AS score,
           snippet(docs_fts, 1, '[', ']', '…', 10) AS snippet
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.rowid
    WHERE ${where.join(' AND ')}
    ORDER BY score
    LIMIT @limit
  `
  return db.prepare(sql).all(params) as SearchResult[]
}
