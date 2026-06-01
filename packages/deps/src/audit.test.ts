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
    })
    expect(audit.recommendedTarget).toBe('1.2.0')
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
    })
    expect(audit.recommendedTarget).toBeUndefined()
    expect(audit.hasFindings).toBe(false)
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
})
