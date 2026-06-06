import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CoverageGateError, runnerEnv, runScoped, type TestRunner } from './run.js'
import type { FileCoverage } from './uncovered.js'

const tmpDirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sackville-runscoped-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

const root = '/abs/repo'

/** A fake runner that records its argv and writes a coverage-final.json into the dir. */
function fakeRunner(coverage: Record<string, FileCoverage>, exitCode = 0) {
  const calls: { argv: string[]; cwd: string }[] = []
  const runner: TestRunner = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd })
    // The reportsDirectory is the last coverage flag; derive it the way runScoped passes it.
    const dirFlag = argv.find((a) => a.startsWith('--coverage.reportsDirectory='))
    const dir = dirFlag?.split('=')[1] as string
    writeFileSync(join(dir, 'coverage-final.json'), JSON.stringify(coverage))
    return { exitCode, stdout: '', stderr: '' }
  }
  return { runner, calls }
}

const mathCoverage = (path: string): Record<string, FileCoverage> => ({
  [path]: {
    path,
    statementMap: {
      '0': { start: { line: 2, column: 2 }, end: { line: 2, column: 9 } },
      '1': { start: { line: 4, column: 2 }, end: { line: 4, column: 9 } },
    },
    s: { '0': 1, '1': 0 },
  },
})

const allowed = { projectRoot: root, allowedRoots: [root], allowRun: true }

describe('runScoped — gated, impact-scoped vitest run (injected runner)', () => {
  it('refuses to run unless the operator opted in (deny-by-default)', async () => {
    await expect(
      runScoped({ ...allowed, allowRun: false }, { changedFiles: ['src/math.ts'] }),
    ).rejects.toBeInstanceOf(CoverageGateError)
  })

  it('a CoverageGateError is branded as a gate denial (ADR 0013 Addendum — cross-pillar contract)', () => {
    const err = new CoverageGateError('nope') as unknown as Record<symbol, unknown>
    expect(err[Symbol.for('sackville.gate-denial')]).toBe(true)
  })

  it('refuses a project root that is not on the operator allowlist', async () => {
    await expect(
      runScoped(
        { projectRoot: '/somewhere/else', allowedRoots: [root], allowRun: true },
        { changedFiles: ['src/math.ts'] },
      ),
    ).rejects.toThrow(/allowlist/i)
  })

  it('scopes the run to the changed files with coverage + json reporter', async () => {
    const { runner, calls } = fakeRunner({})
    await runScoped(
      allowed,
      { changedFiles: ['src/a.ts', 'src/b.ts'] },
      { runner, coverageDir: tmp() },
    )
    const argv = calls[0]?.argv ?? []
    expect(argv[0]).toBe('related')
    expect(argv).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', '--run']))
    expect(argv.some((a) => a.startsWith('--coverage.reporter=json'))).toBe(true)
    expect(argv.some((a) => a === '--coverage.enabled=true')).toBe(true)
    expect(calls[0]?.cwd).toBe(root)
  })

  it('collects the produced coverage-final.json and reports pass/fail from the exit code', async () => {
    const { runner } = fakeRunner(mathCoverage('/abs/repo/src/math.ts'))
    const result = await runScoped(
      allowed,
      { changedFiles: ['src/math.ts'] },
      { runner, coverageDir: tmp() },
    )
    expect(result.ran).toBe(true)
    expect(result.passed).toBe(true)
    expect(result.coverage['/abs/repo/src/math.ts']).toBeDefined()
  })

  it('marks the run failed (passed:false) when the runner exits non-zero', async () => {
    const { runner } = fakeRunner({}, 1)
    const result = await runScoped(
      allowed,
      { changedFiles: ['src/math.ts'] },
      { runner, coverageDir: tmp() },
    )
    expect(result.exitCode).toBe(1)
    expect(result.passed).toBe(false)
  })

  it('feeds the produced coverage into uncoveredInDiff when a diff is supplied', async () => {
    const { runner } = fakeRunner(mathCoverage('/abs/repo/src/math.ts'))
    const diff = `--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,5 @@
 const a = 1
+const b = 2
+
+const c = noTest()
 const d = 4
`
    const result = await runScoped(
      { ...allowed, projectRoot: root },
      { changedFiles: ['src/math.ts'], diff },
      { runner, coverageDir: tmp() },
    )
    // Added lines 2 (covered), 3 (nonExecutable), 4 (uncovered) → the catch is line 4.
    expect(result.report?.uncovered).toEqual([{ path: 'src/math.ts', line: 4 }])
  })

  it('is a no-op (does not invoke the runner) when no files changed', async () => {
    const { runner, calls } = fakeRunner({})
    const result = await runScoped(allowed, { changedFiles: [] }, { runner, coverageDir: tmp() })
    expect(result.ran).toBe(false)
    expect(result.passed).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('throws a clear error if the coverage report was not produced', async () => {
    const runner: TestRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    await expect(
      runScoped(allowed, { changedFiles: ['src/math.ts'] }, { runner, coverageDir: tmp() }),
    ).rejects.toThrow(/coverage/i)
    // sanity: the file really is absent
    expect(() => readFileSync(join(tmp(), 'coverage-final.json'))).toThrow()
  })

  it('surfaces the runner exit code AND its output tail when no report is produced (debuggable failure)', async () => {
    // The real footgun: `vitest` is not resolvable, the subprocess dies, and the
    // engine used to throw an opaque "did not produce a coverage report" with no clue.
    const runner: TestRunner = async () => ({
      exitCode: 127,
      stdout: 'some stdout noise\n',
      stderr: 'env: vitest: No such file or directory\n',
    })
    const err = await runScoped(
      allowed,
      { changedFiles: ['src/math.ts'] },
      { runner, coverageDir: tmp() },
    ).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toMatch(/exit code 127/)
    // The runner's own output is included so the user sees WHY it failed.
    expect(err?.message).toContain('vitest: No such file or directory')
  })
})

describe('runnerEnv — prepends the project-local node_modules/.bin to PATH', () => {
  it('puts <cwd>/node_modules/.bin first so a project-local vitest/pytest is found', () => {
    const env = runnerEnv('/abs/repo', { PATH: '/usr/bin' })
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env.PATH).toBe(`${join('/abs/repo', 'node_modules', '.bin')}${sep}/usr/bin`)
  })

  it('works when PATH is unset and never mutates the input env', () => {
    const input = { FOO: 'bar' } as NodeJS.ProcessEnv
    const env = runnerEnv('/abs/repo', input)
    expect(env.PATH).toBe(join('/abs/repo', 'node_modules', '.bin'))
    expect(env.FOO).toBe('bar')
    expect(input.PATH).toBeUndefined() // input untouched
  })
})
