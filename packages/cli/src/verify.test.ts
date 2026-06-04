import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
