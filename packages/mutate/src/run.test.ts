import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MutateGateError,
  type MutationRunner,
  runCosmicRay,
  runMutation,
  runMutmut,
} from './run.js'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/mutation-report.json',
)
const ROOT = '/abs/project'

let dir: string
let reportPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strummer-mutate-'))
  reportPath = join(dir, 'mutation.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A fake stryker that "writes" a report by copying the golden fixture to the report path. */
function fakeRunner(exitCode = 0): { runner: MutationRunner; argvs: string[][] } {
  const argvs: string[][] = []
  const runner: MutationRunner = async (argv) => {
    argvs.push(argv)
    copyFileSync(FIXTURE, reportPath)
    return { exitCode, stdout: '', stderr: '' }
  }
  return { runner, argvs }
}

function cfg(over: Record<string, unknown> = {}) {
  return { projectRoot: ROOT, allowedRoots: [ROOT], allowRun: true, ...over } as Parameters<
    typeof runMutation
  >[0]
}

describe('runMutation gate', () => {
  it('denies when allowRun is false', async () => {
    await expect(runMutation(cfg({ allowRun: false }), {}, { reportPath })).rejects.toBeInstanceOf(
      MutateGateError,
    )
  })

  it('a MutateGateError is branded as a gate denial (ADR 0013 Addendum — cross-pillar contract)', () => {
    const err = new MutateGateError('nope') as unknown as Record<symbol, unknown>
    expect(err[Symbol.for('strummer.gate-denial')]).toBe(true)
  })

  it('denies when the root is not allowlisted', async () => {
    await expect(
      runMutation(cfg({ allowedRoots: ['/other'] }), {}, { reportPath }),
    ).rejects.toBeInstanceOf(MutateGateError)
  })
})

describe('runMutation', () => {
  it('runs stryker, reads the report, and summarizes', async () => {
    const { runner, argvs } = fakeRunner()
    const result = await runMutation(cfg(), {}, { runner, reportPath })
    expect(result.ran).toBe(true)
    expect(argvs[0]?.[0]).toBe('run')
    expect(argvs[0]).toContain('--reporters')
    expect(result.summary.metrics.mutationScore).toBeCloseTo(40, 6)
    expect(result.summary.survivors).toHaveLength(3)
    expect(result.exitCode).toBe(0)
  })

  it('scopes to changed files via --mutate (diff-scoped)', async () => {
    const { runner, argvs } = fakeRunner()
    await runMutation(cfg(), { mutateFiles: ['src/a.ts', 'src/b.ts'] }, { runner, reportPath })
    const mIdx = argvs[0]?.indexOf('--mutate') ?? -1
    expect(mIdx).toBeGreaterThanOrEqual(0)
    expect(argvs[0]?.[mIdx + 1]).toBe('src/a.ts,src/b.ts')
  })

  it('adds --incremental when requested', async () => {
    const { runner, argvs } = fakeRunner()
    await runMutation(cfg(), { incremental: true }, { runner, reportPath })
    expect(argvs[0]).toContain('--incremental')
  })

  it('surfaces a non-zero stryker exit (score below break threshold)', async () => {
    const { runner } = fakeRunner(1)
    const result = await runMutation(cfg(), {}, { runner, reportPath })
    expect(result.exitCode).toBe(1)
  })

  it('throws when stryker produced no report', async () => {
    const runner: MutationRunner = async () => ({ exitCode: 0, stdout: '', stderr: '' })
    await expect(runMutation(cfg(), {}, { runner, reportPath })).rejects.toThrow(/report/i)
  })
})

/** A fake runner keyed by the leading verb (argv[0]); records the argv sequence. */
function byVerb(responses: Record<string, { exitCode?: number; stdout?: string }>): {
  runner: MutationRunner
  argvs: string[][]
} {
  const argvs: string[][] = []
  const runner: MutationRunner = async (argv) => {
    argvs.push(argv)
    const r = responses[argv[0] ?? ''] ?? {}
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: '' }
  }
  return { runner, argvs }
}

