import { describe, expect, it } from 'vitest'
import { reconcileScope, selectMutationScope } from './scope.js'
import type { FileSummary, MutationMetrics, MutationSummary } from './summarize.js'

describe('selectMutationScope (ADR 0010 addendum 2, slice A)', () => {
  const allExist = () => true

  it('selects in-tree existing .py files, dropping non-.py', () => {
    const r = selectMutationScope(['docs/x.md', 'src/a.py', 'src/b.py'], ['src'], allExist)
    expect(r.files).toEqual(['src/a.py', 'src/b.py'])
    expect(r.unmatched).toEqual([])
  })

  it('routes an out-of-tree .py to unmatched (report-gap), never into files', () => {
    const r = selectMutationScope(['src/a.py', 'other/c.py'], ['src'], allExist)
    expect(r.files).toEqual(['src/a.py'])
    expect(r.unmatched).toEqual(['other/c.py'])
  })

  it('routes a non-existent (deleted/renamed/typo) .py to unmatched (the exists predicate)', () => {
    const exists = (p: string) => p !== 'src/gone.py'
    const r = selectMutationScope(['src/a.py', 'src/gone.py'], ['src'], exists)
    expect(r.files).toEqual(['src/a.py'])
    expect(r.unmatched).toEqual(['src/gone.py'])
  })

  it('normalizes leading ./ and backslashes; dedups and sorts', () => {
    const r = selectMutationScope(['./src/a.py', 'src\\a.py', 'src/b.py'], ['src'], allExist)
    expect(r.files).toEqual(['src/a.py', 'src/b.py'])
  })

  it('treats a file under a nested owned root and matches the root exactly', () => {
    const r = selectMutationScope(['pkg/m.py', 'pkgother/n.py'], ['pkg'], allExist)
    expect(r.files).toEqual(['pkg/m.py']) // pkgother is NOT under pkg (prefix-with-/ guard)
    expect(r.unmatched).toEqual(['pkgother/n.py'])
  })

  it('empty input ⇒ empty scope (a no-op the caller turns into ran:false)', () => {
    expect(selectMutationScope([], ['src'], allExist)).toEqual({ files: [], unmatched: [] })
  })

  it('only non-.py changes ⇒ empty scope, no unmatched (nothing Python to mutate)', () => {
    expect(selectMutationScope(['README.md', 'pkg.json'], ['src'], allExist)).toEqual({
      files: [],
      unmatched: [],
    })
  })

  it('no owned roots ⇒ every .py is out-of-tree (never silently scoped)', () => {
    const r = selectMutationScope(['src/a.py'], [], allExist)
    expect(r.files).toEqual([])
    expect(r.unmatched).toEqual(['src/a.py'])
  })
})

describe('reconcileScope — partial-under-scope guard (ADR 0010 addendum 2, slice D)', () => {
  const metrics = (totalMutants: number): MutationMetrics => ({
    counts: {
      killed: 0,
      survived: 0,
      timeout: 0,
      noCoverage: 0,
      compileErrors: 0,
      runtimeErrors: 0,
      ignored: 0,
      pending: 0,
    },
    detected: 0,
    undetected: 0,
    covered: 0,
    valid: totalMutants,
    invalid: 0,
    totalMutants,
    mutationScore: totalMutants > 0 ? 100 : null,
    mutationScoreBasedOnCoveredCode: null,
  })
  const file = (path: string, totalMutants: number): FileSummary => ({
    path,
    metrics: metrics(totalMutants),
  })
  const summary = (files: FileSummary[]): MutationSummary => ({
    metrics: metrics(0),
    files,
    survivors: [],
  })

  it('all selected files mutated ⇒ mutatedFiles, no missing', () => {
    const s = summary([file('src/a.py', 3), file('src/b.py', 2)])
    const r = reconcileScope(['src/a.py', 'src/b.py'], s)
    expect(r.mutatedFiles).toEqual(['src/a.py', 'src/b.py'])
    expect(r.missing).toEqual([])
  })

  it('a selected file ABSENT from the summary is MISSING — the partial-scope sentinel', () => {
    // The tool mutated a.py but never SAW b.py (synthesis/scope bug). b.py must be flagged.
    const s = summary([file('src/a.py', 3)])
    const r = reconcileScope(['src/a.py', 'src/b.py'], s)
    expect(r.mutatedFiles).toEqual(['src/a.py'])
    expect(r.missing).toEqual(['src/b.py'])
  })

  it('a selected file SEEN-but-empty (0 mutants) is benign — NOT missing, NOT mutated', () => {
    // The tool saw b.py and found no mutable code (constants/re-exports) — a real clean no-op.
    const s = summary([file('src/a.py', 3), file('src/b.py', 0)])
    const r = reconcileScope(['src/a.py', 'src/b.py'], s)
    expect(r.mutatedFiles).toEqual(['src/a.py'])
    expect(r.missing).toEqual([])
  })

  it('reports only SELECTED files as mutated (a tool that over-mutated is not double-counted)', () => {
    const s = summary([file('src/a.py', 3), file('src/extra.py', 5)])
    const r = reconcileScope(['src/a.py'], s)
    expect(r.mutatedFiles).toEqual(['src/a.py'])
    expect(r.missing).toEqual([])
  })

  it('normalizes paths on both sides before comparing', () => {
    const s = summary([file('./src/a.py', 2)])
    const r = reconcileScope(['src/a.py'], s)
    expect(r.missing).toEqual([])
    expect(r.mutatedFiles).toEqual(['src/a.py'])
  })

  it('empty selection ⇒ nothing to reconcile', () => {
    expect(reconcileScope([], summary([file('src/a.py', 3)]))).toEqual({
      mutatedFiles: [],
      missing: [],
    })
  })
})
