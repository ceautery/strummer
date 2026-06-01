/**
 * `auditDependency` — the agent-facing roll-up. It composes the three pure pieces of
 * the pillar (deprecation, OSV vulnerability matching, freshness) into one compact
 * verdict about the version of a package that is *actually installed*.
 *
 * Like the rest of the pillar's core it is pure: the caller gathers the inputs (detect
 * the installed version from the project via `@strummer/core`'s
 * `detectInstalledVersion`, load advisories via `loadOsvSnapshot`, fetch the
 * packument) and `auditDependency` reduces them. This keeps it deterministic and
 * trivially testable; the I/O + operator gating live at the bin/MCP layer.
 */

import semver from 'semver'
import { auditDeprecation, type DeprecationVerdict, type Packument } from './deprecation.js'
import {
  matchVulnerabilities,
  type OsvAdvisory,
  type SeverityBucket,
  type VulnerabilityMatch,
} from './osv.js'

export interface FreshnessVerdict {
  installed: string
  /** The `dist-tags.latest` (or the newest stable release if that tag is absent). */
  latest?: string
  /** The newest stable release sharing the installed version's major. */
  latestSameMajor?: string
  /** True when a newer `latest` exists than the installed version. */
  isOutdated: boolean
}

export interface DependencyAudit {
  package: string
  ecosystem: string
  installedVersion: string
  deprecated: DeprecationVerdict
  vulnerabilities: VulnerabilityMatch[]
  /** The highest severity among matched vulnerabilities, or `'none'`. */
  worstSeverity: SeverityBucket | 'none'
  freshness: FreshnessVerdict
  /**
   * The conservative upgrade target: the newest same-major release, when it is newer
   * than installed (avoids recommending a blind major bump). For security upgrades,
   * consult each vulnerability's `fixedIn`.
   */
  recommendedTarget?: string
  /** Staleness proxy carried through from the OSV snapshot the advisories came from. */
  snapshotDate?: string
  /** True if anything actionable was found (deprecated or any matched vulnerability). */
  hasFindings: boolean
}

export interface AuditDependencyInput {
  packageName: string
  /** OSV ecosystem name, e.g. `'npm'` / `'PyPI'`. */
  ecosystem: string
  installedVersion: string
  packument: Packument
  advisories?: OsvAdvisory[]
  snapshotDate?: string
}

const SEVERITY_RANK: Record<SeverityBucket, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
  unknown: 0,
}

/** Stable (non-prerelease), valid-semver version strings present in the packument. */
function stableVersions(packument: Packument): string[] {
  return Object.keys(packument.versions).filter(
    (v) => semver.valid(v) !== null && semver.prerelease(v) === null,
  )
}

function maxVersion(versions: string[]): string | undefined {
  return versions.reduce<string | undefined>(
    (best, v) => (best === undefined || semver.gt(v, best) ? v : best),
    undefined,
  )
}

function computeFreshness(installed: string, packument: Packument): FreshnessVerdict {
  const stable = stableVersions(packument)
  const tagged = packument['dist-tags']?.latest
  const latest = tagged !== undefined && semver.valid(tagged) !== null ? tagged : maxVersion(stable)

  let latestSameMajor: string | undefined
  if (semver.valid(installed) !== null) {
    const major = semver.major(installed)
    latestSameMajor = maxVersion(stable.filter((v) => semver.major(v) === major))
  }

  const isOutdated =
    semver.valid(installed) !== null &&
    latest !== undefined &&
    semver.valid(latest) !== null &&
    semver.lt(installed, latest)

  return { installed, latest, latestSameMajor, isOutdated }
}

function worstOf(vulnerabilities: VulnerabilityMatch[]): SeverityBucket | 'none' {
  if (vulnerabilities.length === 0) return 'none'
  return vulnerabilities.reduce<SeverityBucket>(
    (worst, v) => (SEVERITY_RANK[v.severity] > SEVERITY_RANK[worst] ? v.severity : worst),
    'unknown',
  )
}

/** Compose deprecation, vulnerability, and freshness signals into one dependency verdict. */
export function auditDependency(input: AuditDependencyInput): DependencyAudit {
  const {
    packageName,
    ecosystem,
    installedVersion,
    packument,
    advisories = [],
    snapshotDate,
  } = input

  const deprecated = auditDeprecation(packument, installedVersion)
  const vulnerabilities = matchVulnerabilities(
    advisories,
    { ecosystem, name: packageName },
    installedVersion,
  )
  const freshness = computeFreshness(installedVersion, packument)

  const recommendedTarget =
    freshness.latestSameMajor !== undefined &&
    semver.valid(installedVersion) !== null &&
    semver.gt(freshness.latestSameMajor, installedVersion)
      ? freshness.latestSameMajor
      : undefined

  return {
    package: packageName,
    ecosystem,
    installedVersion,
    deprecated,
    vulnerabilities,
    worstSeverity: worstOf(vulnerabilities),
    freshness,
    recommendedTarget,
    snapshotDate,
    hasFindings: deprecated.isDeprecated || vulnerabilities.length > 0,
  }
}
