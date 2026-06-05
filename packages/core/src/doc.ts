import type Database from 'better-sqlite3'
import type { DocFragment } from './types.js'

/**
 * Fetch a full documentation fragment by id. This is the one place full body
 * text is returned (the MCP `get_doc` tool and the `sackville://doc/{id}`
 * resource wrap it); search results stay compact. Returns undefined if absent.
 */
export function getDoc(db: Database.Database, id: number): DocFragment | undefined {
  const sql = `
    SELECT id,
           library,
           version,
           title,
           symbol,
           type,
           heading_path AS headingPath,
           url,
           attribution,
           body
    FROM docs
    WHERE id = ?
  `
  return db.prepare(sql).get(id) as DocFragment | undefined
}
