import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MutationRunner } from '@sackville-mcp/mutate'
import { describe, expect, it, vi } from 'vitest'
import { run } from './index.js'
import { runVerify } from './verify.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

const dir = mkdtempSync(join(tmpdir(), 'sackville-verify-cli-'))
function fixture(name: string, value: unknown): string {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify(value))
  return p
}

describe('cli verify (ADR 0013 slice 10)', () => {
  it('exits 2 (inconclusive) when no pillars are supplied — absence is never a pass', async () => {
    const c = capture()
    expect(await run(['verify'], c.io)).toBe(2)
    expect(c.out()).toContain('INCONCLUSIVE')
  })

  it('exits 1 on a contract error (accepts a CaptureContractVerdict with .results)', async () => {
    const contract = fixture('contract.json', {
      results: [
        { valid: false, findings: [{ kind: 'response-schema', message: 'x', severity: 'error' }] },
      ],
    })
    const c = capture()
    expect(await run(['verify', '--contract', contract], c.io)).toBe(1)
    expect(c.out()).toContain('FAIL')
    expect(c.out()).toContain('contract: fail')
  })

  it('a deps moderate vuln warns by default but fails with --fail-at-or-above', async () => {
    const deps = fixture('deps.json', [
      { worstSeverity: 'moderate', deprecated: { isDeprecated: false } },
    ])
    const warn = capture()
    expect(await run(['verify', '--deps', deps, '--osv-snapshot-loaded'], warn.io)).toBe(1) // warn ⇒ non-zero
    expect(warn.out()).toContain('WARN')

    const fail = capture()
    expect(
      await run(
        ['verify', '--deps', deps, '--osv-snapshot-loaded', '--fail-at-or-above', 'moderate'],
        fail.io,
      ),
    ).toBe(1)
    expect(fail.out()).toContain('FAIL')
  })

  it('rejects an invalid --fail-at-or-above', async () => {
    const c = capture()
    expect(await run(['verify', '--fail-at-or-above', 'spicy'], c.io)).toBe(2)
    expect(c.err()).toContain('fail-at-or-above')
  })
})

const uncovered = {
  files: [],
  uncovered: [{ path: 'a.ts', line: 10 }],
  summary: { covered: 0, uncovered: 1, nonExecutable: 0, total: 1, filesWithoutCoverage: 0 },
}
const survivingMutation = {
  metrics: { mutationScore: 80, valid: 5 },
  files: [],
  survivors: [{ file: 'a.ts', mutatorName: 'X', status: 'Survived' as const, line: 1 }],
}

