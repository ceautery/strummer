import { describe, expect, it } from 'vitest'
import { sliceChangelog } from './changelog.js'

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
