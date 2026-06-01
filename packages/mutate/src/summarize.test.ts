import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type MutationReport, summarizeMutation } from './summarize.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(here, '../test/fixtures')

function loadReport(): MutationReport {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, 'mutation-report.json'), 'utf8'),
  ) as MutationReport
}

describe('summarizeMutation', () => {
  const summary = summarizeMutation(loadReport())

  it('tallies every status across all files', () => {
    expect(summary.metrics.counts).toEqual({
      killed: 1,
      survived: 2,
      timeout: 1,
      noCoverage: 1,
      compileErrors: 1,
      runtimeErrors: 0,
      ignored: 1,
      pending: 0,
    })
  })

  it('derives detected/undetected/covered/valid/invalid/total per the elements schema', () => {
    const m = summary.metrics
    expect(m.detected).toBe(2) // killed + timeout
    expect(m.undetected).toBe(3) // survived + noCoverage
    expect(m.covered).toBe(4) // detected + survived
    expect(m.valid).toBe(5) // detected + undetected
    expect(m.invalid).toBe(1) // compile + runtime errors
    expect(m.totalMutants).toBe(7) // valid + invalid + ignored + pending
  })

  it('computes mutation score and covered-code score', () => {
    expect(summary.metrics.mutationScore).toBeCloseTo(40, 6) // detected/valid
    expect(summary.metrics.mutationScoreBasedOnCoveredCode).toBeCloseTo(50, 6) // detected/covered
  })

  it('breaks the metrics down per file', () => {
    const byFile = Object.fromEntries(summary.files.map((f) => [f.path, f]))
    expect(byFile['src/math.ts']?.metrics.mutationScore).toBeCloseTo(66.6667, 3)
    expect(byFile['src/util.ts']?.metrics.mutationScore).toBeCloseTo(0, 6)
    expect(byFile['src/util.ts']?.metrics.counts.noCoverage).toBe(1)
  })

  it('lists the actionable survivors (Survived + NoCoverage), sorted by file then line', () => {
    expect(summary.survivors).toEqual([
      { file: 'src/math.ts', mutatorName: 'ArithmeticOperator', status: 'Survived', line: 2 },
      { file: 'src/util.ts', mutatorName: 'BooleanLiteral', status: 'Survived', line: 1 },
      { file: 'src/util.ts', mutatorName: 'ArrowFunction', status: 'NoCoverage', line: 2 },
    ])
  })

  it('returns a null score when there are no valid mutants', () => {
    const empty = summarizeMutation({
      files: { 'a.ts': { mutants: [{ id: '0', mutatorName: 'X', status: 'CompileError' }] } },
    })
    expect(empty.metrics.valid).toBe(0)
    expect(empty.metrics.mutationScore).toBeNull()
    expect(empty.metrics.mutationScoreBasedOnCoveredCode).toBeNull()
  })

  it('tolerates an empty report', () => {
    const s = summarizeMutation({ files: {} })
    expect(s.metrics.totalMutants).toBe(0)
    expect(s.survivors).toEqual([])
    expect(s.files).toEqual([])
  })
})
