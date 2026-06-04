import type { ContractResult } from '@strummer/api'
import type { DiffCoverageReport } from '@strummer/coverage'
import type { DependencyAudit } from '@strummer/deps'
import type { FlakeVerdict } from '@strummer/flake'
import type { MutationSummary } from '@strummer/mutate'
import { describe, expect, it } from 'vitest'
import {
  fromContractResults,
  fromDependencyAudits,
  fromDiffCoverage,
  fromFlakeVerdicts,
  fromMutationSummary,
} from './adapters.js'
import { composeVerdict } from './compose.js'
import { maxSeverity, SEVERITY_RANK } from './severity.js'

describe('severity core (slice 7)', () => {
  it('ranks the scale and takes the max', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high)
    expect(maxSeverity('low', 'critical', 'moderate')).toBe('critical')
    expect(maxSeverity()).toBe('none')
  })
})

describe('composeVerdict — empty fold is inconclusive, never pass (slice 7)', () => {
  it('an empty fold is inconclusive with all pillars missing', () => {
    const v = composeVerdict({})
    expect(v.ok).toBe(false)
    expect(v.status).toBe('inconclusive')
    expect(v.missing.sort()).toEqual(['contract', 'coverage', 'deps', 'flake', 'mutate'])
    expect(v.worstSeverity).toBe('none')
    expect(v.worstPillar).toBeUndefined()
  })

  it('a present pass + a missing pillar is still inconclusive (absence is never a pass)', () => {
    const v = composeVerdict({
      coverage: { pillar: 'coverage', status: 'pass', severity: 'none', headline: 'ok' },
    })
    expect(v.status).toBe('inconclusive')
    expect(v.ok).toBe(false)
  })
})

const contractError: ContractResult = {
  valid: false,
  findings: [{ kind: 'response-schema', message: 'must be integer', severity: 'error' }],
}

describe('fromContractResults + fromDiffCoverage + fromDependencyAudits (slice 8)', () => {
  it('an error finding ⇒ contract fail with capture provenance', () => {
    const p = fromContractResults([contractError], 'capture-from-HAR')
    expect(p).toMatchObject({ pillar: 'contract', status: 'fail', source: 'capture-from-HAR' })
    expect(p.severity).toBe('high')
  })

  it('zero contract entries ⇒ no-signal, never pass', () => {
    expect(fromContractResults([]).status).toBe('no-signal')
  })

  it('an uncovered new line ⇒ coverage fail', () => {
    const report: DiffCoverageReport = {
      files: [],
      uncovered: [{ path: 'a.ts', line: 10 }],
      summary: { covered: 0, uncovered: 1, nonExecutable: 0, total: 1, filesWithoutCoverage: 0 },
    }
    expect(fromDiffCoverage(report)).toMatchObject({ status: 'fail', severity: 'moderate' })
  })

  it("deps 'unknown' maps to no-signal, never low/none", () => {
    const audit = {
      worstSeverity: 'unknown',
      deprecated: { isDeprecated: false },
    } as DependencyAudit
    const p = fromDependencyAudits([audit], { osvSnapshotLoaded: true })
    expect(p.status).toBe('no-signal')
    expect(p.severity).toBe('none')
  })

  it('deps with no OSV snapshot loaded forces no-signal (→ inconclusive overall)', () => {
    const audit = { worstSeverity: 'none', deprecated: { isDeprecated: false } } as DependencyAudit
    const p = fromDependencyAudits([audit], { osvSnapshotLoaded: false })
    expect(p.status).toBe('no-signal')
  })

  it('a real deps vulnerability maps onto the scale as a warn (policy escalates)', () => {
    const audit = { worstSeverity: 'high', deprecated: { isDeprecated: false } } as DependencyAudit
    const p = fromDependencyAudits([audit], { osvSnapshotLoaded: true })
    expect(p).toMatchObject({ status: 'warn', severity: 'high' })
  })
})

describe('fromFlakeVerdicts + fromMutationSummary no-signal correctness (slice 9)', () => {
  const flake = (state: FlakeVerdict['state'], flakeScore = 0): FlakeVerdict =>
    ({
      id: 't',
      state,
      runs: 10,
      passes: 5,
      failures: 5,
      failureRate: 0.5,
      flakeScore,
    }) as FlakeVerdict

  it('a flaky test ⇒ warn scaled by flakeScore', () => {
    expect(fromFlakeVerdicts([flake('flaky', 0.6)])).toMatchObject({
      status: 'warn',
      severity: 'high',
    })
    expect(fromFlakeVerdicts([flake('flaky', 0.05)]).severity).toBe('low')
  })

  it('a broken test ⇒ fail; insufficient-data ⇒ no-signal', () => {
    expect(fromFlakeVerdicts([flake('broken')]).status).toBe('fail')
    expect(fromFlakeVerdicts([flake('insufficient-data')]).status).toBe('no-signal')
    expect(fromFlakeVerdicts([flake('reliable')]).status).toBe('pass')
  })

  const mutation = (mutationScore: number | null, survivors: number): MutationSummary =>
    ({
      metrics: { mutationScore, valid: survivors > 0 ? 5 : 0 },
      files: [],
      survivors: Array.from({ length: survivors }, (_v, i) => ({
        file: 'a.ts',
        mutatorName: 'X',
        status: 'Survived' as const,
        line: i + 1,
      })),
    }) as unknown as MutationSummary

  it('mutationScore null AND no survivors ⇒ no-signal', () => {
    expect(fromMutationSummary(mutation(null, 0)).status).toBe('no-signal')
  })

  it('survivors drive a warn even if a score exists (not laundered to no-signal)', () => {
    expect(fromMutationSummary(mutation(80, 3))).toMatchObject({
      status: 'warn',
      severity: 'moderate',
    })
  })

  it('valid mutants, no survivors ⇒ pass', () => {
    expect(fromMutationSummary(mutation(100, 0)).status).toBe('pass')
  })
})

describe('composeVerdict — real fold + policy escalation', () => {
  it('a contract fail makes the whole verdict fail regardless of policy', () => {
    const v = composeVerdict({ contract: fromContractResults([contractError]) })
    expect(v.status).toBe('fail')
    expect(v.worstPillar).toBe('contract')
  })

  it('a deps warn stays warn without a policy, but fails when policy.failAtOrAbove is met', () => {
    const audit = { worstSeverity: 'high', deprecated: { isDeprecated: false } } as DependencyAudit
    const deps = fromDependencyAudits([audit], { osvSnapshotLoaded: true })
    expect(composeVerdict({ deps }).status).toBe('warn')
    expect(composeVerdict({ deps }, { failAtOrAbove: 'high' }).status).toBe('fail')
    expect(composeVerdict({ deps }, { failAtOrAbove: 'critical' }).status).toBe('warn')
  })

  it('all pillars pass ⇒ overall pass (ok:true)', () => {
    const v = composeVerdict({
      contract: { pillar: 'contract', status: 'pass', severity: 'none', headline: 'ok' },
      coverage: { pillar: 'coverage', status: 'pass', severity: 'none', headline: 'ok' },
      deps: { pillar: 'deps', status: 'pass', severity: 'none', headline: 'ok' },
      flake: { pillar: 'flake', status: 'pass', severity: 'none', headline: 'ok' },
      mutate: { pillar: 'mutate', status: 'pass', severity: 'none', headline: 'ok' },
    })
    expect(v.ok).toBe(true)
    expect(v.status).toBe('pass')
  })
})
