/**
 * The RubyGems version comparator (ADR 0012) — a {@link VersionComparator} over `Gem::Version`
 * ordering, implemented on the pinned `@renovatebot/ruby-semver` (zero-dependency, Renovate-grade,
 * exact `Gem::Version#<=>`). RubyGems ships OSV advisory ranges as `ECOSYSTEM` with Gem version
 * strings, which are NOT SemVer (segments split into digit/letter runs, a letter segment sorts
 * below a numeric one, trailing-zero canonicalisation, arbitrary segment count). Our own
 * conformance fixtures gate correctness regardless of the dep.
 *
 * Notes on the underlying lib: it exposes `eq`/`gt`/`lt`/`lte`/`valid`/`prerelease`/`major`/
 * `minor`/`patch` but NO `compare` or `clean`, so `compare` is derived from `eq`/`gt`, and
 * `clean` from `valid`. This module is the only importer of `@renovatebot/ruby-semver`.
 */

import * as gem from '@renovatebot/ruby-semver'
import type { VersionComparator } from './comparator.js'

export const gemComparator: VersionComparator = {
  isValid: (v) => gem.valid(v) !== null,
  // Gem::Version has no lenient coerce; a version is comparable iff it is valid.
  clean: (v) => gem.valid(v),
  compare: (a, b) => (gem.eq(a, b) ? 0 : gem.gt(a, b) ? 1 : -1),
  gt: (a, b) => gem.gt(a, b),
  lt: (a, b) => gem.lt(a, b),
  lte: (a, b) => gem.lte(a, b),
  // A gem version is a pre-release iff it has any letter segment (`prerelease` → the parts, or null).
  isPrerelease: (v) => gem.prerelease(v) !== null,
  // Leading numeric release components; major/minor/patch return null past the numeric run.
  releaseComponents: (v) => {
    if (gem.valid(v) === null) return null
    return [gem.major(v), gem.minor(v), gem.patch(v)].filter(
      (n): n is number => typeof n === 'number',
    )
  },
}