describe('runMutmut', () => {
  it('denies through the paired gate', async () => {
    const { runner } = byVerb({})
    await expect(runMutmut(cfg({ allowRun: false }), {}, { runner })).rejects.toBeInstanceOf(
      MutateGateError,
    )
  })

  it('runs mutmut, parses `mutmut results` stdout, and summarizes (stdout-fed, no report file)', async () => {
    const results = ['calc.x_add__mutmut_1: killed', 'calc.x_sub__mutmut_1: survived'].join('\n')
    const { runner, argvs } = byVerb({ run: { exitCode: 1 }, results: { stdout: results } })
    const result = await runMutmut(cfg(), {}, { runner })

    expect(result.tool).toBe('mutmut')
    expect(result.reportPath).toBeUndefined() // Python tools emit to stdout
    expect(argvs[0]?.[0]).toBe('run')
    expect(argvs[1]).toEqual(['results', '--all', 'true'])
    expect(result.summary.metrics.counts).toMatchObject({ killed: 1, survived: 1 })
    expect(result.summary.survivors).toHaveLength(1)
  })

  it('treats an empty results set as inconclusive (never a clean pass)', async () => {
    const { runner } = byVerb({ run: {}, results: { stdout: '' } })
    await expect(runMutmut(cfg(), {}, { runner })).rejects.toThrow(/inconclusive|no mutants/i)
  })
})

describe('runCosmicRay', () => {
  const DUMP = [
    '[{"mutations":[{"module_path":"calc.py","operator_name":"core/Op1","start_pos":[2,13]}]},{"worker_outcome":"normal","test_outcome":"killed"}]',
    '[{"mutations":[{"module_path":"calc.py","operator_name":"core/Op2","start_pos":[10,13]}]},{"worker_outcome":"normal","test_outcome":"survived"}]',
  ].join('\n')

  it('denies through the paired gate', async () => {
    const { runner } = byVerb({})
    await expect(runCosmicRay(cfg({ allowRun: false }), {}, { runner })).rejects.toBeInstanceOf(
      MutateGateError,
    )
  })

  it('drives init→exec→dump, parses the dump stdout, and summarizes', async () => {
    const { runner, argvs } = byVerb({ init: {}, exec: { exitCode: 0 }, dump: { stdout: DUMP } })
    const result = await runCosmicRay(cfg(), {}, { runner, sessionDir: dir })

    expect(result.tool).toBe('cosmic-ray')
    expect(result.reportPath).toBeUndefined()
    expect(argvs.map((a) => a[0])).toEqual(['init', 'exec', 'dump'])
    // init/exec carry the config path; dump reads the session.
    expect(argvs[0]).toContain('cosmic-ray.toml')
    expect(result.summary.metrics.counts).toMatchObject({ killed: 1, survived: 1 })
    expect(result.summary.survivors[0]).toMatchObject({ file: 'calc.py', line: 10 })
  })

  it('uses an operator-supplied config path', async () => {
    const { runner, argvs } = byVerb({ init: {}, exec: {}, dump: { stdout: DUMP } })
    await runCosmicRay(cfg(), { configPath: 'mutation/cr.toml' }, { runner, sessionDir: dir })
    expect(argvs[0]).toContain('mutation/cr.toml')
  })

  it('is inconclusive when the session has unexecuted (pending) mutants — never a clean pass', async () => {
    const withPending = `${DUMP}\n[{"mutations":[{"module_path":"calc.py","operator_name":"core/Op3","start_pos":[2,13]}]},null]`
    const { runner } = byVerb({ init: {}, exec: {}, dump: { stdout: withPending } })
    await expect(runCosmicRay(cfg(), {}, { runner, sessionDir: dir })).rejects.toThrow(
      /incomplete|pending|inconclusive/i,
    )
  })

  it('is inconclusive when no mutants were produced (empty/failed session)', async () => {
    const { runner } = byVerb({ init: {}, exec: { exitCode: 1 }, dump: { stdout: '' } })
    await expect(runCosmicRay(cfg(), {}, { runner, sessionDir: dir })).rejects.toThrow(
      /inconclusive|no mutants/i,
    )
  })
})
