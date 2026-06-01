import { describe, expect, it } from 'vitest'
import { type FileCoverage, uncoveredNewLines } from './uncovered.js'

/**
 * An istanbul `FileCoverage` (the per-file shape inside `coverage-final.json`).
 * Statements sit on lines 2, 4 (two statements), and 7; lines 1/3/5/6/8 carry no
 * statement. Hit counts: line 2 covered, line 4 uncovered (both its statements 0),
 * line 7 covered.
 */
const fixture: FileCoverage = {
  path: '/proj/src/math.ts',
  statementMap: {
    '0': { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
    '1': { start: { line: 4, column: 4 }, end: { line: 4, column: 18 } },
    '2': { start: { line: 4, column: 20 }, end: { line: 4, column: 30 } },
    '3': { start: { line: 7, column: 2 }, end: { line: 7, column: 15 } },
  },
  s: { '0': 3, '1': 0, '2': 0, '3': 1 },
}

describe('uncoveredNewLines — classify a diff’s new lines against istanbul coverage', () => {
  it('classifies each new line as covered / uncovered / nonExecutable', () => {
    const result = uncoveredNewLines(fixture, [2, 3, 4, 7, 8])
    expect(result.lines).toEqual([
      { line: 2, state: 'covered' },
      { line: 3, state: 'nonExecutable' },
      { line: 4, state: 'uncovered' },
      { line: 7, state: 'covered' },
      { line: 8, state: 'nonExecutable' },
    ])
  })

  it('surfaces the executable-but-unhit new lines (the forgotten-assertion catch)', () => {
    const result = uncoveredNewLines(fixture, [2, 3, 4, 7, 8])
    expect(result.uncovered).toEqual([4])
    expect(result.summary).toEqual({ covered: 2, uncovered: 1, nonExecutable: 2, total: 5 })
  })

  it('GUARD: a new line with no statement is nonExecutable, NOT uncovered (the statementMap trap)', () => {
    // Line 3 maps to no statement. A naive differ that treats "not covered" as
    // "uncovered" would wrongly flag it. It must be nonExecutable and absent from `uncovered`.
    const result = uncoveredNewLines(fixture, [3])
    expect(result.lines).toEqual([{ line: 3, state: 'nonExecutable' }])
    expect(result.uncovered).toEqual([])
    expect(result.summary).toEqual({ covered: 0, uncovered: 0, nonExecutable: 1, total: 1 })
  })

  it('treats a line covered when ANY statement on it was hit (max over statements)', () => {
    // Two statements share line 4; flip statement "2" to a hit ⇒ the line is covered.
    const fc: FileCoverage = { ...fixture, s: { ...fixture.s, '2': 5 } }
    const result = uncoveredNewLines(fc, [4])
    expect(result.lines).toEqual([{ line: 4, state: 'covered' }])
    expect(result.uncovered).toEqual([])
  })

  it('dedupes and sorts the new-line input for stable output', () => {
    const result = uncoveredNewLines(fixture, [7, 4, 4, 2])
    expect(result.lines.map((l) => l.line)).toEqual([2, 4, 7])
    expect(result.uncovered).toEqual([4])
  })

  it('returns an empty result for no new lines', () => {
    expect(uncoveredNewLines(fixture, [])).toEqual({
      lines: [],
      uncovered: [],
      summary: { covered: 0, uncovered: 0, nonExecutable: 0, total: 0 },
    })
  })
})
