import { describe, expect, it } from 'vitest'
import { changedLinesByFile, filterToChangedLines } from './line-scope.js'
import type { MutationReport } from './summarize.js'

/** A mutant on `[startLine..endLine]` (single line when endLine omitted). */
function mutant(id: string, startLine: number, endLine?: number) {
  return {
    id,
    mutatorName: 'core/ReplaceBinaryOperator_Add_Sub',
    status: 'Survived' as const,
    location: {
      start: { line: startLine, column: 1 },
      end: { line: endLine ?? startLine, column: 2 },
    },
  }
}

const report: MutationReport = {
  files: {
    'calc.py': {
      language: 'python',
      source: 'x',
      mutants: [mutant('a', 2), mutant('b', 6), mutant('c', 7)],
    },
    'util.py': { language: 'python', mutants: [mutant('d', 4)] },
  },
}

describe('filterToChangedLines', () => {
  it('keeps only mutants whose [start..end] span hits a changed line of their file', () => {
    const changed = changedLinesByFile([{ path: 'calc.py', addedLines: [6] }])
    const out = filterToChangedLines(report, changed)
    // util.py is absent from the change map ⇒ the whole file is dropped.
    expect(Object.keys(out.files)).toEqual(['calc.py'])
    // Only the line-6 mutant survives; lines 2 and 7 are out-of-diff (mirrors cr-filter-git).
    expect(out.files['calc.py']?.mutants.map((m) => m.id)).toEqual(['b'])
  })

  it('keeps a multi-line mutant when its span straddles a changed line (range intersection)', () => {
    const r: MutationReport = { files: { 'm.py': { mutants: [mutant('span', 5, 7)] } } }
    expect(
      filterToChangedLines(r, changedLinesByFile([{ path: 'm.py', addedLines: [6] }])).files['m.py']
        ?.mutants,
    ).toHaveLength(1)
    // A span fully outside the changed lines is dropped.
    expect(
      filterToChangedLines(r, changedLinesByFile([{ path: 'm.py', addedLines: [9] }])).files,
    ).toEqual({})
  })

  it('drops a file that has no mutant on any changed line', () => {
    const changed = changedLinesByFile([{ path: 'calc.py', addedLines: [99] }])
    expect(filterToChangedLines(report, changed).files).toEqual({})
  })

  it('drops an unplaceable mutant — we cannot prove it is on a changed line (never inflate the scoped score)', () => {
    const r: MutationReport = {
      files: {
        'm.py': {
          mutants: [{ id: 'noloc', mutatorName: 'x', status: 'Survived' }, mutant('placed', 6)],
        },
      },
    }
    const out = filterToChangedLines(r, changedLinesByFile([{ path: 'm.py', addedLines: [6] }]))
    expect(out.files['m.py']?.mutants.map((m) => m.id)).toEqual(['placed'])
  })

  it('treats a mutant with start but no end as single-line (end defaults to start.line)', () => {
    const r: MutationReport = {
      files: {
        'm.py': {
          mutants: [
            { id: 's', mutatorName: 'x', status: 'Survived', location: { start: { line: 6 } } },
          ],
        },
      },
    }
    expect(
      filterToChangedLines(r, changedLinesByFile([{ path: 'm.py', addedLines: [6] }])).files['m.py']
        ?.mutants,
    ).toHaveLength(1)
    expect(
      filterToChangedLines(r, changedLinesByFile([{ path: 'm.py', addedLines: [5] }])).files,
    ).toEqual({})
  })

  it('preserves file language/source and the full mutant shape on kept entries', () => {
    const out = filterToChangedLines(
      report,
      changedLinesByFile([{ path: 'calc.py', addedLines: [6] }]),
    )
    expect(out.files['calc.py']?.language).toBe('python')
    expect(out.files['calc.py']?.source).toBe('x')
    expect(out.files['calc.py']?.mutants[0]).toEqual(mutant('b', 6))
  })

  it('is a no-op shape when the change map is empty (nothing scoped ⇒ empty report)', () => {
    expect(filterToChangedLines(report, changedLinesByFile([])).files).toEqual({})
  })
})

describe('changedLinesByFile', () => {
  it('builds a per-file line set from parseUnifiedDiff-shaped entries', () => {
    const map = changedLinesByFile([
      { path: 'a.py', addedLines: [1, 2, 5] },
      { path: 'b.py', addedLines: [10] },
    ])
    expect(map.get('a.py')).toEqual(new Set([1, 2, 5]))
    expect(map.get('b.py')).toEqual(new Set([10]))
    expect(map.has('c.py')).toBe(false)
  })
})
