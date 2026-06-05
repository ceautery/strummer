/**
 * OSV vulnerability matching — the second offline slice of the dependency-intelligence
 * pillar. Given a set of already-parsed OSV advisories (the JSON shape published at
 * `osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`) and the installed
 * version of a package, decide which advisories actually affect that version.
 *
 * This is a pure reducer: no network, no subprocess, no disk. Reading the operator-
 * provisioned on-disk OSV snapshot (unzip + load) is a later slice; keeping the
 * version-range evaluation pure here is what lets the green gate stay deterministic.
 *
 * Range evaluation follows the OSV schema's documented algorithm
 * (https://ossf.github.io/osv-schema/): for a SEMVER or ECOSYSTEM range, sort the events
 * ascending by version (with the sentinel `introduced: "0"` first), then scan — an
 * `introduced` turns the affected state on at/after its version, a `fixed` turns it
 * off at/after its version (exclusive), and a `last_affected` turns it off strictly
 * after its version (inclusive). The final state decides membership.
 *
 * Version ordering is delegated to an injected {@link VersionComparator} (ADR 0012): an
 * ECOSYSTEM range carries versions in the ecosystem's own scheme (npm=SemVer, PyPI=PEP 440,
 * RubyGems=Gem), so the caller passes the matching comparator; it defaults to semver (npm).
 */

import { QUALITATIVE_RANK, type QualitativeSeverity } from '@sackville/severity'
import { semverComparator, type VersionComparator } from './comparator.js'
import { cvssV3BaseScore } from './cvss.js'

/** A CVSS severity entry (OSV schema): `type` like `CVSS_V3`, `score` is the vector string. */
export interface OsvSeverity {
  type: string
  score: string
}

/** An OSV range event. Exactly one of the three keys is set per event. */
export interface OsvEvent {
  introduced?: string
  fixed?: string
  last_affected?: string
}

export interface OsvRange {
  type: 'SEMVER' | 'ECOSYSTEM' | 'GIT'
  events: OsvEvent[]
}

export interface OsvAffected {
  package: { ecosystem: string; name: string }
  ranges?: OsvRange[]
  /** An explicit enumeration of affected versions (used instead of, or alongside, ranges). */
  versions?: string[]
  severity?: OsvSeverity[]
  database_specific?: { severity?: string }
}

export interface OsvAdvisory {
  id: string
  /** RFC3339 UTC timestamp of the advisory's last modification (used as a snapshot-staleness proxy). */
  modified?: string
  aliases?: string[]
  summary?: string
  details?: string
  affected: OsvAffected[]
  /** Top-level CVSS severity entries (the qualitative string lives in `database_specific`). */
  severity?: OsvSeverity[]
  database_specific?: { severity?: string }
}

/**
 * A fixed, bucketed severity scale so output is stable across snapshots and source
 * schemas. Built on the shared `@sackville/severity` qualitative base: the four common
 * buckets plus deps' own `'unknown'` (severity indeterminable). `'unknown'` is
 * DELIBERATELY distinct from the verdict scale's `'none'` — it maps to a `no-signal`
 * pillar, never to `low`/`none` (the absence-is-never-a-pass invariant).
 */
export type SeverityBucket = QualitativeSeverity | 'unknown'

export interface VulnerabilityMatch {
  id: string
  aliases: string[]
  summary?: string
  severity: SeverityBucket
  /** Versions a fix is available in (the `fixed` events of the matching SEMVER ranges), sorted. */
  fixedIn: string[]
}

/** Normalize a GHSA-style severity string to our fixed bucket. */
function severityBucket(value: string | undefined): SeverityBucket {
  switch (value?.toUpperCase()) {
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
      return 'high'
    case 'MODERATE':
    case 'MEDIUM':
      return 'moderate'
    case 'LOW':
      return 'low'
    default:
      return 'unknown'
  }
}

/** Map a CVSS base score to our bucket per the CVSS v3 qualitative rating scale.
 * `0.0` (None) has no bucket of ours, so it stays `unknown` rather than overstating. */
function severityFromScore(score: number): SeverityBucket {
  if (score >= 9.0) return 'critical'
  if (score >= 7.0) return 'high'
  if (score >= 4.0) return 'moderate'
  if (score >= 0.1) return 'low'
  return 'unknown'
}

/** Ordinal rank; higher = worse. Derived from the shared base so the four common
 * buckets can't drift from the verdict scale, with `unknown` as the zero sentinel. */
export const BUCKET_RANK: Record<SeverityBucket, number> = {
  ...QUALITATIVE_RANK,
  unknown: 0,
}

/**
 * Resolve a matched advisory's severity bucket. The qualitative GHSA string
 * (`database_specific.severity`, affected entry first then advisory) wins when present;
 * otherwise fall back to the highest bucket derivable from any CVSS v3 vector on the
 * matching affected entries or the advisory — so a vector-only advisory is no longer
 * reported as `unknown`.
 */
