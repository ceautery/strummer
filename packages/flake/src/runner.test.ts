import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FlakeGateError, runAndRecord, runAndRecordPytest, type TestRunner } from './runner.js'
import { HistoryStore } from './store.js'

const ROOT = '/abs/project'

/** A fake runner that writes a vitest json report to the requested --outputFile. */
function fakeRunner(reportFor: (iteration: number) => unknown): {
  runner: TestRunner
  argvs: string[][]
} {
  const argvs: string[][] = []
  let iteration = 0
  const runner: TestRunner = async (argv, _opts) => {
    argvs.push(argv)
    const outArg = argv.find((a) => a.startsWith('--outputFile='))
    const report = reportFor(iteration++)
    if (outArg) writeFileSync(outArg.slice('--outputFile='.length), JSON.stringify(report))
    const failed = JSON.stringify(report).includes('"status":"failed"')
    return { exitCode: failed ? 1 : 0, stdout: '', stderr: '' }
  }
  return { runner, argvs }
}

function report(alternatingPassed: boolean): unknown {
  return {
    testResults: [
      {
        name: `${ROOT}/src/a.test.ts`,
        assertionResults: [{ ancestorTitles: ['stable'], title: 'always ok', status: 'passed' }],
      },
      {
        name: `${ROOT}/src/b.test.ts`,
        assertionResults: [
          {
            ancestorTitles: ['shaky'],
            title: 'sometimes fails',
            status: alternatingPassed ? 'passed' : 'failed',
          },
        ],
      },
    ],
  }
}

function cfg(over: Record<string, unknown> = {}) {
  return { projectRoot: ROOT, allowedRoots: [ROOT], allowRun: true, ...over } as Parameters<
    typeof runAndRecord
  >[1]
}

describe('runAndRecord gate', () => {
  it('denies when allowRun is false', async () => {
    const store = HistoryStore.memory()
    await expect(runAndRecord(store, cfg({ allowRun: false }), {}, {})).rejects.toBeInstanceOf(
      FlakeGateError,
    )
    store.close()
  })

  it('a FlakeGateError is branded as a gate denial (ADR 0013 Addendum — cross-pillar contract)', () => {
    const err = new FlakeGateError('nope') as unknown as Record<symbol, unknown>
    expect(err[Symbol.for('sackville.gate-denial')]).toBe(true)
  })

  it('denies when the project root is not allowlisted', async () => {
    const store = HistoryStore.memory()
    await expect(
      runAndRecord(store, cfg({ allowedRoots: ['/other'] }), {}, {}),
    ).rejects.toBeInstanceOf(FlakeGateError)
    store.close()
  })
})

