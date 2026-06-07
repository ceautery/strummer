/**
 * Pure pytest test-selection from a changed-file set — the shared "mirrored-test" scope
 * heuristic. Extracted from `@sackville-mcp/coverage` once `@sackville-mcp/flake` became a second
 * consumer (the same discipline that produced `@sackville-mcp/diff`/`severity`/`spawn`): a
 * zero-dependency leaf so a consumer can map changed sources to the tests that exercise them
 * WITHOUT importing a sibling pillar's run/spawn machinery.
 *
 * pytest has no built-in `vitest related` equivalent, so we derive a scope structurally: a changed
 * TEST file is a selector directly; a changed SOURCE file maps to a mirrored test
 * (`test_<x>.py` / `<x>_test.py` / `tests/test_<x>.py`) when one exists on disk. A changed source
 * that maps to NO confident test is `unmatched`, and the operator-visible `mode` decides the
 * fallback: `report-gap` (default — run the matched tests, report the unmatched source as a gap) or
 * `widen` (run the whole suite). The function is pure: all FS access is via the injected
 * `testExists` predicate, so it unit-tests with no disk.
 */

import { basename } from 'node:path'

/** Fallback when a changed source file maps to no confident test (operator-visible, ADR 0010 addendum). */
export type ScopeMode = 'report-gap' | 'widen'

/** A pytest test selection derived from a change. */
export interface PytestScope {
  /** pytest positional test targets (files). Empty ⇒ run the whole suite. */
  selectors: string[]
  /** Changed source files with no confident mirrored test. */
  unmatched: string[]
  /** True when the run was widened to the whole suite (the `widen` fallback). */
  widened: boolean
}

const TEST_FILE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/
const IN_TEST_DIR = /(?:^|\/)tests?\//

/** Whether a path is a pytest test file (a `test_*.py`/`*_test.py`, or any `.py` under a `tests/` dir). */
export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path) || (IN_TEST_DIR.test(path) && path.endsWith('.py'))
}

/** Candidate mirrored-test paths for a changed source file (same dir + a `tests/` sibling). */
export function mirroredTestCandidates(srcPath: string): string[] {
  if (!srcPath.endsWith('.py')) return []
  const slash = srcPath.lastIndexOf('/')
  const dir = slash === -1 ? '' : srcPath.slice(0, slash + 1)
  const stem = basename(srcPath).slice(0, -'.py'.length)
  return [
    `${dir}test_${stem}.py`,
    `${dir}${stem}_test.py`,
    `${dir}tests/test_${stem}.py`,
    `tests/test_${stem}.py`,
  ]
}

/**
 * Derive a pytest test scope from the changed files. A changed test file is a selector; a changed
 * source file maps to its mirrored test when `testExists` confirms one. A source with no test is
 * `unmatched`; the `mode` decides whether that widens to the whole suite (`widen`) or is reported
 * as a gap while the matched tests still run (`report-gap`). Pure (FS access via `testExists`).
 */
export function selectPytestScope(
  changedFiles: string[],
  mode: ScopeMode,
  testExists: (path: string) => boolean,
): PytestScope {
  const selectors = new Set<string>()
  const unmatched: string[] = []
  for (const file of changedFiles) {
    if (isTestFile(file)) {
      selectors.add(file)
      continue
    }
    if (!file.endsWith('.py')) continue // a non-Python change can't be scoped to a pytest test
    const found = mirroredTestCandidates(file).filter(testExists)
    if (found.length > 0) for (const t of found) selectors.add(t)
    else unmatched.push(file)
  }
  if (unmatched.length > 0 && mode === 'widen') {
    return { selectors: [], unmatched, widened: true }
  }
  return { selectors: [...selectors], unmatched, widened: false }
}
