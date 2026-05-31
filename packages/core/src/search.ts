import type Database from 'better-sqlite3'
import { EXPECTED_EMBED_DIM } from './schema.js'
import type { SearchOptions, SearchResult } from './types.js'

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 25
// Reciprocal Rank Fusion constant (standard default).
const RRF_K = 60
// Candidate pool pulled from each ranked list before fusion.
const CANDIDATES = 64

/** Build a safe FTS5 MATCH string: quote each alphanumeric token (implicit AND). */
function ftsMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' ')
}

function excerpt(body: string, max = 160): string {
  const collapsed = body.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`
}

interface MetaRow {
  id: number
  title: string
  symbol: string | null
  type: string | null
  library: string
  version: string
  body: string
}

/**
 * Search the docs index. Full-text (FTS5/bm25) always runs; when `queryVector`
 * is supplied, vector KNN (sqlite-vec) is fused with it via reciprocal rank
 * fusion. Library/version/type filters apply to both halves. Results are sorted
 * best-first; bodies are never returned (fetch them via getDoc).
 */
export function searchDocs(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const useVector =
    Array.isArray(options.queryVector) && options.queryVector.length === EXPECTED_EMBED_DIM

  const snippets = new Map<number, string>()
  const ftsRanked = runFts(db, query, options, snippets)
  const vecRanked = useVector ? runVector(db, options) : []

  // Reciprocal rank fusion across the available ranked lists.
  const scores = new Map<number, number>()
  for (const ranked of [ftsRanked, vecRanked]) {
    ranked.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    })
  }
  if (scores.size === 0) return []

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)

  const placeholders = topIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT id, title, symbol, type, library, version, body
       FROM docs WHERE id IN (${placeholders})`,
    )
    .all(...topIds) as MetaRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))

  const results: SearchResult[] = []
  for (const id of topIds) {
    const row = byId.get(id)
    if (!row) continue
    const { body, ...meta } = row
    results.push({
      ...meta,
      score: scores.get(id) ?? 0,
      snippet: snippets.get(id) ?? excerpt(body),
    })
  }
  return results
}

function runFts(
  db: Database.Database,
  query: string,
  options: SearchOptions,
  snippets: Map<number, string>,
): number[] {
  const match = ftsMatch(query)
  if (!match) return []

  const clauses = ['docs_fts MATCH @match']
  const params: Record<string, unknown> = { match, cand: CANDIDATES }
  if (options.library !== undefined) {
    clauses.push('d.library = @library')
    params.library = options.library
  }
  if (options.version !== undefined) {
    clauses.push('d.version = @version')
    params.version = options.version
  }
  if (options.type !== undefined) {
    clauses.push('d.type = @type')
    params.type = options.type
  }

  const rows = db
    .prepare(
      `SELECT docs_fts.rowid AS id, snippet(docs_fts, 1, '[', ']', '…', 12) AS snippet
       FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
       WHERE ${clauses.join(' AND ')}
       ORDER BY bm25(docs_fts) LIMIT @cand`,
    )
    .all(params) as { id: number; snippet: string }[]

  const ids: number[] = []
  for (const r of rows) {
    ids.push(r.id)
    snippets.set(r.id, r.snippet)
  }
  return ids
}

function runVector(db: Database.Database, options: SearchOptions): number[] {
  const clauses = ['embedding MATCH @vec', 'k = @k']
  const params: Record<string, unknown> = {
    vec: JSON.stringify(options.queryVector),
    k: CANDIDATES,
  }
  if (options.library !== undefined) {
    clauses.push('library = @library')
    params.library = options.library
  }
  if (options.version !== undefined) {
    clauses.push('version = @version')
    params.version = options.version
  }
  if (options.type !== undefined) {
    clauses.push('type = @type')
    params.type = options.type
  }

  const rows = db
    .prepare(
      `SELECT doc_id AS id FROM docs_vec
       WHERE ${clauses.join(' AND ')}
       ORDER BY distance`,
    )
    .all(params) as { id: number }[]
  return rows.map((r) => r.id)
}