describe('cli verify run (run-driving, ADR 0013 Addendum slice 6)', () => {
  it('needs a <project-root>', async () => {
    const c = capture()
    expect(await runVerify(['run'], c.io)).toBe(2)
    expect(c.err()).toContain('needs a <project-root>')
  })

  it('needs ≥1 pillar', async () => {
    const c = capture()
    expect(await runVerify(['run', '/repo'], c.io)).toBe(2)
    expect(c.err()).toContain('needs ≥1 pillar')
  })

  it('without --allow-run, a requested pillar is skipped:gate-not-set ⇒ inconclusive (exit 2)', async () => {
    // No deps override → the REAL runScoped gate denies (allowRun false) BEFORE any
    // spawn, throwing its branded CoverageGateError ⇒ skipReason:gate-not-set.
    const c = capture()
    expect(await runVerify(['run', '/repo', '--coverage'], c.io)).toBe(2)
    expect(c.out()).toContain('INCONCLUSIVE')
    expect(c.out()).toContain('coverage: no-signal (skipped: gate-not-set)')
  })

  it('drives the selected pillars and folds them (injected thunks, no spawn)', async () => {
    const c = capture()
    const code = await runVerify(['run', '/repo', '--coverage', '--mutate', '--allow-run'], c.io, {
      coverage: async () => uncovered as never,
      mutate: async () => survivingMutation as never,
    })
    expect(code).toBe(1) // coverage uncovered line ⇒ fail
    expect(c.out()).toContain('verdict: FAIL')
    expect(c.out()).toContain('coverage: fail')
    expect(c.out()).toContain('mutate: warn')
  })

  it('rejects an invalid --fail-at-or-above', async () => {
    const c = capture()
    expect(
      await runVerify(['run', '/repo', '--coverage', '--fail-at-or-above', 'spicy'], c.io),
    ).toBe(2)
    expect(c.err()).toContain('fail-at-or-above')
  })

  it('rejects an unknown --mutate-tool (Fork D)', async () => {
    const c = capture()
    expect(
      await runVerify(['run', '/repo', '--mutate', '--mutate-tool', 'wat', '--allow-run'], c.io),
    ).toBe(2)
    expect(c.err()).toContain('mutate-tool')
  })

  it('--mutate-tool cosmic-ray routes to the cosmic-ray runner (init→exec→dump), diff-scoped', async () => {
    // A real temp project (cosmic-ray reads its base config + the selected file); the runner is
    // injected so nothing spawns. The dump is keyed by the relative selected path so reconcile passes.
    const proj = mkdtempSync(join(tmpdir(), 'sackville-verify-cr-'))
    mkdirSync(join(proj, 'pkg'), { recursive: true })
    writeFileSync(join(proj, 'pkg', 'calc.py'), 'def add(a, b):\n    return a + b\n')
    writeFileSync(
      join(proj, 'cosmic-ray.toml'),
      '[cosmic-ray]\nmodule-path = "pkg"\ntimeout = 30.0\nexcluded-modules = []\ntest-command = "x"\n\n[cosmic-ray.distributor]\nname = "local"\n',
    )
    const verbs: string[] = []
    const mutateRunner: MutationRunner = async (argv) => {
      verbs.push(argv[0] ?? '')
      const dump =
        '[{"mutations":[{"module_path":"pkg/calc.py","operator_name":"core/Op","start_pos":[1,1]}]},{"worker_outcome":"normal","test_outcome":"killed"}]'
      return { exitCode: 0, stdout: argv[0] === 'dump' ? dump : '', stderr: '' }
    }
    const c = capture()
    await runVerify(
      [
        'run',
        proj,
        '--mutate',
        '--mutate-tool',
        'cosmic-ray',
        '--changed-file',
        'pkg/calc.py',
        '--allow-run',
      ],
      c.io,
      { mutateRunner },
    )
    expect(verbs).toEqual(['init', 'exec', 'dump']) // cosmic-ray was selected, not stryker/mutmut
    expect(c.out()).toContain('mutate: pass') // the scoped cosmic-ray run (mutant killed) drove a pass
    // (overall is inconclusive — the OTHER pillars weren't run — which is the absence-never-a-pass default)
  })

  it('drives a --flow contract capture via an injected runner — no browser spawn', async () => {
    // The human is the operator; --flow drives a live capture gated by browser egress flags,
    // not --allow-run. The injected contract runner keeps the suite offline.
    const c = capture()
    const contract = vi.fn(async (req: { flow: string }) => {
      expect(req.flow).toBe('login')
      return [
        {
          valid: false,
          findings: [{ kind: 'response-schema', message: 'drift', severity: 'error' }],
        } as never,
      ]
    })
    const code = await runVerify(['run', '/repo', '--flow', 'login'], c.io, { contract })
    expect(contract).toHaveBeenCalledOnce()
    expect(code).toBe(1) // a contract error fails the verdict
    expect(c.out()).toContain('contract: fail')
  })

  it('--flow without an injected runner needs --flows-dir', async () => {
    const c = capture()
    expect(await runVerify(['run', '/repo', '--flow', 'login'], c.io)).toBe(2)
    expect(c.err()).toContain('--flows-dir')
  })

  it('drives a --request api capture via an injected runner — no fetch (5f)', async () => {
    // The human is the operator; --request drives the api runner gated by --allow-unsafe/
    // --allow-host, not --allow-run. The injected runner keeps the suite offline AND
    // returns the FULL verdict facts so clean===false folds to inconclusive (5f).
    const c = capture()
    const contractApi = vi.fn(
      async (req: { request: string; collectionDir?: string; vars?: unknown }) => {
        expect(req.request).toBe('get-widgets')
        expect(req.vars).toEqual({ baseUrl: 'http://127.0.0.1:9' })
        return {
          results: [{ valid: true, findings: [] }],
          clean: false,
          noSignal: 1,
          unresolvedBodies: 0,
          entriesValidated: 1,
        }
      },
    )
    const code = await runVerify(
      ['run', '/repo', '--request', 'get-widgets', '--var', 'baseUrl=http://127.0.0.1:9'],
      c.io,
      { contractApi },
    )
    expect(contractApi).toHaveBeenCalledOnce()
    expect(code).toBe(2) // clean===false ⇒ contract no-signal ⇒ inconclusive
    expect(c.out()).toContain('contract: no-signal')
  })

  it('--request without an injected runner needs --collection-dir', async () => {
    const c = capture()
    expect(await runVerify(['run', '/repo', '--request', 'get-widgets'], c.io)).toBe(2)
    expect(c.err()).toContain('--collection-dir')
  })

  it('--request and --flow are mutually exclusive', async () => {
    const c = capture()
    expect(await runVerify(['run', '/repo', '--request', 'r', '--flow', 'f'], c.io)).toBe(2)
    expect(c.err()).toMatch(/mutually exclusive|either/i)
  })

  it('drives the deps pillar via an injected runner — no --allow-run, no network', async () => {
    // deps' gate is NETWORK, not spawn — the human typing --deps is the operator intent;
    // it needs no --allow-run. The injected runner keeps the suite offline.
    const c = capture()
    const code = await runVerify(['run', '/repo', '--deps', '--fail-at-or-above', 'high'], c.io, {
      deps: async () => ({
        audits: [{ worstSeverity: 'high', deprecated: { isDeprecated: false } } as never],
        osvSnapshotLoaded: true,
      }),
    })
    expect(code).toBe(1) // the high-severity deps warn ≥ the declared cut ⇒ overall FAIL
    expect(c.out()).toContain('verdict: FAIL')
    expect(c.out()).toContain('deps: warn [high]') // the pillar ran and folded
  })
})
