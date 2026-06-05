import { readdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Aggregate-server architecture guards (ADR 0019, Phase 6).

const here = dirname(fileURLToPath(import.meta.url))

const binFiles = readdirSync(here)
  .filter((f) => f.startsWith('bin') && f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort()

describe('no bin imports the index barrel (ADR 0019 §A4)', () => {
  it('finds the bin entrypoints', () => {
    expect(binFiles.length).toBeGreaterThanOrEqual(9)
  })

  for (const file of binFiles) {
    it(`${file} imports its pillar module directly, never ./index.js`, () => {
      // index.ts statically re-exports EVERY pillar, so a bin importing the
      // barrel loads all pillars (and their heavy deps: playwright/sqlite/onnx)
      // at process start. Each bin must import only the module it serves.
      const src = readFileSync(`${here}/${file}`, 'utf8')
      expect(src).not.toMatch(/from\s+'\.\/index\.js'/)
    })
  }
})
