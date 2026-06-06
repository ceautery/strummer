import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  runnerEnv,
} from './run.js'

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../test/fixtures/mutation-report.json',
)
const ROOT = '/abs/project'

let dir: string
let reportPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sackville-mutate-'))
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
    expect(err[Symbol.for('sackville.gate-denial')]).toBe(true)
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

describe('runMutmut — diff-scoped (ADR 0010 addendum 2)', () => {
  let proj: string
  const results = (lines: string[]): string => lines.join('\n')

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'sackville-mm-proj-'))
    mkdirSync(join(proj, 'pkg'), { recursive: true })
    writeFileSync(join(proj, 'pkg', '__init__.py'), '')
    writeFileSync(join(proj, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(join(proj, 'pkg', 'strutil.py'), 'def shout(s):\n    return s.upper()\n')
    writeFileSync(join(proj, 'pyproject.toml'), '[tool.mutmut]\npaths_to_mutate = ["pkg"]\n')
  })
  afterEach(() => rmSync(proj, { recursive: true, force: true }))

  const pcfg = () => cfg({ projectRoot: proj, allowedRoots: [proj] })

  it('plans paths_to_mutate + also_copy into a sandbox pyproject and runs mutmut THERE', async () => {
    const argvs: { argv: string[]; cwd: string }[] = []
    let sandboxPyproject = ''
    const sandbox = join(dir, 'sandbox')
    const runner: MutationRunner = async (argv, opts) => {
      argvs.push({ argv, cwd: opts.cwd })
      if (argv[0] === 'run')
        sandboxPyproject = readFileSync(join(sandbox, 'pyproject.toml'), 'utf8')
      return {
        exitCode: 0,
        stdout: argv[0] === 'results' ? results(['pkg.calc.x_add__mutmut_1: killed']) : '',
        stderr: '',
      }
    }
    const result = await runMutmut(
      pcfg(),
      { mutateFiles: ['pkg/calc.py'] },
      { runner, sandboxDir: sandbox },
    )
    expect(result.ran).toBe(true)
    expect(result.scopedFiles).toEqual(['pkg/calc.py'])
    // ran in the sandbox, not projectRoot
    expect(argvs[0]?.cwd).toBe(sandbox)
    // scoped pyproject: calc mutated, the rest of pkg also_copy'd for imports
    expect(sandboxPyproject).toContain('paths_to_mutate = [ "pkg/calc.py" ]')
    expect(sandboxPyproject).toContain('pkg/__init__.py')
    expect(sandboxPyproject).toContain('pkg/strutil.py')
  })

  it('a fully out-of-tree scope is a pre-spawn noop (ran:false), never spawns', async () => {
    const { runner, argvs } = byVerb({})
    const result = await runMutmut(pcfg(), { mutateFiles: ['other/x.py'] }, { runner })
    expect(result.ran).toBe(false)
    expect(result.scopeEmpty).toBe(true)
    expect(result.unmatched).toEqual(['other/x.py'])
    expect(argvs).toEqual([])
  })

  it('a selected file with no mutants ⇒ inconclusive (Fork B2 conservative reconcile)', async () => {
    // selected calc + strutil, but results only carry calc — strutil yielded no mutants ⇒ inconclusive.
    const runner: MutationRunner = async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === 'results' ? results(['pkg.calc.x_add__mutmut_1: killed']) : '',
      stderr: '',
    })
    await expect(
      runMutmut(
        pcfg(),
        { mutateFiles: ['pkg/calc.py', 'pkg/strutil.py'] },
        { runner, sandboxDir: join(dir, 'sb2') },
      ),
    ).rejects.toThrow(/under-scoped|no mutants|inconclusive/i)
  })

  it('a broken scoped baseline ("not checked" ⇒ Pending) is inconclusive (the baseline-smoke gate)', async () => {
    const runner: MutationRunner = async (argv) => ({
      exitCode: 0,
      stdout: argv[0] === 'results' ? results(['pkg.calc.x_add__mutmut_1: not checked']) : '',
      stderr: '',
    })
    await expect(
      runMutmut(pcfg(), { mutateFiles: ['pkg/calc.py'] }, { runner, sandboxDir: join(dir, 'sb3') }),
    ).rejects.toThrow(/incomplete|pending|inconclusive/i)
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

describe('runCosmicRay — diff-scoped (ADR 0010 addendum 2)', () => {
  let proj: string
  /** A scoped dump keyed by relative module_path (matches what cosmic-ray reports for a relative config). */
  const dumpFor = (paths: string[]): string =>
    paths
      .map(
        (p) =>
          `[{"mutations":[{"module_path":"${p}","operator_name":"core/Op","start_pos":[1,1]}]},{"worker_outcome":"normal","test_outcome":"killed"}]`,
      )
      .join('\n')

  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), 'sackville-cr-proj-'))
    mkdirSync(join(proj, 'pkg'), { recursive: true })
    writeFileSync(join(proj, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(join(proj, 'pkg', 'strutil.py'), 'def shout(s):\n    return s.upper()\n')
    writeFileSync(
      join(proj, 'cosmic-ray.toml'),
      '[cosmic-ray]\nmodule-path = "pkg"\ntimeout = 30.0\nexcluded-modules = []\ntest-command = "python -m pytest -x"\n\n[cosmic-ray.distributor]\nname = "local"\n',
    )
  })
  afterEach(() => rmSync(proj, { recursive: true, force: true }))

  const pcfg = () => cfg({ projectRoot: proj, allowedRoots: [proj] })

  it('synthesizes a scoped config (module-path = selected files) and reports what was mutated', async () => {
    let scopedToml = ''
    const argvs: string[][] = []
    const runner: MutationRunner = async (argv) => {
      argvs.push(argv)
      if (argv[0] === 'init') scopedToml = readFileSync(join(proj, argv[1] ?? ''), 'utf8')
      return { exitCode: 0, stdout: argv[0] === 'dump' ? dumpFor(['pkg/calc.py']) : '', stderr: '' }
    }
    const result = await runCosmicRay(
      pcfg(),
      { mutateFiles: ['pkg/calc.py'] },
      { runner, sessionDir: dir },
    )
    expect(result.ran).toBe(true)
    expect(scopedToml).toContain('module-path = [ "pkg/calc.py" ]')
    // init/exec carry the synthesized scoped config, not the base.
    expect(argvs[0]?.[1]).toBe('.sackville-cosmic.toml')
    expect(result.scopedFiles).toEqual(['pkg/calc.py'])
    expect(result.requestedFiles).toEqual(['pkg/calc.py'])
    // the temp scoped config is cleaned up afterwards
    expect(existsSync(join(proj, '.sackville-cosmic.toml'))).toBe(false)
  })

  it('a fully out-of-tree scope is a pre-spawn noop (ran:false, scopeEmpty), never spawns', async () => {
    const { runner, argvs } = byVerb({ init: {}, exec: {}, dump: { stdout: dumpFor(['x']) } })
    const result = await runCosmicRay(
      pcfg(),
      { mutateFiles: ['other/x.py'] },
      { runner, sessionDir: dir },
    )
    expect(result.ran).toBe(false)
    expect(result.scopeEmpty).toBe(true)
    expect(result.unmatched).toEqual(['other/x.py'])
    expect(argvs).toEqual([]) // never spawned
  })

  it('PARTIAL under-scope (a selected file the tool never mutated) ⇒ inconclusive (the reconcile guard)', async () => {
    // selected calc + strutil, but the dump only carries calc — strutil was silently never mutated.
    const { runner } = byVerb({ init: {}, exec: {}, dump: { stdout: dumpFor(['pkg/calc.py']) } })
    await expect(
      runCosmicRay(
        pcfg(),
        { mutateFiles: ['pkg/calc.py', 'pkg/strutil.py'] },
        { runner, sessionDir: dir },
      ),
    ).rejects.toThrow(/under-scoped|never mutated|inconclusive/i)
  })

  it('reports a partially out-of-tree change: scopes the in-tree file, flags the rest as unmatched', async () => {
    const { runner } = byVerb({ init: {}, exec: {}, dump: { stdout: dumpFor(['pkg/calc.py']) } })
    const result = await runCosmicRay(
      pcfg(),
      { mutateFiles: ['pkg/calc.py', 'gone/y.py'] },
      { runner, sessionDir: dir },
    )
    expect(result.ran).toBe(true)
    expect(result.scopedFiles).toEqual(['pkg/calc.py'])
    expect(result.unmatched).toEqual(['gone/y.py'])
  })
})

describe('runnerEnv — prepends the project-local node_modules/.bin to PATH', () => {
  it('puts <cwd>/node_modules/.bin first so a project-local stryker/mutmut/cosmic-ray is found', () => {
    const env = runnerEnv('/abs/repo', { PATH: '/usr/bin' })
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(env.PATH).toBe(`${join('/abs/repo', 'node_modules', '.bin')}${sep}/usr/bin`)
  })

  it('works when PATH is unset and never mutates the input env', () => {
    const input = { FOO: 'bar' } as NodeJS.ProcessEnv
    const env = runnerEnv('/abs/repo', input)
    expect(env.PATH).toBe(join('/abs/repo', 'node_modules', '.bin'))
    expect(env.FOO).toBe('bar')
    expect(input.PATH).toBeUndefined()
  })
})
