import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EXPECTED_EMBED_DIM, EXPECTED_EMBED_MODEL, EXPECTED_SCHEMA_VERSION } from './schema.js'

const here = dirname(fileURLToPath(import.meta.url))
const schemaJsonPath = resolve(here, '../../../schema/strummer.schema.json')

// Drift guard: the TypeScript constants and the canonical schema/*.json must
// never diverge. If this fails, the contract changed on one side only.
describe('contract constants match schema/strummer.schema.json', () => {
  const schema = JSON.parse(readFileSync(schemaJsonPath, 'utf8'))

  it('schema_version', () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe(schema.schema_version)
  })
  it('embed_dim', () => {
    expect(EXPECTED_EMBED_DIM).toBe(schema.embed_dim)
  })
  it('embed_model', () => {
    expect(EXPECTED_EMBED_MODEL).toBe(schema.embed_model)
  })
})
