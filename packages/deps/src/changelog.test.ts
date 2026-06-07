import { describe, expect, it } from 'vitest'
import { sliceChangelog } from './changelog.js'
import type { VersionComparator } from './comparator.js'
import { comparatorFor } from './ecosystem.js'

// Keep-a-Changelog style: `## [x.y.z] - date`, with subsection headings inside.
const KEEP_A_CHANGELOG = `# Changelog

All notable changes are documented here.

## [Unreleased]
- work in progress

## [4.17.21] - 2021-02-20
### Security
- Fix command injection (CVE-2021-23337)

## [4.17.20] - 2020-08-13
### Bug Fixes
- Misc fixes

## [4.17.15] - 2019-07-19
- Old release

## [4.17.0] - 2018-08-01
- Older still
`

// Plain style: `## v1.2.3` with no dates, newest at the top.
const PLAIN = `## v2.0.0
- breaking change

## v1.5.0
- a feature

## v1.4.2
- a patch
`

describe('sliceChangelog — extract the version sections between two versions', () => {
  it('returns sections in (from, to], newest first (excludes the installed version)', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '4.17.15', to: '4.17.21' })
    expect(slice.entries.map((e) => e.version)).toEqual(['4.17.21', '4.17.20'])
    // The installed (from) version and anything older are excluded.
    expect(slice.entries.map((e) => e.version)).not.toContain('4.17.15')
    expect(slice.entries.map((e) => e.version)).not.toContain('4.17.0')
  })

  it('keeps a section body, including its heading and subsection content', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '4.17.20', to: '4.17.21' })
    expect(slice.entries).toHaveLength(1)
    const body = slice.entries[0]?.body ?? ''
    expect(body).toContain('4.17.21')
    expect(body).toContain('### Security')
    expect(body).toContain('CVE-2021-23337')
    // It must not bleed into the next (older) version's section.
    expect(body).not.toContain('Misc fixes')
  })

  it('treats `to` as optional — everything newer than `from`', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '4.17.19' })
    expect(slice.entries.map((e) => e.version)).toEqual(['4.17.21', '4.17.20'])
  })

  it('parses plain `## vX.Y.Z` headings and orders semantically (not file order)', () => {
    const slice = sliceChangelog(PLAIN, { from: '1.4.2' })
    expect(slice.entries.map((e) => e.version)).toEqual(['2.0.0', '1.5.0'])
  })

  it('reports every versioned heading found, newest first, for diagnostics', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '0.0.0' })
    expect(slice.allVersions).toEqual(['4.17.21', '4.17.20', '4.17.15', '4.17.0'])
  })

  it('ignores non-version headings (Unreleased) and date tokens', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '0.0.0' })
    // "Unreleased" and the "2021-02-20" dates never become versions.
    expect(slice.allVersions).not.toContain('2021.2.20')
    expect(slice.entries.some((e) => e.body.includes('work in progress'))).toBe(false)
  })

  it('handles prereleases (semver ordering, not lexical)', () => {
    const md = `## 2.0.0\n- final\n\n## 2.0.0-beta.2\n- beta 2\n\n## 2.0.0-beta.1\n- beta 1\n`
    const slice = sliceChangelog(md, { from: '2.0.0-beta.1', to: '2.0.0' })
    expect(slice.entries.map((e) => e.version)).toEqual(['2.0.0', '2.0.0-beta.2'])
  })

  it('returns no entries when nothing falls in range', () => {
    const slice = sliceChangelog(KEEP_A_CHANGELOG, { from: '4.17.21' })
    expect(slice.entries).toEqual([])
  })

  it('throws on an unparseable `from`', () => {
    expect(() => sliceChangelog(PLAIN, { from: 'not-a-version' })).toThrow(/version/i)
  })
})

