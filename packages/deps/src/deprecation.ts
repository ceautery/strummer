/**
 * Deprecation audit — the first, fully-offline slice of the dependency-intelligence
 * pillar. Given an npm "packument" (the JSON the registry returns for a package) and
 * the version actually installed in the target project, decide whether that version
 * is deprecated and at what scope.
 *
 * This is a pure reducer over already-fetched data: no network, no subprocess. Live
 * fetching of the packument (SSRF-pinned, operator-gated) is a later slice; keeping
 * the verdict logic pure here is what lets the green gate stay deterministic.
 */

/** One version entry inside a packument's `versions` map. */
export interface PackumentVersion {
  version: string
  /**
   * npm marks a *specific version* deprecated by setting this string on the version
   * entry. An empty string is npm's idiom for "un-deprecated", so it does not count.
   */
  deprecated?: string
  [key: string]: unknown
}

/** The (abbreviated) npm packument shape we read. */
export interface Packument {
  name: string
  /** A package-wide deprecation message (npm surfaces this when, e.g., the whole package is sunset). */
  deprecated?: string
  'dist-tags'?: Record<string, string>
  versions: Record<string, PackumentVersion>
  [key: string]: unknown
}

/**
 * `version` — the installed version itself carries a deprecation message.
 * `package` — the package as a whole is deprecated (the installed version has none
 * of its own, but the package-level message still applies).
 */
export type DeprecationScope = 'version' | 'package'

export type DeprecationVerdict =
  | { isDeprecated: false }
  | { isDeprecated: true; message: string; scope: DeprecationScope }

/** A `deprecated` field only counts if it is a non-empty, non-whitespace string. */
function deprecationMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Audit whether `installedVersion` of the package described by `packument` is
 * deprecated. A version-scoped deprecation is more specific than a package-scoped
 * one, so it wins when both are present.
 */
export function auditDeprecation(
  packument: Packument,
  installedVersion: string,
): DeprecationVerdict {
  const versionEntry = packument.versions[installedVersion]
  const versionMessage = deprecationMessage(versionEntry?.deprecated)
  if (versionMessage !== undefined) {
    return { isDeprecated: true, message: versionMessage, scope: 'version' }
  }

  const packageMessage = deprecationMessage(packument.deprecated)
  if (packageMessage !== undefined) {
    return { isDeprecated: true, message: packageMessage, scope: 'package' }
  }

  return { isDeprecated: false }
}
