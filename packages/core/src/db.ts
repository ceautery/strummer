import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { EXPECTED_SCHEMA_VERSION } from './schema.js'
import type { SchemaMeta } from './types.js'

export interface OpenOptions {
  /** Open read-only (default true — the server never mutates an index). */
  readonly?: boolean
}

/**
 * Open a Sackville index, load the sqlite-vec extension, and assert the schema
 * version matches what this build expects. Throws on mismatch so a stale or
 * foreign index can never be served silently.
 */
export function openDb(path: string, options: OpenOptions = {}): Database.Database {
  const db = new Database(path, { readonly: options.readonly ?? true })
  sqliteVec.load(db)

  const meta = readMeta(db)
  if (meta.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `Sackville index schema mismatch at ${path}: file is v${meta.schemaVersion}, ` +
        `this build expects v${EXPECTED_SCHEMA_VERSION}. Rebuild the index.`,
    )
  }
  return db
}

interface MetaRow {
  key: string
  value: string
}

/** Read the `sackville_meta` key/value table into a typed object. */
export function readMeta(db: Database.Database): SchemaMeta {
  const rows = db.prepare('SELECT key, value FROM sackville_meta').all() as MetaRow[]
  const map = new Map(rows.map((r) => [r.key, r.value]))
  return {
    schemaVersion: Number(map.get('schema_version')),
    embedModel: map.get('embed_model') ?? '',
    embedDim: Number(map.get('embed_dim')),
    builtAt: map.get('built_at') ?? null,
    builderVersion: map.get('builder_version') ?? null,
  }
}
