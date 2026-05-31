import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type DatabaseType from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from './db.js'
import { getDoc } from './doc.js'
import { searchDocs } from './search.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../fixtures/golden.sqlite')

describe('getDoc', () => {
  let db: DatabaseType.Database

  beforeAll(() => {
    db = openDb(FIXTURE)
  })
  afterAll(() => {
    db?.close()
  })

  it('returns the full fragment for a known id', () => {
    const [hit] = searchDocs(db, 'useState', { library: 'react' })
    expect(hit).toBeDefined()
    const doc = getDoc(db, hit!.id)
    expect(doc).toMatchObject({
      id: hit!.id,
      library: 'react',
      version: '19.0',
      symbol: 'useState',
      type: 'function',
      headingPath: 'Hooks > useState',
      url: 'https://react.dev/reference/react/useState',
    })
    expect(doc?.attribution).toContain('MIT')
    expect(doc?.body).toContain('state variable')
  })

  it('returns undefined for an unknown id', () => {
    expect(getDoc(db, 999_999)).toBeUndefined()
  })
})
