/** Metadata read from a Strummer index's `strummer_meta` table. */
export interface SchemaMeta {
  schemaVersion: number
  embedModel: string
  embedDim: number
  builtAt: string | null
  builderVersion: string | null
}

/** A full documentation fragment — the complete record for one `docs` row. */
export interface DocFragment {
  id: number
  library: string
  version: string
  title: string
  symbol: string | null
  type: string | null
  headingPath: string | null
  url: string | null
  attribution: string | null
  body: string
}

/** Filters and limits for a docs search. */
export interface SearchOptions {
  library?: string
  version?: string
  type?: string
  /** Defaults to 8, clamped to 25. */
  limit?: number
}

/** One search hit. Compact by design — full bodies are fetched separately. */
export interface SearchResult {
  id: number
  title: string
  symbol: string | null
  type: string | null
  library: string
  version: string
  /** FTS5 bm25 score; lower is a better match. */
  score: number
  /** Short highlighted excerpt from the body. */
  snippet: string
}
