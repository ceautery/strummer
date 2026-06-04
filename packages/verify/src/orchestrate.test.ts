import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DependencyAudit } from '@strummer/deps'
import { describe, expect, it, vi } from 'vitest'
import { gateDenied, isGateDenial } from './gate.js'
import { orchestrate } from './orchestrate.js'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

// Native-shaped fixtures (the real result types the from* adapters consume).
const uncoveredReport = {
  files: [],
  uncovered: [{ path: 'a.ts', line: 10 }],
  summary: { covered: 0, uncovered: 1, nonExecutable: 0, total: 1, filesWithoutCoverage: 0 },
}
const cleanAudit = { worstSeverity: 'none', deprecated: { isDeprecated: false } } as DependencyAudit

describe('orchestrate — drives requested pillars + folds via the from* adapters (slice 2)', () => {
  it('runs every requested pillar concurrently and maps each via its adapter', async () => {
    const coverageRun = vi.fn().mockResolvedValue(uncoveredReport)
    const depsRun = vi.fn().mockResolvedValue({ audits: [cleanAudit], osvSnapshotLoaded: true })

    const { verdict } = await orchestrate({
      coverage: { run: coverageRun },
      deps: { run: depsRun },
    })

    // both thunks were invoked (concurrent allSettled fan-out)
    expect(coverageRun).toHaveBeenCalledOnce()
    expect(depsRun).toHaveBeenCalledOnce()

    // each native result was mapped through the existing from* adapter
    const coverage = verdict.pillars.find((p) => p.pillar === 'coverage')
    const deps = verdict.pillars.find((p) => p.pillar === 'deps')
    expect(coverage).toMatchObject({ status: 'fail', severity: 'moderate' })
    expect(deps).toMatchObject({ status: 'pass' })

    // omitted pillars are missing ⇒ overall inconclusive isn't reached because a
    // real coverage fail dominates; but the un-requested pillars are still missing.
    expect(verdict.missing.sort()).toEqual(['contract', 'flake', 'mutate'])
    expect(verdict.status).toBe('fail')
    expect(verdict.worstPillar).toBe('coverage')
  })

  it('threads the contract source provenance through fromContractResults', async () => {
    const { verdict } = await orchestrate({
      contract: { run: async () => [], source: 'capture-from-HAR' },
    })
    const contract = verdict.pillars.find((p) => p.pillar === 'contract')
    expect(contract).toMatchObject({ status: 'no-signal', source: 'capture-from-HAR' })
  })

  it('folds the FULL capture verdict: a valid entry alongside a no-signal entry is inconclusive, never pass (5f)', async () => {
    // A produce/consume thunk returns the full CaptureContractVerdict facts; clean===false
    // (a no-signal GraphQL-no-SDL entry) must NOT ride the valid REST entry to a pass.
    const { verdict } = await orchestrate({
      contract: {
        run: async () => ({
          results: [{ valid: true, findings: [] }],
          clean: false,
          noSignal: 1,
          unresolvedBodies: 0,
          entriesValidated: 1,
        }),
        source: 'capture-from-HAR',
      },
    })
    const contract = verdict.pillars.find((p) => p.pillar === 'contract')
    expect(contract?.status).toBe('no-signal')
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.ok).toBe(false)
  })

  it('mints the verdict id via the injected idFactory (deterministic in tests)', async () => {
    const { id } = await orchestrate(
      { deps: { run: async () => ({ audits: [cleanAudit], osvSnapshotLoaded: true }) } },
      { idFactory: () => 'fixed-verdict-id' },
    )
    expect(id).toBe('fixed-verdict-id')
  })

  it('threads policy.failAtOrAbove straight through to the fold', async () => {
    const highVuln = {
      worstSeverity: 'high',
      deprecated: { isDeprecated: false },
    } as DependencyAudit
    const { verdict } = await orchestrate(
      { deps: { run: async () => ({ audits: [highVuln], osvSnapshotLoaded: true }) } },
      { policy: { failAtOrAbove: 'high' } },
    )
    expect(verdict.pillars.find((p) => p.pillar === 'deps')?.status).toBe('warn')
    expect(verdict.status).toBe('fail') // the policy cut escalated the high-severity warn
  })

  it('a pillar that throws becomes an errored, REDACTED no-signal contributor — never sinks the run', async () => {
    const redact = (s: string) =>
      s.replace('/tmp/strummer-cov-x9/coverage-final.json', '‹redacted›')
    const { verdict } = await orchestrate(
      {
        coverage: {
          run: async () => {
            throw new Error(
              'scoped run did not produce a coverage report at /tmp/strummer-cov-x9/coverage-final.json',
            )
          },
        },
        deps: { run: async () => ({ audits: [cleanAudit], osvSnapshotLoaded: true }) },
      },
      { redact },
    )
    const coverage = verdict.pillars.find((p) => p.pillar === 'coverage')
    expect(coverage?.status).toBe('no-signal')
    expect(coverage?.errorReason).toBe('scoped run did not produce a coverage report at ‹redacted›')
    // the leaked temp path must appear NOWHERE in the verdict (inline)
    expect(JSON.stringify(verdict)).not.toContain('/tmp/strummer-cov-x9')
    // the sibling deps pillar still ran and folded; absence ⇒ inconclusive, never pass
    expect(verdict.pillars.find((p) => p.pillar === 'deps')?.status).toBe('pass')
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.ok).toBe(false)
  })
})

