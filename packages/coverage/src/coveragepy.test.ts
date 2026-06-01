import { describe, expect, it } from 'vitest'
import { coveragePyToIstanbul, fileCoverageFromCoveragePy } from './coveragepy.js'
import { uncoveredInDiff } from './report.js'
import { uncoveredNewLines } from './uncovered.js'

const FILE = {
  executed_lines: [1, 2, 4],
  missing_lines: [5, 6],
  excluded_lines: [3],
}

describe('fileCoverageFromCoveragePy', () => {
  it('classifies executed=covered, missing=uncovered, excluded/absent=nonExecutable', () => {
    const fc = fileCoverageFromCoveragePy('src/m.py', FILE)
    const got = uncoveredNewLines(fc, [1, 2, 3, 4, 5, 6, 7])
    expect(got.uncovered).toEqual([5, 6])
    expect(got.summary).toEqual({ covered: 3, uncovered: 2, nonExecutable: 2, total: 7 })
    // line 3 (excluded) and line 7 (no statement) are both nonExecutable, never findings.
    expect(got.lines.find((l) => l.line === 3)?.state).toBe('nonExecutable')
    expect(got.lines.find((l) => l.line === 7)?.state).toBe('nonExecutable')
  })

  it('carries the file path through and tolerates a missing excluded_lines', () => {
    const fc = fileCoverageFromCoveragePy('src/m.py', {
      executed_lines: [1],
      missing_lines: [2],
    })
    expect(fc.path).toBe('src/m.py')
    expect(uncoveredNewLines(fc, [1, 2]).uncovered).toEqual([2])
  })
})

describe('coveragePyToIstanbul', () => {
  it('maps every file in a coverage.py report, preserving the keys', () => {
    const map = coveragePyToIstanbul({
      meta: { format: 2 },
      files: {
        'src/m.py': FILE,
        'src/util.py': { executed_lines: [1, 2, 3], missing_lines: [], excluded_lines: [] },
      },
    })
    expect(Object.keys(map).sort()).toEqual(['src/m.py', 'src/util.py'])
    expect(uncoveredNewLines(map['src/m.py']!, [5]).uncovered).toEqual([5])
    expect(uncoveredNewLines(map['src/util.py']!, [1, 2, 3]).uncovered).toEqual([])
  })

  it('feeds uncoveredInDiff end-to-end (the forgotten-assertion catch, Python edition)', () => {
    const diff = [
      'diff --git a/src/m.py b/src/m.py',
      '--- a/src/m.py',
      '+++ b/src/m.py',
      '@@ -1,0 +1,6 @@',
      '+def f(x):',
      '+    y = x + 1',
      '+    # excluded comment',
      '+    return y',
      '+    z = never()',
      '+    return z',
    ].join('\n')
    const map = coveragePyToIstanbul({ files: { '/abs/repo/src/m.py': FILE } })
    const report = uncoveredInDiff(diff, map, { projectRoot: '/abs/repo' })
    expect(report.uncovered).toEqual([
      { path: 'src/m.py', line: 5 },
      { path: 'src/m.py', line: 6 },
    ])
    expect(report.summary.filesWithoutCoverage).toBe(0)
  })
})
