import { describe, expect, it } from 'vitest'
import { type RubyGemsVersion, rubygemsToPackument, rubyManifestNames } from './rubygems.js'

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

describe('rubyManifestNames', () => {
  const lock = `GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.0.4)
    rails (7.0.4)
      actionpack (= 7.0.4)
    rspec-core (3.12.0)

PLATFORMS
  ruby

DEPENDENCIES
  rails (~> 7.0)
  rspec-rails
  my_gem!

BUNDLED WITH
   2.4.0
`

  it('reads the DEPENDENCIES block of a Gemfile.lock (declared gems, not the resolved tree)', () => {
    // Note: actionpack/rspec-core are transitive specs, NOT declared dependencies.
    expect(rubyManifestNames({ gemfileLock: lock })).toEqual(['my_gem', 'rails', 'rspec-rails'])
  })

  it('falls back to the Gemfile gem lines', () => {
    const gemfile = `source "https://rubygems.org"
gem "rails", "~> 7.0"
gem 'puma'
group :development do
  gem "rspec-rails"
end
`
    expect(rubyManifestNames({ gemfile })).toEqual(['puma', 'rails', 'rspec-rails'])
  })
})