describe('orchestrate — gate composition: compose, never widen (slice 3)', () => {
  it("a pillar whose OWN gate denies ⇒ skipReason 'gate-not-set' (not run, surfaced), siblings still fold", async () => {
    // The thunk throws the pillar's real (branded) gate-denial — as a gated runner's
    // assertAllowed would. orchestrate must NOT treat it as an errored crash.
    const { verdict } = await orchestrate({
      coverage: {
        run: async () => {
          throw gateDenied('scoped test execution is not enabled (the operator must set allowRun)')
        },
      },
      deps: { run: async () => ({ audits: [cleanAudit], osvSnapshotLoaded: true }) },
    })
    const coverage = verdict.pillars.find((p) => p.pillar === 'coverage')
    expect(coverage).toMatchObject({ status: 'no-signal', skipReason: 'gate-not-set' })
    expect(coverage?.errorReason).toBeUndefined()
    // the sibling still ran; absence ⇒ inconclusive, never pass
    expect(verdict.pillars.find((p) => p.pillar === 'deps')?.status).toBe('pass')
    expect(verdict.status).toBe('inconclusive')
    expect(verdict.ok).toBe(false)
  })

  it("deps-network-off / flake-no-DB style denials also map to 'gate-not-set', not errored", async () => {
    const { verdict } = await orchestrate({
      deps: {
        run: async () => {
          throw gateDenied(
            'package-metadata fetch is not enabled (the operator must enable network)',
          )
        },
      },
      flake: {
        run: async () => {
          throw gateDenied('flake history DB is not configured')
        },
      },
    })
    for (const pillar of ['deps', 'flake'] as const) {
      const p = verdict.pillars.find((x) => x.pillar === pillar)
      expect(p).toMatchObject({ status: 'no-signal', skipReason: 'gate-not-set' })
    }
  })

  it('a gate-denial headline carries no secret/path — it is NOT the raw error message', async () => {
    const { verdict } = await orchestrate({
      mutate: {
        run: async () => {
          throw gateDenied('mutation runs are not enabled at /tmp/secret')
        },
      },
    })
    const mutate = verdict.pillars.find((p) => p.pillar === 'mutate')
    expect(mutate?.skipReason).toBe('gate-not-set')
    expect(JSON.stringify(mutate)).not.toContain('/tmp/secret')
  })

  it('a genuine (non-gate) rejection stays errored, distinct from a gate denial', async () => {
    const { verdict } = await orchestrate({
      coverage: {
        run: async () => {
          throw new Error('the runner segfaulted')
        },
      },
    })
    const coverage = verdict.pillars.find((p) => p.pillar === 'coverage')
    expect(coverage?.skipReason).toBeUndefined()
    expect(coverage?.errorReason).toBe('the runner segfaulted')
  })

  it('orchestrate invokes each pillar run thunk with ZERO arguments — it cannot inject/widen a gate', async () => {
    // The gate lives entirely inside the operator-wired thunk; orchestrate has no
    // allowRun/allowedRoots knob to pass (compile-time), and passes nothing at runtime.
    const run = vi.fn().mockResolvedValue({ audits: [cleanAudit], osvSnapshotLoaded: true })
    await orchestrate({ deps: { run } })
    expect(run).toHaveBeenCalledWith()
    expect(run.mock.calls[0]).toHaveLength(0)
  })

  it('isGateDenial recognizes a branded error and rejects a plain one', () => {
    expect(isGateDenial(gateDenied('x'))).toBe(true)
    expect(isGateDenial(new Error('x'))).toBe(false)
    expect(isGateDenial('x')).toBe(false)
    expect(isGateDenial(null)).toBe(false)
  })
})

describe('orchestrate — imports zero spawn-capable engine code (slice 2)', () => {
  it('every @strummer engine import is type-only; no runner/store/native module is reachable', () => {
    const ENGINES = [
      '@strummer/api',
      '@strummer/coverage',
      '@strummer/deps',
      '@strummer/flake',
      '@strummer/mutate',
      '@strummer/browser',
    ]
    for (const file of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8')
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*import\s+(.*?)\s+from\s+['"]([^'"]+)['"]/)
        if (!m) continue
        const clause = m[1] ?? ''
        const spec = m[2] ?? ''
        if (ENGINES.includes(spec)) {
          // engine packages may be referenced for TYPES only — never a runtime import
          expect(clause.startsWith('type ')).toBe(true)
        }
      }
      expect(text).not.toMatch(/\bdefaultVitestRunner\b/)
      expect(text).not.toMatch(/\bdefaultStrykerRunner\b/)
      expect(text).not.toMatch(/\bHistoryStore\b/)
      expect(text).not.toMatch(/better-sqlite3|playwright-core/)
    }
  })
})
