import { describe, expect, it } from 'vitest'
import { isTestFile, mirroredTestCandidates, selectPytestScope } from './pyscope.js'

describe('isTestFile', () => {
  it.each([
    ['tests/test_calc.py', true],
    ['test_calc.py', true],
    ['calc_test.py', true],
    ['pkg/tests/helpers.py', true], // any .py under a tests/ dir
    ['calc.py', false],
    ['pkg/calc.py', false],
    ['tests/fixtures/data.json', false], // not .py
  ])('%s -> %s', (path, expected) => {
    expect(isTestFile(path)).toBe(expected)
  })
})

describe('mirroredTestCandidates', () => {
  it('offers same-dir, tests/ sibling, and top-level tests/ candidates', () => {
    expect(mirroredTestCandidates('src/calc.py')).toEqual([
      'src/test_calc.py',
      'src/calc_test.py',
      'src/tests/test_calc.py',
      'tests/test_calc.py',
    ])
  })

  it('handles a top-level (dir-less) source file', () => {
    expect(mirroredTestCandidates('calc.py')).toEqual([
      'test_calc.py',
      'calc_test.py',
      'tests/test_calc.py',
      'tests/test_calc.py',
    ])
  })

  it('ignores non-.py files', () => {
    expect(mirroredTestCandidates('calc.ts')).toEqual([])
  })
})

describe('selectPytestScope', () => {
  const isTest = (p: string) => p === 'tests/test_calc.py'

  it('selects a changed test file directly', () => {
    const scope = selectPytestScope(['tests/test_calc.py'], 'report-gap', isTest)
    expect(scope.selectors).toEqual(['tests/test_calc.py'])
    expect(scope.unmatched).toEqual([])
    expect(scope.widened).toBe(false)
  })

  it('maps a changed source file to its mirrored test', () => {
    const scope = selectPytestScope(['calc.py'], 'report-gap', (p) => p === 'tests/test_calc.py')
    expect(scope.selectors).toContain('tests/test_calc.py')
    expect(scope.unmatched).toEqual([])
  })

  it('report-gap mode: a source with no test is reported as a gap, matched tests still run', () => {
    const scope = selectPytestScope(
      ['calc.py', 'orphan.py'],
      'report-gap',
      (p) => p === 'tests/test_calc.py',
    )
    expect(scope.selectors).toContain('tests/test_calc.py')
    expect(scope.unmatched).toEqual(['orphan.py'])
    expect(scope.widened).toBe(false)
  })

  it('widen mode: a source with no test widens to the whole suite (no selectors)', () => {
    const scope = selectPytestScope(['orphan.py'], 'widen', () => false)
    expect(scope.selectors).toEqual([])
    expect(scope.widened).toBe(true)
    expect(scope.unmatched).toEqual(['orphan.py'])
  })

  it('ignores non-.py changes (cannot be scoped to a pytest test)', () => {
    const scope = selectPytestScope(['README.md', 'data.json'], 'report-gap', () => false)
    expect(scope.selectors).toEqual([])
    expect(scope.unmatched).toEqual([])
    expect(scope.widened).toBe(false)
  })

  it('dedupes selectors when two sources map to the same mirrored test', () => {
    // both resolve only the top-level tests/test_calc.py candidate
    const scope = selectPytestScope(['calc.py', 'src/calc.py'], 'report-gap', (p) =>
      p.endsWith('tests/test_calc.py'),
    )
    expect(scope.selectors.filter((s) => s === 'tests/test_calc.py')).toHaveLength(1)
  })
})
