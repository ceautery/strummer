import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MutateGateError, type MutationRunner, runMutation } from './run.js'

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
