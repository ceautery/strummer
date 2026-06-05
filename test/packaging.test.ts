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

      it('overlays the legacy top-level `types` onto dist (attw/publint: no unshipped types)', () => {
        // The dev top-level `types` points at ./src (no-build resolution); the shipped tarball
        // must point it at the emitted .d.mts, or node10/legacy resolvers + publint see an
        // unshipped types file (caught by scripts/package-checks.sh; locked here, ADR 0019 §16).
        expect(pkg.publishConfig?.types).toBe('./dist/index.d.mts')
      })

      it('ships the dist directory', () => {
        expect(pkg.files).toContain('dist')
      })

      it('is publishable: no private flag, public access, repository directory set', () => {
        expect(pkg.private).not.toBe(true)
        expect(pkg.publishConfig?.access).toBe('public')
        // repository.directory + a case-exact url are required for npm provenance.
        expect(pkg.repository?.directory).toBe(`packages/${dir}`)
        expect(pkg.repository?.url).toBe('git+https://github.com/ceautery/sackville.git')
      })
    })
  }
})

describe('sackville install isolation — heavy engines are OPTIONAL peers (ADR 0019 §B)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: package.json is untyped JSON.
  const mcp = readPackageJson('mcp') as any
  const HEAVY = [
    '@sackville-mcp/browser',
    '@sackville-mcp/core',
    '@sackville-mcp/embed',
    '@sackville-mcp/flake',
  ]

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

describe('default-pillar wiring is native-free (ADR 0019 §B; alpha.0 regression)', () => {
  // alpha.0 shipped broken: `mcp/src/deps.ts` STATICALLY value-imported the OPTIONAL
  // peer `@sackville-mcp/core`, so the dynamically-imported deps chunk threw
  // ERR_MODULE_NOT_FOUND on a bare (native-free) install — silently taking the deps AND
  // verify pillars down, collapsing the curated default from [api,deps,verify] to [api].
  // The default-pillar wiring must reach an optional peer only via `import type` or
  // `await import()`, never a top-level value import.
  const OPTIONAL_PEERS = [
    '@sackville-mcp/core',
    '@sackville-mcp/embed',
    '@sackville-mcp/browser',
    '@sackville-mcp/flake',
    'playwright-core',
  ]
  // The source files reachable when the aggregate loads the curated default pillars.
  const DEFAULT_WIRING = [
    'aggregate.ts',
    'pillars.ts',
    'api.ts',
    'deps.ts',
    'verify.ts',
    'bin-api.ts',
    'bin-deps.ts',
    'bin-verify.ts',
  ]
  const mcpSrc = join(packagesDir, 'mcp', 'src')

  // A STATIC value import: `import ...non-type... from '<peer>'`. We allow `import type`
  // and brace lists whose every specifier is `type`-prefixed; flag anything that pulls a
  // runtime binding.
  function staticValueImportsOf(source: string, peer: string): boolean {
    const re = /import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g
    for (const m of source.matchAll(re)) {
      const [, typeKw, clause, from] = m
      if (from !== peer) continue
      if (typeKw) continue // `import type … from '<peer>'` — erased, safe
      const brace = clause.match(/\{([^}]*)\}/)
      if (brace) {
        const allType = brace[1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .every((s) => s.startsWith('type '))
        if (allType) continue // `import { type A, type B } from '<peer>'` — all erased
      }
      return true // a runtime binding is pulled from an optional peer
    }
    return false
  }

  for (const file of DEFAULT_WIRING) {
    it(`${file} reaches optional peers only lazily (type-only / await import)`, () => {
      const source = readFileSync(join(mcpSrc, file), 'utf8')
      for (const peer of OPTIONAL_PEERS) {
        expect(
          staticValueImportsOf(source, peer),
          `${file} statically value-imports the optional peer ${peer} (use \`import type\` or \`await import()\`)`,
        ).toBe(false)
      }
    })
  }
})

describe('onboarding example .mcp.json (ADR 0019 §14)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: JSON config is untyped.
  const cfg = JSON.parse(readFileSync(join(repoRoot, 'examples/mcp/.mcp.json'), 'utf8')) as any
  const server = cfg.mcpServers?.['sackville-mcp']
  // biome-ignore lint/suspicious/noExplicitAny: package.json is untyped JSON.
  const mcp = readPackageJson('mcp') as any

  it('declares the aggregate sackville-mcp server', () => {
    expect(server).toBeDefined()
    expect(server.command).toBe('npx')
    expect(server.args).toContain('sackville-mcp')
  })

  it('the documented `npx sackville-mcp` resolves to a REAL bin (no npx trap)', () => {
    // npx runs the bin matching the package name — `sackville-mcp`. If that bin
    // is missing, `npx sackville-mcp` errors.
    expect(mcp.bin?.['sackville-mcp']).toBeDefined()
  })

  it('only sets operator namespaced env (no agent inputs leak into config)', () => {
    for (const key of Object.keys(server.env ?? {})) {
      expect(key.startsWith('SACKVILLE_')).toBe(true)
    }
  })
})
