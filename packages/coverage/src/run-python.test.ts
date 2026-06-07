import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CoverageGateError, type TestRunner } from './run.js'
import { runScopedPython } from './run-python.js'

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), '../test/fixtures/coverage.json')
const ROOT = '/abs/project'

// A diff that adds the untested `mul` branch (new-side lines 10/11/12) to calc.py.
const DIFF = `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -9,1 +9,4 @@
 def mul(a, b):
+    if b == 0:
+        return 0
+    return a * b
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sackville-cov-py-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function cfg(over: Record<string, unknown> = {}) {
  return { projectRoot: ROOT, allowedRoots: [ROOT], allowRun: true, ...over } as Parameters<
    typeof runScopedPython
  >[0]
}

/** A fake pytest that writes the golden coverage.json to the `--cov-report=json:<path>` target. */
function fakeRunner(exitCode = 0): { runner: TestRunner; argvs: string[][] } {
  const argvs: string[][] = []
  const runner: TestRunner = async (argv) => {
    argvs.push(argv)
    const out = argv
      .find((a) => a.startsWith('--cov-report=json:'))
      ?.slice('--cov-report=json:'.length)
    if (out) copyFileSync(FIXTURE, out)
    return { exitCode, stdout: '', stderr: '' }
  }
  return { runner, argvs }
}

// The pure `selectPytestScope` unit tests live with the heuristic in @sackville-mcp/pyscope.
// Here we exercise it only through `runScopedPython` (the integration path) below.

describe('runScopedPython gate', () => {
  it('denies when allowRun is false', async () => {
    await expect(
      runScopedPython(
        cfg({ allowRun: false }),
        { changedFiles: ['calc.py'], measureTargets: ['calc'] },
        {},
      ),
    ).rejects.toBeInstanceOf(CoverageGateError)
  })
})

describe('runScopedPython', () => {
  it('is a no-op when nothing changed', async () => {
    const { runner } = fakeRunner()
    const r = await runScopedPython(
      cfg(),
      { changedFiles: [], measureTargets: ['calc'] },
      { runner },
    )
    expect(r.ran).toBe(false)
  })

  it('runs pytest --cov, converts coverage.py JSON, and reports uncovered new lines', async () => {
    const { runner, argvs } = fakeRunner(0)
    const r = await runScopedPython(
      cfg(),
      { changedFiles: ['calc.py'], diff: DIFF, measureTargets: ['calc'] },
      { runner, coverageDir: dir, testExists: (p) => p === 'tests/test_calc.py' },
    )
    expect(r.ran).toBe(true)
    expect(r.passed).toBe(true)
    expect(r.inconclusive).toBeFalsy()
    // argv carries the coverage targets + json report + the mirrored test selector.
    expect(argvs[0]).toContain('--cov=calc')
    expect(argvs[0]?.some((a) => a.startsWith('--cov-report=json:'))).toBe(true)
    expect(argvs[0]).toContain('tests/test_calc.py')
    // The untested mul branch (new lines 10-12) is surfaced as uncovered.
    expect(r.report?.uncovered.map((u) => u.line).sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  it('maps pytest exit 5 (no tests collected) to inconclusive, never a clean pass', async () => {
    const runner: TestRunner = async () => ({ exitCode: 5, stdout: '', stderr: '' })
    const r = await runScopedPython(
      cfg(),
      { changedFiles: ['calc.py'], diff: DIFF, measureTargets: ['calc'], scopeMode: 'widen' },
      { runner, coverageDir: dir, testExists: () => false },
    )
    expect(r.inconclusive).toBe(true)
    expect(r.passed).toBe(false)
    expect(r.report).toBeUndefined() // never produce a misleading clean report
  })
})
