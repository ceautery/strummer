import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MutationRunner } from '@sackville-mcp/mutate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run } from './index.js'
import { runMutate } from './mutate.js'

const here = dirname(fileURLToPath(import.meta.url))
// The pillar's own committed golden report (detected 2 / valid 5 → 40%; 3 survivors).
const STRYKER_FIXTURE = resolve(here, '../../mutate/test/fixtures/mutation-report.json')

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sackville-cli-mutate-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('sackville mutate CLI', () => {
  it('summarize prints the mutation score and survivors from a Stryker report', async () => {
    const c = capture()
    const code = await run(['mutate', 'summarize', STRYKER_FIXTURE], c.io)
    expect(code).toBe(0)
    expect(c.out()).toMatch(/40\.0%/)
    expect(c.out()).toMatch(/survivors \(3\)/)
  })

  it('summarize --json emits the structured summary', async () => {
    const c = capture()
    const code = await run(['mutate', 'summarize', STRYKER_FIXTURE, '--json'], c.io)
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.metrics.mutationScore).toBeCloseTo(40, 6)
    expect(parsed.survivors).toHaveLength(3)
  })

  it('summarize --format mutmut parses a mutmut results file', async () => {
    const f = join(dir, 'results.txt')
    writeFileSync(f, ['calc.x_add__mutmut_1: killed', 'calc.x_sub__mutmut_1: survived'].join('\n'))
    const c = capture()
    const code = await run(['mutate', 'summarize', f, '--format', 'mutmut', '--json'], c.io)
    expect(code).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.metrics.detected).toBe(1)
    expect(parsed.survivors).toHaveLength(1)
  })

  it('summarize without a report path errors', async () => {
    const c = capture()
    expect(await run(['mutate', 'summarize'], c.io)).toBe(1)
    expect(c.err()).toMatch(/report/i)
  })

  it('run is refused without --allow-run (deny-by-default, no spawn)', async () => {
    let spawned = false
    const runner: MutationRunner = async () => {
      spawned = true
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runMutate(['run', dir], c.io, { runner })
    expect(code).toBe(1)
    expect(spawned).toBe(false)
    expect(c.err()).toMatch(/allow-run|not enabled/i)
  })

  it('run executes the injected runner and reports metrics with --allow-run', async () => {
    const reportPath = join(dir, 'mutation.json')
    // The diff scope is existence-checked, so the requested file must exist on disk.
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/math.ts'), 'export const add = (a, b) => a + b\n')
    const runner: MutationRunner = async (argv) => {
      // Stryker would emit the JSON report; the fake stages the golden in its place.
      expect(argv).toContain('run')
      copyFileSync(STRYKER_FIXTURE, reportPath)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runMutate(
      ['run', dir, '--allow-run', '--report-path', reportPath, '--file', 'src/math.ts'],
      c.io,
      { runner },
    )
    expect(code).toBe(0)
    expect(c.out()).toMatch(/40\.0%/)
    expect(c.out()).toMatch(/src\/math\.ts/)
  })

  it('run propagates a non-zero Stryker exit (below threshold) as exit 1', async () => {
    const reportPath = join(dir, 'mutation.json')
    const runner: MutationRunner = async () => {
      copyFileSync(STRYKER_FIXTURE, reportPath)
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    const c = capture()
    const code = await runMutate(['run', dir, '--allow-run', '--report-path', reportPath], c.io, {
      runner,
    })
    expect(code).toBe(1)
  })

  it('run --tool cosmic-ray drives init→exec→dump and summarizes the dump stdout', async () => {
    const dump = [
      '[{"mutations":[{"module_path":"calc.py","operator_name":"core/Op1","start_pos":[2,13]}]},{"worker_outcome":"normal","test_outcome":"killed"}]',
      '[{"mutations":[{"module_path":"calc.py","operator_name":"core/Op2","start_pos":[10,13]}]},{"worker_outcome":"normal","test_outcome":"survived"}]',
    ].join('\n')
    const runner: MutationRunner = async (argv) =>
      argv[0] === 'dump'
        ? { exitCode: 0, stdout: dump, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }
    const c = capture()
    const code = await runMutate(['run', dir, '--allow-run', '--tool', 'cosmic-ray'], c.io, {
      runner,
    })
    expect(code).toBe(0)
    expect(c.out()).toMatch(/cosmic-ray/)
  })

  it('run --tool cosmic-ray --diff line-scopes a --file-scoped summary to the changed lines', async () => {
    mkdirSync(join(dir, 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(
      join(dir, 'cosmic-ray.toml'),
      '[cosmic-ray]\nmodule-path = "pkg"\ntimeout = 30.0\nexcluded-modules = []\ntest-command = "x"\n\n[cosmic-ray.distributor]\nname = "local"\n',
    )
    const diffPath = join(dir, 'change.diff')
    writeFileSync(
      diffPath,
      '--- a/pkg/calc.py\n+++ b/pkg/calc.py\n@@ -2 +2 @@\n-    return a + b\n+    return a - b\n',
    )
    // A survivor on line 1 (out-of-diff) + a killed mutant on line 2 (the changed line).
    const dump = [
      '[{"mutations":[{"module_path":"pkg/calc.py","operator_name":"core/Op","start_pos":[1,5],"end_pos":[1,6]}]},{"worker_outcome":"normal","test_outcome":"survived"}]',
      '[{"mutations":[{"module_path":"pkg/calc.py","operator_name":"core/Op","start_pos":[2,5],"end_pos":[2,6]}]},{"worker_outcome":"normal","test_outcome":"killed"}]',
    ].join('\n')
    const runner: MutationRunner = async (argv) =>
      argv[0] === 'dump'
        ? { exitCode: 0, stdout: dump, stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' }

    // Without --diff: the whole-file summary is 50% (1 killed, 1 survivor).
    const plain = capture()
    await runMutate(
      ['run', dir, '--allow-run', '--tool', 'cosmic-ray', '--file', 'pkg/calc.py'],
      plain.io,
      { runner },
    )
    expect(plain.out()).toMatch(/50\.0%/)
    expect(plain.out()).toMatch(/survivors \(1\)/)

    // With --diff (line 2 only): the line-1 survivor is excluded ⇒ 100%, no survivors.
    const scoped = capture()
    await runMutate(
      [
        'run',
        dir,
        '--allow-run',
        '--tool',
        'cosmic-ray',
        '--file',
        'pkg/calc.py',
        '--diff',
        diffPath,
      ],
      scoped.io,
      { runner },
    )
    expect(scoped.out()).toMatch(/100\.0%/)
    expect(scoped.out()).not.toMatch(/survivors \(1\)/)
  })

  it('run rejects an unknown --tool', async () => {
    const c = capture()
    expect(await runMutate(['run', dir, '--tool', 'pitest'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown tool/i)
  })

  it('unknown subcommand exits 1', async () => {
    const c = capture()
    expect(await runMutate(['frobnicate'], c.io)).toBe(1)
    expect(c.err()).toMatch(/unknown mutate subcommand/)
  })
})
