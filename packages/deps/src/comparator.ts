/**
 * Pluggable version algebra (ADR 0012). The audit + OSV core compares versions through this
 * interface instead of importing `semver` directly, so the deps pillar can correctly evaluate
 * PyPI (PEP 440) and RubyGems (`Gem::Version`) versions — neither of which is SemVer — without
 * the silent mis-coercion that running an `ECOSYSTEM` range through `semver.compare` causes.
 *
 * The comparator is **injected** (the bin/surface builds an ecosystem→comparator map), so the
 * pure core depends only on this interface + its existing `semver` pin — the per-ecosystem
 * pins (`@renovatebot/pep440`, `@renovatebot/ruby-semver`) live at the wiring layer, never as a
 * transitive import of `@sackville/deps`'s core (the ADR-0010 explicit-pins / no-transitive rule).
 *
 * Only methods an existing call site needs are present. `compare`/`gt`/`lt`/`lte` assume valid,
 * already-`clean`ed inputs (the OSV scan cleans + handles the `"0"` sentinel before calling).
 */

import semver from 'semver'

export interface VersionComparator {
  /** True iff `version` parses as a valid version in this ecosystem. */
  isValid(version: string): boolean
  /**
   * Coerce a version-ish string to a comparable version, or null if hopeless. Ecosystem-defined
   * leniency (semver coerces `v1.2` → `1.2.0`); used by the OSV range scan to tolerate odd events.
   */
  clean(version: string): string | null
  /** Total order: -1 (`a<b`), 0 (`a==b`), 1 (`a>b`). Powers sorting + the OSV range scan. */
  compare(a: string, b: string): -1 | 0 | 1
  gt(a: string, b: string): boolean
  lt(a: string, b: string): boolean
  lte(a: string, b: string): boolean
  /** True for a pre-release / unstable version (excluded from freshness's stable set). */
  isPrerelease(version: string): boolean
  /**
   * Release components as a numeric tuple, or null if unparseable. `[0]`=major, `[1]`=minor,
   * `[2]`=patch. Powers `behindBy` / `latestSameMajor` / `latestSamePatchLine`; when null, those
   * degrade to `undefined` rather than fabricating a triple we cannot read.
   */
  releaseComponents(version: string): number[] | null
}

/** The npm comparator: a thin, behavior-preserving wrap of the existing `semver` pin. */
export const semverComparator: VersionComparator = {
  isValid: (v) => semver.valid(v) !== null,
  clean: (v) => semver.valid(v) ?? semver.coerce(v)?.version ?? null,
  compare: (a, b) => semver.compare(a, b) as -1 | 0 | 1,
  gt: (a, b) => semver.gt(a, b),
  lt: (a, b) => semver.lt(a, b),
  lte: (a, b) => semver.lte(a, b),
  isPrerelease: (v) => semver.prerelease(v) !== null,
  releaseComponents: (v) =>
    semver.valid(v) !== null ? [semver.major(v), semver.minor(v), semver.patch(v)] : null,
}
