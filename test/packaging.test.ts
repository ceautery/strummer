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
    })
  }
})
