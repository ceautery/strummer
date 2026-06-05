import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Repo-wide packaging-hygiene guards (ADR 0019, Phase 6). These read every
// workspace package.json from disk — they are pure config assertions, no build,
// no spawn, no network.

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(repoRoot, 'packages')

const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

function readPackageJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8'))
}

describe('package publish hygiene (ADR 0019)', () => {
  it('finds every workspace package', () => {
    // Sanity: the loop below is only meaningful if it actually iterates.
    expect(packageDirs.length).toBeGreaterThanOrEqual(18)
  })

  for (const dir of packageDirs) {
    // biome-ignore lint/suspicious/noExplicitAny: package.json is untyped JSON.
    const pkg = readPackageJson(dir) as any

    describe(pkg.name ?? dir, () => {
      it('keeps the dev `exports["."].types` pointing at SOURCE (no-build in-repo type resolution)', () => {
        // The green gate runs `tsc --noEmit` with NO build step, so cross-package
        // type resolution must reach `./src`, never an unbuilt `./dist`.
        expect(pkg.exports?.['.']?.types).toBe('./src/index.ts')
      })

      it('overlays publish-time `exports["."]` onto built dist via a nested `import` condition', () => {
        // pnpm replaces top-level fields with `publishConfig` ones at pack/publish
        // time, so the SHIPPED tarball (files: ["dist"]) resolves types from dist.
        // A nested `import` condition (not flat default+.d.mts) keeps attw happy.
        const overlay = pkg.publishConfig?.exports?.['.']
        expect(overlay?.import?.types).toBe('./dist/index.d.mts')
        expect(overlay?.import?.default).toBe('./dist/index.mjs')
      })

      it('ships the dist directory', () => {
        expect(pkg.files).toContain('dist')
      })

      it('is publishable: no private flag, public access, repository directory set', () => {
        expect(pkg.private).not.toBe(true)
        expect(pkg.publishConfig?.access).toBe('public')
        // repository.directory + a case-exact url are required for npm provenance.
        expect(pkg.repository?.directory).toBe(`packages/${dir}`)
        expect(pkg.repository?.url).toBe('git+https://github.com/ceautery/strummer.git')
      })
    })
  }
})

describe('@strummer/mcp install isolation — heavy engines are OPTIONAL peers (ADR 0019 §B)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: package.json is untyped JSON.
  const mcp = readPackageJson('mcp') as any
  const HEAVY = ['@strummer/browser', '@strummer/core', '@strummer/embed', '@strummer/flake']

  it('does NOT list the heavy engines (or playwright-core) as hard dependencies', () => {
    const deps = Object.keys(mcp.dependencies ?? {})
    for (const h of [...HEAVY, 'playwright-core']) expect(deps).not.toContain(h)
  })

  it('declares them as OPTIONAL peer dependencies (so a bare install is native-free)', () => {
    for (const h of [...HEAVY, 'playwright-core']) {
      expect(mcp.peerDependencies?.[h]).toBeDefined()
      expect(mcp.peerDependenciesMeta?.[h]?.optional).toBe(true)
    }
  })

  it('keeps them as devDependencies so the workspace still resolves them for build/test', () => {
    for (const h of HEAVY) expect(mcp.devDependencies?.[h]).toBeDefined()
  })
})

describe('onboarding example .mcp.json (ADR 0019 §14)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: JSON config is untyped.
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'examples/mcp/.mcp.json'), 'utf8')) as any
  const server = cfg.mcpServers?.strummer
  // biome-ignore lint/suspicious/noExplicitAny: package.json is untyped JSON.
  const mcp = readPackageJson('mcp') as any

  it('declares the aggregate strummer server', () => {
    expect(server).toBeDefined()
    expect(server.command).toBe('npx')
    expect(server.args).toContain('@strummer/mcp')
  })

  it('the documented `npx @strummer/mcp` resolves to a REAL bin (no npx trap)', () => {
    // npx runs the bin matching the package name's last segment — `mcp` for
    // @strummer/mcp. If that bin is missing, `npx @strummer/mcp` errors.
    expect(mcp.bin?.mcp).toBeDefined()
  })

  it('only sets operator namespaced env (no agent inputs leak into config)', () => {
    for (const key of Object.keys(server.env ?? {})) {
      expect(key.startsWith('STRUMMER_')).toBe(true)
    }
  })
})
