import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMutmutResults } from './mutmut.js'
import { summarizeMutation } from './summarize.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../test/fixtures/mutmut-results.txt')

describe('parseMutmutResults', () => {
  it('parses mutmut results into a report grouped by module, mapping the status vocabulary', () => {
    const report = parseMutmutResults(readFileSync(FIXTURE, 'utf8'))
    expect(Object.keys(report.files).sort()).toEqual(['calc', 'util'])
    const calc = report.files.calc?.mutants ?? []
    expect(calc.find((m) => m.id === 'calc.x_add__mutmut_1')?.status).toBe('Killed')
    expect(calc.find((m) => m.id === 'calc.x_sub__mutmut_1')?.status).toBe('Survived')
    expect(calc.find((m) => m.id === 'calc.x_mul__mutmut_1')?.status).toBe('NoCoverage')
    const util = report.files.util?.mutants ?? []
    expect(util.find((m) => m.id === 'util.x_norm__mutmut_1')?.status).toBe('Timeout')
    // suspicious is not a confirmed kill → Survived (surfaced as a gap, never inflating the score)
    expect(util.find((m) => m.id === 'util.x_norm__mutmut_2')?.status).toBe('Survived')
    expect(util.find((m) => m.id === 'util.x_helper__mutmut_1')?.status).toBe('Ignored')
  })

  it('feeds summarizeMutation unchanged — one summarizer across Stryker + mutmut', () => {
    const summary = summarizeMutation(parseMutmutResults(readFileSync(FIXTURE, 'utf8')))
    const m = summary.metrics
    expect(m.counts).toMatchObject({
      killed: 1,
      survived: 2, // sub + suspicious
      noCoverage: 1,
      timeout: 1,
      ignored: 1,
    })
    expect(m.detected).toBe(2) // killed + timeout
    expect(m.valid).toBe(5) // detected + (survived + noCoverage)
    expect(m.mutationScore).toBe(40) // 2/5
    // Survivors = Survived + NoCoverage, sorted by file then line.
    expect(summary.survivors.map((s) => s.mutatorName).sort()).toEqual([
      'calc.x_mul__mutmut_1',
      'calc.x_sub__mutmut_1',
      'util.x_norm__mutmut_2',
    ])
  })

  it('tolerates blank/degenerate input', () => {
    expect(parseMutmutResults('').files).toEqual({})
    expect(parseMutmutResults('\n   \n').files).toEqual({})
  })
})
