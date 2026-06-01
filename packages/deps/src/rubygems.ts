/**
 * RubyGems registry adaptation (ADR 0012). Maps the RubyGems API versions response
 * (`/api/v1/versions/<name>.json` → an array of `{number, prerelease, ...}`) into the internal
 * {@link Packument} shape the freshness core consumes. Yanked versions are already omitted from
 * that array by the API. RubyGems has no npm-style per-version deprecation, so `deprecated` is
 * absent (no false signal), and no `dist-tags.latest` is set — the freshness core re-derives the
 * newest stable with `gemComparator` (filtering pre-releases via `Gem::Version` semantics).
 *
 * Gem names are case-sensitive and not normalized (unlike PyPI/PEP 503), so OSV matching uses
 * the name as-is. The HTTP fetch is injected at the bin layer; this module is pure.
 */

import type { Packument, PackumentVersion } from './deprecation.js'

/** One entry in the RubyGems versions array (only `number` is read for the Packument). */
export interface RubyGemsVersion {
  number: string
  prerelease?: boolean
}

/** Map a RubyGems versions array into a {@link Packument}. */
export function rubygemsToPackument(name: string, versions: RubyGemsVersion[]): Packument {
  const out: Record<string, PackumentVersion> = {}
  for (const v of versions) {
    if (typeof v.number === 'string') out[v.number] = { version: v.number }
  }
  return { name, versions: out }
}
