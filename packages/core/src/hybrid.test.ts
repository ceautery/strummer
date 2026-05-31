import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXPECTED_EMBED_DIM } from './schema.js'
import { searchDocs } from './search.js'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMA = resolve(here, '../../../schema/strummer.schema.sql')

/** A 384-d unit vector pointing along axis `axis`. */
function unit(axis: number): number[] {
  const v = new Array(EXPECTED_EMBED_DIM).fill(0)
  v[axis] = 1
  return v
}

function insert(
  db: Database.Database,
  doc: { id: number; title: string; body: string; vec: number[] },
) {
  db.prepare(
    'INSERT INTO docs(id, library, version, title, type, body) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(doc.id, 'react', '19.0', doc.title, 'guide', doc.body)
  db.prepare(
    'INSERT INTO docs_vec(doc_id, library, version, type, embedding) VALUES (?, ?, ?, ?, ?)',
  ).run(BigInt(doc.id), 'react', '19.0', 'guide', JSON.stringify(doc.vec))
}

describe('hybrid search (RRF of FTS + vector)', () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
    sqliteVec.load(db)
    db.exec(readFileSync(SCHEMA, 'utf8'))
    // doc2 has no lexical overlap with the query, but its vector matches it.
    insert(db, { id: 1, title: 'Alpha', body: 'the quick brown fox', vec: unit(1) })
    insert(db, { id: 2, title: 'Beta', body: 'lazy dog sleeps', vec: unit(0) })
    insert(db, { id: 3, title: 'Gamma', body: 'quick fox runs', vec: unit(2) })
  })
  afterAll(() => db?.close())

  it('full-text only misses the semantically-relevant doc', () => {
    const ids = searchDocs(db, 'quick fox').map((r) => r.id)
    expect(ids).toContain(1)
    expect(ids).toContain(3)
    expect(ids).not.toContain(2) // no lexical overlap
  })

  it('fusing the query vector recovers the semantic-only doc', () => {
    const ids = searchDocs(db, 'quick fox', { queryVector: unit(0) }).map((r) => r.id)
    expect(ids).toContain(2) // vector KNN surfaces it
    expect(ids).toContain(1)
    expect(ids).toContain(3)
  })

  it('ignores a query vector of the wrong dimension (falls back to FTS)', () => {
    const ids = searchDocs(db, 'quick fox', { queryVector: [1, 2, 3] }).map((r) => r.id)
    expect(ids).not.toContain(2)
  })
})
