import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where a detected version came from (most authoritative first). */
export type VersionSource = 'node_modules' | 'package-lock.json' | 'package.json' | 'none'

export interface DetectedVersion {
  /** Concrete installed version, or a declared range, or null if not found. */
  version: string | null
  source: VersionSource
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function depRange(manifest: Record<string, unknown>, pkg: string): string | undefined {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = manifest[field] as Record<string, string> | undefined
    if (deps?.[pkg]) return deps[pkg]
  }
  return undefined
}

/**
 * Detect the version of an npm package installed in a project directory.
 *
 * Prefers the concrete installed version (`node_modules/<pkg>/package.json`,
 * which npm/pnpm/yarn all populate), then `package-lock.json`, then the range
 * declared in `package.json`. The result feeds `resolveVersion`, which accepts
 * concrete versions and ranges alike.
 */
export function detectInstalledVersion(projectDir: string, pkg: string): DetectedVersion {
  const installed = readJson(join(projectDir, 'node_modules', pkg, 'package.json'))
  if (typeof installed?.version === 'string') {
    return { version: installed.version, source: 'node_modules' }
  }

  const lock = readJson(join(projectDir, 'package-lock.json'))
  if (lock) {
    const packages = lock.packages as Record<string, { version?: string }> | undefined
    const deps = lock.dependencies as Record<string, { version?: string }> | undefined
    const locked = packages?.[`node_modules/${pkg}`]?.version ?? deps?.[pkg]?.version
    if (locked) return { version: locked, source: 'package-lock.json' }
  }

  const manifest = readJson(join(projectDir, 'package.json'))
  if (manifest) {
    const range = depRange(manifest, pkg)
    if (range) return { version: range, source: 'package.json' }
  }

  return { version: null, source: 'none' }
}
