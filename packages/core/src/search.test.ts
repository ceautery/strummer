import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type DatabaseType from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, readMeta } from './db.js'
import { EXPECTED_EMBED_DIM, EXPECTED_EMBED_MODEL, EXPECTED_SCHEMA_VERSION } from './schema.js'
import { searchDocs } from './search.js'

const here = dirname(fileURLToPath(import.meta.url))
// The golden fixture is built by the Python ingester — this is the polyglot
// boundary under test: Python writes it, TypeScript reads it.
const FIXTURE = resolve(here, '../../../fixtures/golden.sqlite')

describe('docs search over a Python-built index (polyglot boundary)', () => {
  let db: DatabaseType.Database

  beforeAll(() => {
    db = openDb(FIXTURE)
  })
  afterAll(() => {
    db?.close()
  })

  it('verifies the schema contract from sackville_meta', () => {
    const meta = readMeta(db)
    expect(meta.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION)
    expect(meta.embedDim).toBe(EXPECTED_EMBED_DIM)
    expect(meta.embedModel).toBe(EXPECTED_EMBED_MODEL)
  })

  it('finds useState in the react fixture via full-text search', () => {
    const results = searchDocs(db, 'useState', { library: 'react' })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      symbol: 'useState',
      library: 'react',
      version: '19.0',
      type: 'function',
    })
    expect(results[0]?.snippet).toContain('useState')
  })

  it('respects the library filter (no cross-library leakage)', () => {
    const results = searchDocs(db, 'useState', { library: 'vue' })
    expect(results).toHaveLength(0)
  })
})
