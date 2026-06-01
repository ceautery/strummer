import { describe, expect, it } from 'vitest'
import { uncoveredInDiff } from './report.js'
import type { FileCoverage } from './uncovered.js'

/** A file where statements sit on lines 2 (hit) and 4 (unhit); 3 is non-executable. */
function fc(path: string): FileCoverage {
  return {
    path,
    statementMap: {
      '0': { start: { line: 2, column: 2 }, end: { line: 2, column: 9 } },
      '1': { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
    },
    s: { '0': 1, '1': 0 },
  }
}

const diff = `diff --git a/packages/app/src/math.ts b/packages/app/src/math.ts
--- a/packages/app/src/math.ts
+++ b/packages/app/src/math.ts
@@ -1,3 +1,5 @@
 const a = 1
+const b = 2
+
+const c = noTest()
 const d = 4
`
// New-side added lines from this hunk: 2, 3, 4. With fc(): 2 covered, 3 nonExecutable,
// 4 uncovered.

describe('uncoveredInDiff — pair a unified diff with coverage-final.json', () => {
  it('matches a repo-relative diff path to an absolute coverage key by suffix', () => {
    const coverage = {
      '/abs/repo/packages/app/src/math.ts': fc('/abs/repo/packages/app/src/math.ts'),
    }
    const report = uncoveredInDiff(diff, coverage)
    const file = report.files[0]
    expect(file?.path).toBe('packages/app/src/math.ts')
    expect(file?.found).toBe(true)
    expect(file?.coveragePath).toBe('/abs/repo/packages/app/src/math.ts')
    expect(file?.addedLines).toEqual([2, 3, 4])
    expect(file?.result?.lines).toEqual([
      { line: 2, state: 'covered' },
      { line: 3, state: 'nonExecutable' },
      { line: 4, state: 'uncovered' },
    ])
  })

  it('flattens the executable-but-unhit new lines and aggregates a summary', () => {
    const coverage = { '/abs/repo/packages/app/src/math.ts': fc('/x') }
    const report = uncoveredInDiff(diff, coverage)
    expect(report.uncovered).toEqual([{ path: 'packages/app/src/math.ts', line: 4 }])
    expect(report.summary).toEqual({
      covered: 1,
      uncovered: 1,
      nonExecutable: 1,
      total: 3,
      filesWithoutCoverage: 0,
    })
  })

  it('resolves exactly via projectRoot when given (avoids suffix ambiguity)', () => {
    const coverage = { '/abs/repo/packages/app/src/math.ts': fc('/x') }
    const report = uncoveredInDiff(diff, coverage, { projectRoot: '/abs/repo' })
    expect(report.files[0]?.found).toBe(true)
    expect(report.files[0]?.coveragePath).toBe('/abs/repo/packages/app/src/math.ts')
  })

  it('marks a diff file with no coverage entry as not found (and counts it)', () => {
    const report = uncoveredInDiff(diff, {})
    expect(report.files[0]?.found).toBe(false)
    expect(report.files[0]?.result).toBeUndefined()
    expect(report.files[0]?.addedLines).toEqual([2, 3, 4])
    expect(report.summary.filesWithoutCoverage).toBe(1)
    expect(report.uncovered).toEqual([])
  })

  it('does NOT confidently match when two coverage keys share the suffix (ambiguous)', () => {
    const coverage = {
      '/abs/repo/packages/app/src/math.ts': fc('/x'),
      '/other/checkout/packages/app/src/math.ts': fc('/y'),
    }
    // No projectRoot ⇒ the suffix matches two keys ⇒ left unmatched rather than guessed.
    const report = uncoveredInDiff(diff, coverage)
    expect(report.files[0]?.found).toBe(false)
    // …but projectRoot disambiguates it.
    const scoped = uncoveredInDiff(diff, coverage, { projectRoot: '/abs/repo' })
    expect(scoped.files[0]?.found).toBe(true)
    expect(scoped.files[0]?.coveragePath).toBe('/abs/repo/packages/app/src/math.ts')
  })

  it('normalizes backslash coverage keys (Windows) for matching', () => {
    const coverage = {
      'C:\\repo\\packages\\app\\src\\math.ts': fc('C:\\repo\\packages\\app\\src\\math.ts'),
    }
    const report = uncoveredInDiff(diff, coverage)
    expect(report.files[0]?.found).toBe(true)
  })

  it('returns an empty report for an empty diff', () => {
    expect(uncoveredInDiff('', {})).toEqual({
      files: [],
      uncovered: [],
      summary: { covered: 0, uncovered: 0, nonExecutable: 0, total: 0, filesWithoutCoverage: 0 },
    })
  })
})
