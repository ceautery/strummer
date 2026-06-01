import { describe, expect, it } from 'vitest'
import { buildDepsServerFromEnv } from './bin-deps.js'

describe('strummer-deps-mcp bin config (operator env)', () => {
  it('defaults to no snapshot, network off, public registry, private blocked', () => {
    expect(buildDepsServerFromEnv({}).config).toEqual({
      osvDir: undefined,
      allowNetwork: false,
      registry: 'https://registry.npmjs.org',
      allowPrivate: false,
    })
  })

  it('reads the OSV snapshot dir from STRUMMER_DEPS_OSV_DB_DIR', () => {
    const { config } = buildDepsServerFromEnv({ STRUMMER_DEPS_OSV_DB_DIR: '/var/lib/osv' })
    expect(config.osvDir).toBe('/var/lib/osv')
  })

  it('enables network only via STRUMMER_DEPS_ALLOW_NETWORK', () => {
    expect(buildDepsServerFromEnv({ STRUMMER_DEPS_ALLOW_NETWORK: '1' }).config.allowNetwork).toBe(
      true,
    )
    expect(buildDepsServerFromEnv({}).config.allowNetwork).toBe(false)
  })

  it('overrides the registry and permits a private mirror', () => {
    const { config } = buildDepsServerFromEnv({
      STRUMMER_DEPS_NPM_REGISTRY: 'http://localhost:4873',
      STRUMMER_DEPS_ALLOW_PRIVATE: 'true',
    })
    expect(config.registry).toBe('http://localhost:4873')
    expect(config.allowPrivate).toBe(true)
  })

  it('always builds a usable server', () => {
    expect(buildDepsServerFromEnv({}).server).toBeDefined()
    expect(buildDepsServerFromEnv({ STRUMMER_DEPS_ALLOW_NETWORK: '1' }).server).toBeDefined()
  })
})
