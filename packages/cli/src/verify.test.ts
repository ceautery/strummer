import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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

const dir = mkdtempSync(join(tmpdir(), 'strummer-verify-cli-'))
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
})
