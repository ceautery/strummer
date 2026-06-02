import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileCoverage, TestRunner } from '@strummer/coverage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCoverage } from './coverage.js'
import { run } from './index.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

// A change adding lines 2 (covered), 3 (blank → non-executable), 4 (uncovered).
const DIFF = `--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,5 @@
 const a = 1
+const b = 2
+
+const c = noTest()
 const d = 4
`

const istanbul = (path: string): Record<string, FileCoverage> => ({
  [path]: {
    path,
    statementMap: {
      '0': { start: { line: 2, column: 2 }, end: { line: 2, column: 9 } },
      '1': { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
    },
    s: { '0': 1, '1': 0 },
  },
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strummer-cli-cov-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function diffFile(): string {
  const p = join(dir, 'changes.diff')
  writeFileSync(p, DIFF)
  return p
}

describe('strummer coverage CLI', () => {
  it('uncovered-in-diff surfaces the executable-but-unhit new line and exits 1', async () => {
    const cov = join(dir, 'coverage-final.json')
    writeFileSync(cov, JSON.stringify(istanbul('/repo/src/math.ts')))
    const c = capture()
    const code = await run(
      [
        'coverage',
        'uncovered-in-diff',
        '--diff',
        diffFile(),
        '--coverage',
        cov,
        '--project-root',
        '/repo',
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toMatch(/src\/math\.ts:4/)
  })

  it('uncovered-in-diff --json reports the structured report', async () => {
    const cov = join(dir, 'coverage-final.json')
    writeFileSync(cov, JSON.stringify(istanbul('/repo/src/math.ts')))
    const c = capture()
    const code = await run(
      [
        'coverage',
        'uncovered-in-diff',
        '--diff',
        diffFile(),
        '--coverage',
        cov,
        '--project-root',
        '/repo',
        '--json',
      ],
      c.io,
    )
    expect(code).toBe(1)
    const parsed = JSON.parse(c.out())
    expect(parsed.uncovered).toEqual([{ path: 'src/math.ts', line: 4 }])
  })

  it('uncovered-in-diff accepts a coverage.py report via --coverage-format', async () => {
    const pyDiff = join(dir, 'py.diff')
    writeFileSync(
      pyDiff,
      `--- a/src/math.py
+++ b/src/math.py
@@ -1,1 +1,4 @@
 def f(x):
+    y = x + 1
+    return y
+    z = never()
`,
    )
    const cov = join(dir, 'coverage.json')
    writeFileSync(
      cov,
      JSON.stringify({
        files: {
          '/repo/src/math.py': {
            executed_lines: [1, 2, 3],
            missing_lines: [4],
            excluded_lines: [],
          },
        },
      }),
    )
    const c = capture()
    const code = await run(
      [
        'coverage',
        'uncovered-in-diff',
        '--diff',
        pyDiff,
        '--coverage',
        cov,
        '--coverage-format',
        'coveragepy',
        '--project-root',
        '/repo',
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toMatch(/src\/math\.py:4/)
  })

  it('uncovered-in-diff without the required inputs errors', async () => {
    const c = capture()
    expect(await run(['coverage', 'uncovered-in-diff'], c.io)).toBe(1)
    expect(c.err()).toMatch(/--diff|--coverage/)
  })

  it('run-scoped is refused without --allow-run (deny-by-default, no spawn)', async () => {
    let spawned = false
    const runner: TestRunner = async () => {
      spawned = true
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runCoverage(['run-scoped', dir, '--changed-file', 'src/math.ts'], c.io, {
      runner,
    })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
    expect(c.err()).toMatch(/allow-run|not enabled/i)
  })

  it('run-scoped runs the injected runner and reports uncovered new lines', async () => {
    const runner: TestRunner = async (argv) => {
      const covDir = argv
        .find((a) => a.startsWith('--coverage.reportsDirectory='))
        ?.split('=')[1] as string
      writeFileSync(
        join(covDir, 'coverage-final.json'),
        JSON.stringify(istanbul(`${dir}/src/math.ts`)),
      )
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runCoverage(
      ['run-scoped', dir, '--changed-file', 'src/math.ts', '--diff', diffFile(), '--allow-run'],
      c.io,
      { runner },
    )
    // tests passed but a new line is uncovered → the forgotten-assertion catch fires (exit 1).
    expect(code).toBe(1)
    expect(c.out()).toMatch(/src\/math\.ts:4/)
  })

  it('unknown subcommand exits 1', async () => {
    const c = capture()
    expect(await runCoverage(['frobnicate'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown coverage subcommand/)
  })
})