describe('runAndRecord', () => {
  it('runs the suite `repeat` times, records each outcome, and classifies', async () => {
    const store = HistoryStore.memory()
    try {
      const { runner, argvs } = fakeRunner((i) => report(i % 2 === 1)) // fail, pass, fail
      const result = await runAndRecord(store, cfg(), { repeat: 3, runGroup: 'batch' }, { runner })

      expect(result.ran).toBe(true)
      expect(result.iterations).toBe(3)
      expect(result.recorded).toBe(6) // 2 tests × 3 runs
      expect(result.results.map((r) => r.passed)).toEqual([false, true, false])

      // argv carries the json reporter + a per-iteration outputFile.
      expect(argvs[0]?.[0]).toBe('run')
      expect(argvs[0]).toContain('--reporter=json')
      expect(argvs.every((a) => a.some((t) => t.startsWith('--outputFile=')))).toBe(true)

      // The shaky test is recorded with a file-relative id and is flaky.
      const shaky = store.history('src/b.test.ts > shaky > sometimes fails')
      expect(shaky.runs.map((r) => r.passed)).toEqual([false, true, false])
      const verdict = result.verdicts.find((v) => v.id === shaky.id)
      expect(verdict?.state).toBe('flaky')
    } finally {
      store.close()
    }
  })

  it('passes positional file filters through to the runner', async () => {
    const store = HistoryStore.memory()
    try {
      const { runner, argvs } = fakeRunner(() => report(true))
      await runAndRecord(store, cfg(), { files: ['src/b.test.ts'] }, { runner })
      expect(argvs[0]).toContain('src/b.test.ts')
    } finally {
      store.close()
    }
  })

  it('related mode runs `vitest related <changed> --run` (diff-scoping, mirrors coverage runScoped)', async () => {
    const store = HistoryStore.memory()
    try {
      const { runner, argvs } = fakeRunner(() => report(true))
      await runAndRecord(
        store,
        cfg(),
        { files: ['src/b.ts'], related: true, repeat: 2 },
        { runner },
      )
      // changed SOURCE files become `vitest related` operands, not positional `run` filters.
      expect(argvs[0]?.[0]).toBe('related')
      expect(argvs[0]).toContain('src/b.ts')
      expect(argvs[0]).toContain('--run')
      expect(argvs[0]).toContain('--reporter=json')
    } finally {
      store.close()
    }
  })

  it('related mode with no changed files is a pre-spawn noop (ran:false), never spawns', async () => {
    const store = HistoryStore.memory()
    try {
      let called = false
      const runner: TestRunner = async () => {
        called = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      const result = await runAndRecord(store, cfg(), { related: true, files: [] }, { runner })
      expect(result.ran).toBe(false)
      expect(called).toBe(false)
    } finally {
      store.close()
    }
  })

  it('throws when a run produces no report file', async () => {
    const store = HistoryStore.memory()
    try {
      const runner: TestRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
      await expect(runAndRecord(store, cfg(), {}, { runner })).rejects.toThrow(/report/i)
    } finally {
      store.close()
    }
  })
})

/** A fake runner that writes a pytest-json-report to the requested --json-report-file. */
function fakePytestRunner(reportFor: (iteration: number) => unknown): {
  runner: TestRunner
  argvs: string[][]
} {
  const argvs: string[][] = []
  let iteration = 0
  const runner: TestRunner = async (argv, _opts) => {
    argvs.push(argv)
    const outArg = argv.find((a) => a.startsWith('--json-report-file='))
    const report = reportFor(iteration++)
    if (outArg) writeFileSync(outArg.slice('--json-report-file='.length), JSON.stringify(report))
    const failed = JSON.stringify(report).includes('"outcome":"failed"')
    return { exitCode: failed ? 1 : 0, stdout: '', stderr: '' }
  }
  return { runner, argvs }
}

function pytestReport(shakyPassed: boolean): unknown {
  return {
    tests: [
      { nodeid: 'tests/test_a.py::test_always_ok', outcome: 'passed' },
      { nodeid: 'tests/test_b.py::test_sometimes', outcome: shakyPassed ? 'passed' : 'failed' },
    ],
  }
}

describe('runAndRecordPytest', () => {
  it('denies through the same paired gate', async () => {
    const store = HistoryStore.memory()
    await expect(
      runAndRecordPytest(store, cfg({ allowRun: false }), {}, {}),
    ).rejects.toBeInstanceOf(FlakeGateError)
    store.close()
  })

  it('refuses related (diff) mode for pytest — vitest-only; pytest scoping is staged', async () => {
    const store = HistoryStore.memory()
    try {
      await expect(
        runAndRecordPytest(store, cfg(), { related: true, files: ['pkg/x.py'] }, {}),
      ).rejects.toThrow(/related|vitest/i)
    } finally {
      store.close()
    }
  })

  it('runs pytest `repeat` times, ingests the json-report, and classifies (nodeid verbatim)', async () => {
    const store = HistoryStore.memory()
    try {
      const { runner, argvs } = fakePytestRunner((i) => pytestReport(i % 2 === 1)) // fail, pass, fail
      const result = await runAndRecordPytest(store, cfg(), { repeat: 3 }, { runner })

      expect(result.ran).toBe(true)
      expect(result.iterations).toBe(3)
      expect(result.recorded).toBe(6) // 2 tests × 3 runs
      expect(result.results.map((r) => r.passed)).toEqual([false, true, false])

      // argv carries the pytest-json-report plugin flags + a per-iteration report file.
      expect(argvs[0]).toContain('--json-report')
      expect(argvs.every((a) => a.some((t) => t.startsWith('--json-report-file=')))).toBe(true)
      // No vitest `run` subcommand leaks into the pytest argv.
      expect(argvs[0]?.[0]).not.toBe('run')

      // pytest's nodeid is used verbatim (no ancestorTitles reconstruction).
      const shaky = store.history('tests/test_b.py::test_sometimes')
      expect(shaky.runs.map((r) => r.passed)).toEqual([false, true, false])
      expect(result.verdicts.find((v) => v.id === shaky.id)?.state).toBe('flaky')
    } finally {
      store.close()
    }
  })

  it('passes positional file filters through to pytest', async () => {
    const store = HistoryStore.memory()
    try {
      const { runner, argvs } = fakePytestRunner(() => pytestReport(true))
      await runAndRecordPytest(store, cfg(), { files: ['tests/test_b.py'] }, { runner })
      expect(argvs[0]).toContain('tests/test_b.py')
    } finally {
      store.close()
    }
  })
})

// Guard: the default runners exist and are functions (the live subprocess path; not spawned here).
it('exposes default vitest + pytest runners', async () => {
  const mod = await import('./runner.js')
  expect(typeof mod.defaultVitestRunner).toBe('function')
  expect(typeof mod.defaultPytestRunner).toBe('function')
})
