import { describe, expect, it } from 'vitest'
import {
  pyPathToModule,
  reconcileMutmutScope,
  reconcileScope,
  selectMutationScope,
} from './scope.js'
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

  it('honors a custom isMutableSource predicate (Stryker JS/TS, not .py)', () => {
    const isTs = (p: string) => /\.(?:[cm]?js|[cm]?ts)x?$/.test(p) && !p.endsWith('.d.ts')
    const r = selectMutationScope(
      ['src/a.ts', 'src/b.tsx', 'src/c.py', 'src/d.d.ts', 'README.md'],
      ['src'],
      allExist,
      isTs,
    )
    expect(r.files).toEqual(['src/a.ts', 'src/b.tsx']) // .py/.d.ts/.md all dropped by the predicate
    expect(r.unmatched).toEqual([])
  })

  it("an ownedRoot of '.' means whole-project (no subtree confinement)", () => {
    const isTs = (p: string) => p.endsWith('.ts')
    const r = selectMutationScope(['src/a.ts', 'vendor/b.ts'], ['.'], allExist, isTs)
    expect(r.files).toEqual(['src/a.ts', 'vendor/b.ts'])
    expect(r.unmatched).toEqual([])
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

describe('pyPathToModule', () => {
  it('converts a source path to its dotted module form', () => {
    expect(pyPathToModule('pkg/calc.py')).toBe('pkg.calc')
    expect(pyPathToModule('a/b/c.py')).toBe('a.b.c')
  })
  it('maps a package __init__ to the package itself', () => {
    expect(pyPathToModule('pkg/__init__.py')).toBe('pkg')
  })
  it('normalizes backslashes and leading ./', () => {
    expect(pyPathToModule('./pkg\\calc.py')).toBe('pkg.calc')
  })
})

describe('reconcileMutmutScope — conservative, module-keyed (ADR 0010 addendum 2, Fork B2)', () => {
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
  // mutmut's summary is keyed by DOTTED MODULE, not path.
  const modSummary = (mods: [string, number][]): MutationSummary => ({
    metrics: metrics(0),
    files: mods.map(([path, n]) => ({ path, metrics: metrics(n) })),
    survivors: [],
  })

  it('matches a selected PATH against the mutated MODULE (flat layout)', () => {
    const r = reconcileMutmutScope(['pkg/calc.py'], modSummary([['pkg.calc', 3]]))
    expect(r.mutatedFiles).toEqual(['pkg/calc.py'])
    expect(r.missing).toEqual([])
  })

  it('tolerates a src-layout module via suffix match (src/pkg/calc.py ↔ pkg.calc)', () => {
    const r = reconcileMutmutScope(['src/pkg/calc.py'], modSummary([['pkg.calc', 2]]))
    expect(r.mutatedFiles).toEqual(['src/pkg/calc.py'])
    expect(r.missing).toEqual([])
  })

  it('a selected file with NO matching mutated module is MISSING — conservative (seen-but-empty == never-seen)', () => {
    // mutmut emits no record for a 0-mutant scoped file, so strutil is simply absent ⇒ missing.
    const r = reconcileMutmutScope(['pkg/calc.py', 'pkg/strutil.py'], modSummary([['pkg.calc', 3]]))
    expect(r.mutatedFiles).toEqual(['pkg/calc.py'])
    expect(r.missing).toEqual(['pkg/strutil.py'])
  })

  it('a module with zero mutants does not count as mutated (never a false pass)', () => {
    const r = reconcileMutmutScope(['pkg/calc.py'], modSummary([['pkg.calc', 0]]))
    expect(r.missing).toEqual(['pkg/calc.py'])
  })
})