function resolveSeverity(advisory: OsvAdvisory, hit: OsvAffected[]): SeverityBucket {
  const qualitative = severityBucket(
    hit.find((a) => a.database_specific?.severity)?.database_specific?.severity ??
      advisory.database_specific?.severity,
  )
  if (qualitative !== 'unknown') return qualitative

  let best: SeverityBucket = 'unknown'
  for (const entry of [...hit.flatMap((a) => a.severity ?? []), ...(advisory.severity ?? [])]) {
    const score = cvssV3BaseScore(entry.score)
    if (score === undefined) continue
    const bucket = severityFromScore(score)
    if (BUCKET_RANK[bucket] > BUCKET_RANK[best]) best = bucket
  }
  return best
}

/**
 * Compare two range-event versions for sorting/evaluation, via the ecosystem comparator. The
 * OSV sentinel `"0"` (`introduced: "0"` = "from the beginning") sorts below every real version.
 */
function compareVersions(a: string, b: string, cmp: VersionComparator): number {
  if (a === b) return 0
  if (b === '0') return 1
  if (a === '0') return -1
  const ca = cmp.clean(a)
  const cb = cmp.clean(b)
  if (ca === null || cb === null) return 0
  return cmp.compare(ca, cb)
}

interface SortableEvent {
  version: string
  kind: 'introduced' | 'fixed' | 'last_affected'
}

function toSortableEvents(events: OsvEvent[]): SortableEvent[] {
  const out: SortableEvent[] = []
  for (const e of events) {
    if (e.introduced !== undefined) out.push({ version: e.introduced, kind: 'introduced' })
    else if (e.fixed !== undefined) out.push({ version: e.fixed, kind: 'fixed' })
    else if (e.last_affected !== undefined)
      out.push({ version: e.last_affected, kind: 'last_affected' })
  }
  return out
}

/** True if `version` falls within the affected window described by a range's events. */
function versionInRange(version: string, events: OsvEvent[], cmp: VersionComparator): boolean {
  const sorted = toSortableEvents(events).sort((x, y) => {
    const c = compareVersions(x.version, y.version, cmp)
    if (c !== 0) return c
    // At an equal version, an `introduced` is applied before a closing event.
    return x.kind === 'introduced' ? -1 : 1
  })

  let affected = false
  for (const event of sorted) {
    const c = compareVersions(version, event.version, cmp)
    if (event.kind === 'introduced') {
      if (c >= 0) affected = true
    } else if (event.kind === 'fixed') {
      if (c >= 0) affected = false
    } else if (c > 0) {
      affected = false
    }
  }
  return affected
}

/** True if `version` is affected by an `OsvAffected` entry (explicit versions or any SEMVER/ECOSYSTEM range). */
function affectedByEntry(version: string, affected: OsvAffected, cmp: VersionComparator): boolean {
  if (affected.versions?.includes(version)) return true
  for (const range of affected.ranges ?? []) {
    // GIT ranges are commit-based, not version-comparable here. SEMVER + ECOSYSTEM ranges
    // are evaluated with the injected ecosystem comparator (semver for npm, PEP 440 for PyPI, …).
    if (range.type === 'GIT') continue
    if (versionInRange(version, range.events, cmp)) return true
  }
  return false
}

function fixedVersions(affected: OsvAffected, cmp: VersionComparator): string[] {
  const fixes = new Set<string>()
  for (const range of affected.ranges ?? []) {
    if (range.type === 'GIT') continue
    for (const event of range.events) {
      if (event.fixed !== undefined) fixes.add(event.fixed)
    }
  }
  return [...fixes].sort((a, b) => compareVersions(a, b, cmp))
}

/**
 * Return the advisories from `advisories` that affect `installedVersion` of the given
 * package, as bucketed `VulnerabilityMatch`es. Only the `affected` entries whose
 * package ecosystem+name match are considered.
 */
export function matchVulnerabilities(
  advisories: OsvAdvisory[],
  pkg: { ecosystem: string; name: string },
  installedVersion: string,
  cmp: VersionComparator = semverComparator,
): VulnerabilityMatch[] {
  const matches: VulnerabilityMatch[] = []
  for (const advisory of advisories) {
    const relevant = advisory.affected.filter(
      (a) => a.package.ecosystem === pkg.ecosystem && a.package.name === pkg.name,
    )
    const hit = relevant.filter((a) => affectedByEntry(installedVersion, a, cmp))
    if (hit.length === 0) continue

    const severity = resolveSeverity(advisory, hit)
    const fixedIn = [...new Set(hit.flatMap((a) => fixedVersions(a, cmp)))].sort((a, b) =>
      compareVersions(a, b, cmp),
    )
    matches.push({
      id: advisory.id,
      aliases: advisory.aliases ?? [],
      summary: advisory.summary,
      severity,
      fixedIn,
    })
  }
  return matches
}
