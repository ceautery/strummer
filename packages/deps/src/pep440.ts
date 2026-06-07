/**
 * The PyPI version comparator (ADR 0012) — a {@link VersionComparator} over PEP 440 ordering,
 * implemented on the pinned `@renovatebot/pep440` (zero-dependency, Renovate-grade). PyPI ships
 * OSV advisory ranges as `ECOSYSTEM` with PEP 440 version strings, which are NOT SemVer
 * (epochs `N!`, `dev` sorts below pre-releases, post-releases, local `+labels`, zero-pad
 * equivalence); running them through semver silently mis-orders them. Our own conformance
 * fixtures (the canonical PEP 440 sequence) gate correctness regardless of the dep.
 *
 * This module is the only importer of `@renovatebot/pep440`; the pure audit/OSV core depends
 * solely on the `VersionComparator` interface and is handed this instance at the wiring layer.
 */

import * as pep440 from '@renovatebot/pep440'
import type { VersionComparator } from './comparator.js'

/** `@renovatebot/pep440`'s `explain()` result — the parsed PEP 440 structure we read. */
interface Pep440Explained {
  release: number[]
  is_prerelease: boolean
}

function explain(version: string): Pep440Explained | null {
  return (pep440.explain(version) as Pep440Explained | null) ?? null
}

/**
 * Candidate PEP 440 version tokens in a changelog heading — a superset `pep440.valid` then filters.
 * Requires ≥2 numeric segments (so a bare year like `2024` in a date is never a candidate), and
 * accepts the PEP 440 shapes a strict semver token misses: an optional `N!` epoch, two-segment
 * releases (`1.0`), letter pre-releases with or without a separator (`1.0rc1`, `2.0.0a1`),
 * post/dev releases, and a `+local` label. Case-insensitive (`2.0.0RC1`).
 */
const PEP440_TOKEN =
  /(?:\d+!)?\d+(?:\.\d+)+(?:[._-]?(?:preview|alpha|beta|post|rev|dev|pre|rc|a|b|c)\.?\d*)*(?:\+[0-9A-Za-z][0-9A-Za-z.]*)?/gi

export const pep440Comparator: VersionComparator = {
  isValid: (v) => pep440.valid(v) !== null,
  // PEP 440 has no lenient "coerce"; a version is comparable iff it is valid.
  clean: (v) => pep440.valid(v),
  // pep440.compare returns an arbitrary-magnitude signed integer; normalize to -1|0|1.
  compare: (a, b) => Math.sign(pep440.compare(a, b)) as -1 | 0 | 1,
  gt: (a, b) => pep440.gt(a, b),
  lt: (a, b) => pep440.lt(a, b),
  lte: (a, b) => pep440.lte(a, b),
  isPrerelease: (v) => explain(v)?.is_prerelease ?? false,
  // The release tuple (epoch-independent). Variable length — behindBy reads [0..2] and
  // floors missing components at 0, so a 2-segment release degrades cleanly.
  releaseComponents: (v) => explain(v)?.release ?? null,
  versionTokens: (headingText) => headingText.match(PEP440_TOKEN) ?? [],
}
