import { describe, expect, it } from 'vitest'
import { auditDependency } from './audit.js'
import type { Packument } from './deprecation.js'
import type { OsvAdvisory } from './osv.js'

const packument: Packument = {
  name: 'oldpkg',
  'dist-tags': { latest: '2.1.0' },
  versions: {
    '1.0.0': { version: '1.0.0', deprecated: '1.x is end-of-life, upgrade to 2.x' },
    '1.2.0': { version: '1.2.0' },
    '2.0.0': { version: '2.0.0' },
    '2.1.0': { version: '2.1.0' },
    '3.0.0-beta.1': { version: '3.0.0-beta.1' },
  },
}

const advisories: OsvAdvisory[] = [
  {
    id: 'OSV-HIGH',
    modified: '2024-01-02T00:00:00Z',
    summary: 'auth bypass in oldpkg < 1.5.0',
    database_specific: { severity: 'HIGH' },
    affected: [
      {
        package: { ecosystem: 'npm', name: 'oldpkg' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.5.0' }] }],
      },
    ],
  },
]

describe('auditDependency — composite installed-version verdict', () => {
  it('rolls deprecation + vulnerabilities + freshness into one verdict', () => {
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.0.0',
      packument,
      advisories,
      snapshotDate: '2024-01-02T00:00:00Z',
    })

    expect(audit.deprecated).toEqual({
      isDeprecated: true,
      message: '1.x is end-of-life, upgrade to 2.x',
      scope: 'version',
    })
    expect(audit.vulnerabilities.map((v) => v.id)).toEqual(['OSV-HIGH'])
    expect(audit.worstSeverity).toBe('high')
    // latest = dist-tags latest; latestSameMajor ignores the 3.0.0 prerelease and the 2.x line.
    expect(audit.freshness).toEqual({
      installed: '1.0.0',
      latest: '2.1.0',
      latestSameMajor: '1.2.0',
      isOutdated: true,
      // 3 stable releases ahead (1.2.0/2.0.0/2.1.0; the 3.0.0 prerelease excluded);
      // 1 major behind the latest; 2 minors behind within the 1.x line; no patch ahead of 1.0.x.
      behindBy: { releases: 3, major: 1, minor: 2, patch: 0 },
    })
    expect(audit.recommendedTarget).toBe('1.2.0')
    // The advisory is fixed in 1.5.0, so every 1.x release stays vulnerable: the
    // minimum SAFE upgrade crosses a major to 2.0.0 — distinct from recommendedTarget.
    expect(audit.minimumSafeUpgrade).toBe('2.0.0')
    expect(audit.snapshotDate).toBe('2024-01-02T00:00:00Z')
    expect(audit.hasFindings).toBe(true)
  })

  it('reports a clean, current dependency with no findings and no recommendation', () => {
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '2.1.0',
      packument,
      advisories,
    })

    expect(audit.deprecated).toEqual({ isDeprecated: false })
    expect(audit.vulnerabilities).toEqual([])
    expect(audit.worstSeverity).toBe('none')
    expect(audit.freshness).toEqual({
      installed: '2.1.0',
      latest: '2.1.0',
      latestSameMajor: '2.1.0',
      isOutdated: false,
      behindBy: { releases: 0, major: 0, minor: 0, patch: 0 },
    })
    expect(audit.recommendedTarget).toBeUndefined()
    expect(audit.minimumSafeUpgrade).toBeUndefined() // nothing vulnerable ⇒ no security target
    expect(audit.hasFindings).toBe(false)
  })

  it('minimumSafeUpgrade picks a same-major patch when one clears the vuln', () => {
    const earlyFix: OsvAdvisory[] = [
      {
        id: 'OSV-EARLY',
        database_specific: { severity: 'HIGH' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.2.0' }] }],
          },
        ],
      },
    ]
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.0.0',
      packument,
      advisories: earlyFix,
    })
    // 1.2.0 is >= the 1.2.0 fix, so the closest clean release is the same-major patch.
    expect(audit.minimumSafeUpgrade).toBe('1.2.0')
  })

  it('minimumSafeUpgrade skips a release that fixes one advisory but is hit by another', () => {
    const overlapping: OsvAdvisory[] = [
      {
        id: 'OSV-A',
        database_specific: { severity: 'HIGH' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }],
          },
        ],
      },
      {
        id: 'OSV-B',
        database_specific: { severity: 'CRITICAL' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            // affects exactly 2.0.0 (introduced 2.0.0, fixed 2.1.0)
            ranges: [{ type: 'SEMVER', events: [{ introduced: '2.0.0' }, { fixed: '2.1.0' }] }],
          },
        ],
      },
    ]
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.0.0',
      packument,
      advisories: overlapping,
    })
    // installed 1.0.0 matches OSV-A. 1.2.0 still in OSV-A; 2.0.0 clears OSV-A but is hit
    // by OSV-B; 2.1.0 is clear of both ⇒ the minimum safe upgrade.
    expect(audit.vulnerabilities.map((v) => v.id)).toEqual(['OSV-A'])
    expect(audit.minimumSafeUpgrade).toBe('2.1.0')
  })

  it('minimumSafeUpgrade is undefined when no available release clears the vuln', () => {
    const unfixed: OsvAdvisory[] = [
      {
        id: 'OSV-UNFIXED',
        database_specific: { severity: 'HIGH' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            // open-ended: affects everything from 0 with no fix.
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }],
          },
        ],
      },
    ]
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.0.0',
      packument,
      advisories: unfixed,
    })
    expect(audit.vulnerabilities.map((v) => v.id)).toEqual(['OSV-UNFIXED'])
    expect(audit.minimumSafeUpgrade).toBeUndefined()
  })

  it('worstSeverity is the maximum across multiple matched vulnerabilities', () => {
    const multi: OsvAdvisory[] = [
      {
        id: 'OSV-MOD',
        database_specific: { severity: 'MODERATE' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '5.0.0' }] }],
          },
        ],
      },
      {
        id: 'OSV-CRIT',
        database_specific: { severity: 'CRITICAL' },
        affected: [
          {
            package: { ecosystem: 'npm', name: 'oldpkg' },
            ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '5.0.0' }] }],
          },
        ],
      },
    ]
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.0.0',
      packument,
      advisories: multi,
    })
    expect(audit.vulnerabilities).toHaveLength(2)
    expect(audit.worstSeverity).toBe('critical')
  })

  it('works with no advisories supplied (deprecation + freshness only)', () => {
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: '1.2.0',
      packument,
    })
    expect(audit.vulnerabilities).toEqual([])
    expect(audit.worstSeverity).toBe('none')
    expect(audit.deprecated).toEqual({ isDeprecated: false })
    expect(audit.freshness.isOutdated).toBe(true)
    expect(audit.recommendedTarget).toBeUndefined()
  })

  it('behindBy counts patch releases within the installed major.minor line', () => {
    const patches: Packument = {
      name: 'p',
      'dist-tags': { latest: '1.4.3' },
      versions: {
        '1.2.0': { version: '1.2.0' },
        '1.2.1': { version: '1.2.1' },
        '1.2.5': { version: '1.2.5' },
        '1.4.3': { version: '1.4.3' },
      },
    }
    const audit = auditDependency({
      packageName: 'p',
      ecosystem: 'npm',
      installedVersion: '1.2.1',
      packument: patches,
    })
    // newer stable: 1.2.5, 1.4.3 ⇒ 2; same major ⇒ 0 majors; latestSameMajor 1.4.3 ⇒ 2 minors;
    // newest patch in the 1.2.x line is 1.2.5 ⇒ 4 patches behind.
    expect(audit.freshness.behindBy).toEqual({ releases: 2, major: 0, minor: 2, patch: 4 })
  })

  it('behindBy is undefined for a non-semver installed version', () => {
    const audit = auditDependency({
      packageName: 'oldpkg',
      ecosystem: 'npm',
      installedVersion: 'not-a-version',
      packument,
    })
    expect(audit.freshness.behindBy).toBeUndefined()
  })
})
