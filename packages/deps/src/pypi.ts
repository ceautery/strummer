/**
 * PyPI registry adaptation (ADR 0012). Two pure pieces the PyPI audit path needs:
 *
 *   - {@link normalizePypiName}: PEP 503 name normalization (lowercase, runs of `-_.` → `-`).
 *     OSV stores PyPI advisory package names in this normalized form, so the queried name must
 *     be normalized before matching. (It is identical to `@strummer/core`'s internal `canonPy`,
 *     which already normalizes for version *detection* — repeated here so the OSV-matching name
 *     is normalized without a core dependency.)
 *   - {@link pypiJsonToPackument}: map the PyPI JSON API (`/pypi/<project>/json`) response into
 *     the internal {@link Packument} shape the freshness core consumes. PyPI has no npm-style
 *     per-version deprecation, so `deprecated` is simply absent (no false signal).
 *
 * The actual HTTP fetch is injected at the bin layer (SSRF-pinned, network-gated); this module
 * is pure so it stays offline/deterministic in the gate.
 */

import type { Packument, PackumentVersion } from './deprecation.js'

/** Normalize a PyPI project name per PEP 503. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/** One file record under a release in the PyPI JSON API (only `yanked` is read). */
export interface PyPiReleaseFile {
  yanked?: boolean
}

/** The subset of the PyPI JSON API response we read. */
export interface PyPiJson {
  info?: { name?: string; version?: string }
  /** version string → its uploaded files (empty when a version has no upload). */
  releases?: Record<string, PyPiReleaseFile[]>
}

/**
 * Map a PyPI JSON API response into a {@link Packument}. A release is kept only when it has at
 * least one non-yanked file (a fully-yanked or upload-less version is not installable, so it
 * must not become `latest` or an upgrade candidate). `dist-tags.latest` is PyPI's own
 * `info.version`; freshness still re-derives the newest stable with the PEP 440 comparator.
 */
export function pypiJsonToPackument(json: PyPiJson): Packument {
  const versions: Record<string, PackumentVersion> = {}
  for (const [version, files] of Object.entries(json.releases ?? {})) {
    if (!files.some((f) => !f.yanked)) continue
    versions[version] = { version }
  }
  const packument: Packument = { name: json.info?.name ?? '', versions }
  const latest = json.info?.version
  if (latest !== undefined) packument['dist-tags'] = { latest }
  return packument
}