describe('sliceChangelog — injected ecosystem comparator', () => {
  // A PyPI-flavoured changelog: plain X.Y.Z headings (the staged heading regex), PEP 440 bounds.
  const PYPI_LOG = `## 2.32.0
- big change

## 2.31.1
- a fix

## 2.31.0
- baseline
`

  it('slices a PyPI changelog with PEP 440 bounds via the PyPI comparator', () => {
    const slice = sliceChangelog(PYPI_LOG, {
      from: '2.31.0',
      to: '2.32.0',
      comparator: comparatorFor('PyPI'),
    })
    expect(slice.entries.map((e) => e.version)).toEqual(['2.32.0', '2.31.1'])
  })

  it('detects PEP 440 two-segment headings (## 1.0) — PyPI', () => {
    const md = `## 1.2\n- newer\n\n## 1.1\n- mid\n\n## 1.0\n- base\n`
    const slice = sliceChangelog(md, { from: '1.0', to: '1.2', comparator: comparatorFor('PyPI') })
    expect(slice.entries.map((e) => e.version)).toEqual(['1.2', '1.1'])
  })

  it('detects PEP 440 letter-prerelease headings (## 2.0.0rc1 / ## 2.0.0a1) — PyPI', () => {
    // Without ecosystem-aware detection, `2.0.0rc1` is silently misread as `2.0.0` (the strict
    // semver token stops at the third segment), colliding with the real `## 2.0.0` section.
    const md = `## 2.0.0\n- final\n\n## 2.0.0rc1\n- release candidate\n\n## 2.0.0a1\n- alpha\n`
    const c = comparatorFor('PyPI')
    const all = sliceChangelog(md, { from: '0', comparator: c })
    expect(all.allVersions).toEqual(['2.0.0', '2.0.0rc1', '2.0.0a1'])
    const slice = sliceChangelog(md, { from: '2.0.0a1', to: '2.0.0rc1', comparator: c })
    expect(slice.entries.map((e) => e.version)).toEqual(['2.0.0rc1'])
  })

  it('detects RubyGems N-segment headings (## 1.2.3.4) — RubyGems', () => {
    // The strict semver token would stop at `1.2.3`, collapsing every 4-segment heading together.
    const md = `## 1.2.3.4\n- four\n\n## 1.2.3.3\n- three\n\n## 1.2.3.2\n- base\n`
    const slice = sliceChangelog(md, {
      from: '1.2.3.2',
      to: '1.2.3.4',
      comparator: comparatorFor('RubyGems'),
    })
    expect(slice.entries.map((e) => e.version)).toEqual(['1.2.3.4', '1.2.3.3'])
  })

  it('detects RubyGems letter-segment prerelease headings (## 1.0.0.pre.2) — RubyGems', () => {
    const md = `## 1.0.0\n- final\n\n## 1.0.0.pre.2\n- pre 2\n\n## 1.0.0.pre.1\n- pre 1\n`
    const slice = sliceChangelog(md, {
      from: '1.0.0.pre.1',
      to: '1.0.0.pre.2',
      comparator: comparatorFor('RubyGems'),
    })
    expect(slice.entries.map((e) => e.version)).toEqual(['1.0.0.pre.2'])
  })

  it('does not mistake a date for a version (## 1.0 - 2024-01-15) — PyPI', () => {
    const md = `## 1.1 - 2024-06-01\n- newer\n\n## 1.0 - 2024-01-15\n- base\n`
    const slice = sliceChangelog(md, { from: '0', comparator: comparatorFor('PyPI') })
    expect(slice.allVersions).toEqual(['1.1', '1.0'])
  })

  it('actually consults the injected comparator for the range filter (seam check)', () => {
    // A comparator whose ordering is inverted: `gt`/`lte`/`compare` are flipped, so the `(from, to]`
    // filter selects the OPPOSITE sections — proving the param drives selection, not a hardcoded semver.
    const base = comparatorFor('npm')
    const inverted: VersionComparator = {
      ...base,
      compare: (a, b) => -base.compare(a, b) as -1 | 0 | 1,
      gt: (a, b) => base.lt(a, b),
      lt: (a, b) => base.gt(a, b),
      lte: (a, b) => base.gt(a, b) || base.compare(a, b) === 0,
    }
    const slice = sliceChangelog(PYPI_LOG, { from: '2.31.1', comparator: inverted })
    // With inverted `gt`, "newer than 2.31.1" means strictly-lower → only 2.31.0.
    expect(slice.entries.map((e) => e.version)).toEqual(['2.31.0'])
  })
})
