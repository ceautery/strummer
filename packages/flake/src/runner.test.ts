import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FlakeGateError, runAndRecord, type TestRunner } from './runner.js'
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

// Guard: the default runner exists and is a function (the live subprocess path; not spawned here).
it('exposes a default vitest runner', async () => {
  const mod = await import('./runner.js')
  expect(typeof mod.defaultVitestRunner).toBe('function')
})
