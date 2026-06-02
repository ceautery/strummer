/**
 * Ecosystem dispatch — the pure (+ filesystem, like {@link loadOsvSnapshot}) glue that
 * maps an OSV ecosystem to its version algebra, its OSV match-name convention, and the
 * way its project manifest declares dependencies. Extracted from the MCP deps surface so
 * the surface AND the `strummer deps` CLI share one source of truth for ecosystem
 * behaviour (ADR 0012: semver silently mis-coerces PEP 440 / Gem, so the comparator must
 * be chosen by ecosystem, never defaulted).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VersionComparator } from './comparator.js'
import { semverComparator } from './comparator.js'
import { gemComparator } from './gem.js'
import { pep440Comparator } from './pep440.js'
import { normalizePypiName, pythonManifestNames } from './pypi.js'
import { rubyManifestNames } from './rubygems.js'

/** OSV ecosystem names Strummer audits end-to-end (npm/PyPI/RubyGems). */
export const OSV_ECOSYSTEMS = ['npm', 'PyPI', 'RubyGems'] as const
export type OsvEcosystem = (typeof OSV_ECOSYSTEMS)[number]

/** Version algebra per ecosystem (ADR 0012): npm=semver, PyPI=PEP 440, RubyGems=Gem. */
const COMPARATORS: Record<OsvEcosystem, VersionComparator> = {
  npm: semverComparator,
  PyPI: pep440Comparator,
  RubyGems: gemComparator,
}

/** The comparator for an ecosystem (never defaulted — semver mis-handles PEP 440 / Gem). */
export function comparatorFor(ecosystem: OsvEcosystem): VersionComparator {
  return COMPARATORS[ecosystem]
}

/** The name OSV matches on. PyPI advisory names are PEP 503-normalized; npm/Gem as-is. */
export function matchName(packageName: string, ecosystem: OsvEcosystem): string {
  return ecosystem === 'PyPI' ? normalizePypiName(packageName) : packageName
}

/** Read a file, or undefined when it doesn't exist (other read errors propagate). */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** Read a project's npm manifest dependency names (prod + optional + optionally dev). */
function npmManifestNames(project: string, includeDev: boolean): string[] {
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
  if (includeDev) for (const n of Object.keys(pkg.devDependencies ?? {})) names.add(n)
  return [...names].sort()
}

/** Declared top-level dependency names for a project, dispatched by ecosystem. */
export function dependencyNames(
  project: string,
  ecosystem: OsvEcosystem,
  includeDev: boolean,
): string[] {
  if (ecosystem === 'PyPI') {
    return pythonManifestNames(
      {
        pyproject: readIfPresent(join(project, 'pyproject.toml')),
        requirements: readIfPresent(join(project, 'requirements.txt')),
      },
      { includeDev },
    )
  }
  if (ecosystem === 'RubyGems') {
    return rubyManifestNames({
      gemfileLock: readIfPresent(join(project, 'Gemfile.lock')),
      gemfile: readIfPresent(join(project, 'Gemfile')),
    })
  }
  return npmManifestNames(project, includeDev)
}
