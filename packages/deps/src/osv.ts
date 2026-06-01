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
 * (https://ossf.github.io/osv-schema/): for a SEMVER range, sort the events
 * ascending by version (with the sentinel `introduced: "0"` first), then scan — an
 * `introduced` turns the affected state on at/after its version, a `fixed` turns it
 * off at/after its version (exclusive), and a `last_affected` turns it off strictly
 * after its version (inclusive). The final state decides membership.
 */

import semver from 'semver'

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
  database_specific?: { severity?: string }
}

/** A fixed, bucketed severity scale so output is stable across snapshots and source schemas. */
export type SeverityBucket = 'critical' | 'high' | 'moderate' | 'low' | 'unknown'

export interface VulnerabilityMatch {
  id: string
  aliases: string[]
  summary?: string
  severity: SeverityBucket
  /** Versions a fix is available in (the `fixed` events of the matching SEMVER ranges), sorted. */
  fixedIn: string[]
}

/** Normalize a GHSA-style severity string to our fixed bucket. CVSS-vector scoring is a later slice. */
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

/** Coerce an arbitrary version-ish string into a comparable semver, or null if hopeless. */
function clean(version: string): string | null {
  return semver.valid(version) ?? semver.coerce(version)?.version ?? null
}

/**
 * Compare two range-event versions for sorting/evaluation. The OSV sentinel `"0"`
 * (`introduced: "0"` = "from the beginning") sorts below every real version.
 */
function compareVersions(a: string, b: string): number {
  if (a === b) return 0
  if (b === '0') return 1
  if (a === '0') return -1
  const ca = clean(a)
  const cb = clean(b)
  if (ca === null || cb === null) return 0
  return semver.compare(ca, cb)
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

/** True if `version` falls within the affected window described by a SEMVER range's events. */
function versionInRange(version: string, events: OsvEvent[]): boolean {
  const sorted = toSortableEvents(events).sort((x, y) => {
    const c = compareVersions(x.version, y.version)
    if (c !== 0) return c
    // At an equal version, an `introduced` is applied before a closing event.
    return x.kind === 'introduced' ? -1 : 1
  })

  let affected = false
  for (const event of sorted) {
    const c = compareVersions(version, event.version)
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
function affectedByEntry(version: string, affected: OsvAffected): boolean {
  if (affected.versions?.includes(version)) return true
  for (const range of affected.ranges ?? []) {
    // GIT ranges are commit-based, not version-comparable here. npm's ECOSYSTEM
    // ranges are semver, so they evaluate the same as SEMVER.
    if (range.type === 'GIT') continue
    if (versionInRange(version, range.events)) return true
  }
  return false
}

function fixedVersions(affected: OsvAffected): string[] {
  const fixes = new Set<string>()
  for (const range of affected.ranges ?? []) {
    if (range.type === 'GIT') continue
    for (const event of range.events) {
      if (event.fixed !== undefined) fixes.add(event.fixed)
    }
  }
  return [...fixes].sort((a, b) => compareVersions(a, b))
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
): VulnerabilityMatch[] {
  const matches: VulnerabilityMatch[] = []
  for (const advisory of advisories) {
    const relevant = advisory.affected.filter(
      (a) => a.package.ecosystem === pkg.ecosystem && a.package.name === pkg.name,
    )
    const hit = relevant.filter((a) => affectedByEntry(installedVersion, a))
    if (hit.length === 0) continue

    const severity = severityBucket(
      hit.find((a) => a.database_specific?.severity)?.database_specific?.severity ??
        advisory.database_specific?.severity,
    )
    const fixedIn = [...new Set(hit.flatMap(fixedVersions))].sort((a, b) => compareVersions(a, b))
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
