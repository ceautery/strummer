import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDepsServerFromEnv } from './bin-deps.js'

const tmpDirs: string[] = []
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('strummer-deps-mcp bin config (operator env)', () => {
  it('defaults to no snapshot/artifacts, network off, public registry, private blocked', () => {
    expect(buildDepsServerFromEnv({}).config).toEqual({
      osvDir: undefined,
      artifactDir: undefined,
      allowNetwork: false,
      registry: 'https://registry.npmjs.org',
      pypiRegistry: 'https://pypi.org/pypi',
      allowPrivate: false,
    })
  })

  it('reads the PyPI registry base from STRUMMER_DEPS_PYPI_REGISTRY', () => {
    const { config } = buildDepsServerFromEnv({
      STRUMMER_DEPS_PYPI_REGISTRY: 'https://pypi.example.test/pypi',
    })
    expect(config.pypiRegistry).toBe('https://pypi.example.test/pypi')
  })

  it('reads the OSV snapshot dir from STRUMMER_DEPS_OSV_DB_DIR', () => {
    const { config } = buildDepsServerFromEnv({ STRUMMER_DEPS_OSV_DB_DIR: '/var/lib/osv' })
    expect(config.osvDir).toBe('/var/lib/osv')
  })

  it('reads the artifact dir from STRUMMER_DEPS_ARTIFACT_DIR (enables changelog_diff)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-deps-bin-'))
    tmpDirs.push(dir)
    const { config } = buildDepsServerFromEnv({ STRUMMER_DEPS_ARTIFACT_DIR: dir })
    expect(config.artifactDir).toBe(dir)
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
