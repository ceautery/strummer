import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCosmicRayDump } from './cosmic-ray.js'
import { summarizeMutation } from './summarize.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../test/fixtures/cosmic-ray-dump.jsonl')

describe('parseCosmicRayDump', () => {
  it('parses the dump into a report keyed by real module_path, mapping outcomes', () => {
    const report = parseCosmicRayDump(readFileSync(FIXTURE, 'utf8'))
    expect(Object.keys(report.files).sort()).toEqual(['calc.py', 'util.py'])

    const calc = report.files['calc.py']?.mutants ?? []
    const byOp = (op: string) => calc.find((m) => m.mutatorName === op)
    // worker_outcome=normal → use test_outcome.
    expect(byOp('core/ReplaceBinaryOperator_Add_Sub')?.status).toBe('Killed')
    expect(byOp('core/ReplaceBinaryOperator_Mul_Add')?.status).toBe('Survived')
    // skipped → Ignored; null result → Pending; unrecognized worker_outcome → Pending.
    expect(byOp('core/ReplaceBinaryOperator_Sub_Add')?.status).toBe('Ignored')
    expect(byOp('core/ReplaceBinaryOperator_Mul_Pow')?.status).toBe('Pending')
    expect(byOp('core/SomeFutureOperator')?.status).toBe('Pending')

    const util = report.files['util.py']?.mutants ?? []
    const u = (op: string) => util.find((m) => m.mutatorName === op)
    expect(u('core/NumberReplacer')?.status).toBe('NoCoverage') // no_test
    expect(u('core/ReplaceBinaryOperator_Mul_Div')?.status).toBe('RuntimeError') // incompetent
    expect(u('core/ReplaceComparisonOperator_Lt_Gt')?.status).toBe('RuntimeError') // exception
  })

  it('carries the real file:line:operator onto each mutant (the actionable survivor signal)', () => {
    const report = parseCosmicRayDump(readFileSync(FIXTURE, 'utf8'))
    const survived = report.files['calc.py']?.mutants.find((m) => m.status === 'Survived')
    expect(survived?.location?.start).toEqual({ line: 10, column: 13 })
    expect(survived?.mutatorName).toBe('core/ReplaceBinaryOperator_Mul_Add')
  })

  it('feeds summarizeMutation unchanged, surfacing survivors with real file:line', () => {
    const summary = summarizeMutation(parseCosmicRayDump(readFileSync(FIXTURE, 'utf8')))
    expect(summary.metrics.counts).toMatchObject({
      killed: 1,
      survived: 1,
      noCoverage: 1,
      runtimeErrors: 2,
      ignored: 1,
      pending: 2,
    })
    expect(summary.metrics.detected).toBe(1) // killed
    expect(summary.metrics.valid).toBe(3) // killed + survived + noCoverage
    // survivors = Survived + NoCoverage, sorted by file then line.
    expect(summary.survivors).toEqual([
      {
        file: 'calc.py',
        mutatorName: 'core/ReplaceBinaryOperator_Mul_Add',
        status: 'Survived',
        line: 10,
      },
      { file: 'util.py', mutatorName: 'core/NumberReplacer', status: 'NoCoverage', line: 4 },
    ])
  })

  it('tolerates blank/degenerate input', () => {
    expect(parseCosmicRayDump('').files).toEqual({})
    expect(parseCosmicRayDump('\n   \n').files).toEqual({})
  })
})
