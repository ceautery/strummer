import { describe, expect, it } from 'vitest'
import { type RubyGemsVersion, rubygemsToPackument } from './rubygems.js'

describe('rubygemsToPackument', () => {
  it('maps the RubyGems versions array into a Packument (no dist-tags; freshness derives latest)', () => {
    const versions: RubyGemsVersion[] = [
      { number: '7.0.4', prerelease: false },
      { number: '7.0.8', prerelease: false },
      { number: '7.1.0', prerelease: false },
      { number: '7.1.0.rc1', prerelease: true },
    ]
    const p = rubygemsToPackument('rails', versions)
    expect(p.name).toBe('rails')
    expect(Object.keys(p.versions).sort()).toEqual(['7.0.4', '7.0.8', '7.1.0', '7.1.0.rc1'])
    expect(p.versions['7.0.8']).toEqual({ version: '7.0.8' })
    // No npm-style latest tag — the freshness core re-derives it with gemComparator.
    expect(p['dist-tags']).toBeUndefined()
  })

  it('tolerates a degenerate/empty versions array', () => {
    expect(rubygemsToPackument('x', []).versions).toEqual({})
  })
})
