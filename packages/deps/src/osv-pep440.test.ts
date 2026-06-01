import { describe, expect, it } from 'vitest'
import { matchVulnerabilities, type OsvAdvisory } from './osv.js'
import { pep440Comparator } from './pep440.js'

const pkg = { ecosystem: 'PyPI', name: 'demo' }

const advisory: OsvAdvisory = {
  id: 'PYSEC-0000-1',
  modified: '2026-01-01T00:00:00Z',
  summary: 'demo PyPI advisory',
  affected: [
    {
      package: pkg,
      ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { fixed: '2.0.1' }] }],
      database_specific: { severity: 'HIGH' },
    },
  ],
}

describe('OSV PyPI range matching via pep440Comparator', () => {
  it('evaluates an ECOSYSTEM range correctly across the prerelease boundary', () => {
    // 2.0.0rc1 < 2.0.0 (rc precedes the final) → the vuln (introduced at the final) has not begun.
    expect(matchVulnerabilities([advisory], pkg, '2.0.0rc1', pep440Comparator)).toEqual([])
    expect(matchVulnerabilities([advisory], pkg, '2.0.0', pep440Comparator)).toHaveLength(1)
    // fixed is exclusive → the fix version itself is safe.
    expect(matchVulnerabilities([advisory], pkg, '2.0.1', pep440Comparator)).toEqual([])
  })

  it('honours epoch dominance in the scan (1!1.0 is past a non-epoch fix)', () => {
    const epochAdvisory: OsvAdvisory = {
      ...advisory,
      affected: [
        {
          package: pkg,
          ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.0' }] }],
        },
      ],
    }
    expect(matchVulnerabilities([epochAdvisory], pkg, '1!1.0', pep440Comparator)).toEqual([])
    expect(matchVulnerabilities([epochAdvisory], pkg, '1.5', pep440Comparator)).toHaveLength(1)
  })

  it('documents WHY the comparator is load-bearing: the semver default mis-flags the rc', () => {
    // semver.coerce('2.0.0rc1') → '2.0.0', which falls in [2.0.0, 2.0.1) → a false positive.
    // This is exactly the silent-wrong trap ADR 0012 closes by injecting pep440Comparator.
    expect(matchVulnerabilities([advisory], pkg, '2.0.0rc1')).toHaveLength(1)
  })
})
