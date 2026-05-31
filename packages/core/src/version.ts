import type Database from 'better-sqlite3'
import semver from 'semver'

/** Outcome of resolving an installed version to an available doc release. */
export interface VersionResolution {
  /** The available version string to use, or null if none is acceptable. */
  resolved: string | null
  /** True when the request was exactly satisfied (not a same-major fallback). */
  exact: boolean
  /** Human/agent-readable explanation of the decision. */
  note: string
  /** Available versions, newest first. */
  available: string[]
}

/** Distinct versions of a library present in the index, newest first. */
export function listVersions(db: Database.Database, library: string): string[] {
  const rows = db
    .prepare('SELECT DISTINCT version FROM docs WHERE library = ? ORDER BY version')
    .all(library) as { version: string }[]
  return sortDesc(rows.map((r) => r.version))
}

function sortDesc(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const av = semver.coerce(a)
    const bv = semver.coerce(b)
    if (av && bv) return semver.rcompare(av, bv)
    return b.localeCompare(a)
  })
}

/**
 * Resolve a requested/installed version (exact, range, or bare major) to the
 * best available doc release.
 *
 * Policy (ARCHITECTURE §7.2): prefer an exactly-satisfying release; otherwise
 * fall back to the newest release sharing the requested MAJOR and flag it;
 * never silently return a wrong-major release.
 */
export function resolveVersion(available: string[], requested: string): VersionResolution {
  const sorted = sortDesc(available)
  if (sorted.length === 0) {
    return { resolved: null, exact: false, note: 'no versions are indexed', available: sorted }
  }

  // 1. Exact / range satisfaction — newest first.
  for (const version of sorted) {
    const coerced = semver.coerce(version)
    if (coerced && satisfies(coerced, requested)) {
      return {
        resolved: version,
        exact: true,
        note: `matched ${requested} to ${version}`,
        available: sorted,
      }
    }
  }

  // 2. Same-major fallback.
  const major = requestedMajor(requested)
  if (major !== null) {
    for (const version of sorted) {
      if (semver.coerce(version)?.major === major) {
        return {
          resolved: version,
          exact: false,
          note: `no exact docs for ${requested}; using nearest ${major}.x release ${version}`,
          available: sorted,
        }
      }
    }
  }

  // 3. Refuse — never serve a wrong-major release silently.
  return {
    resolved: null,
    exact: false,
    note: `no docs for ${requested}; available versions: ${sorted.join(', ')}`,
    available: sorted,
  }
}

function satisfies(version: semver.SemVer, requested: string): boolean {
  if (semver.validRange(requested)) {
    return semver.satisfies(version, requested)
  }
  const coerced = semver.coerce(requested)
  return coerced ? semver.eq(version, coerced) : false
}

function requestedMajor(requested: string): number | null {
  const coerced = semver.coerce(requested)
  if (coerced) return coerced.major
  const min = semver.validRange(requested) ? semver.minVersion(requested) : null
  return min ? min.major : null
}
