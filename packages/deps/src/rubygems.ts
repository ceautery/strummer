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

/** Names from a Gemfile.lock `DEPENDENCIES` section (the declared top-level gems). */
function namesFromGemfileLock(lock: string): string[] {
  // The DEPENDENCIES block lists the gems the Gemfile declares (not the full resolved tree in
  // `specs:`); each is `  name (constraint)` or `  name!`. Capture until the next blank line.
  const block = /\nDEPENDENCIES\n([\s\S]*?)(?:\n\n|\n[A-Z]|$)/.exec(`\n${lock}`)?.[1]
  if (!block) return []
  const names: string[] = []
  for (const raw of block.split(/\r?\n/)) {
    const m = /^\s{2,}([A-Za-z0-9._-]+)/.exec(raw)
    if (m?.[1]) names.push(m[1])
  }
  return names
}

/** Names from a Gemfile's `gem "name"` declarations. */
function namesFromGemfile(gemfile: string): string[] {
  const names: string[] = []
  for (const m of gemfile.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) {
    if (m[1]) names.push(m[1])
  }
  return names
}

/**
 * Enumerate the declared top-level gem NAMES of a Ruby project (the RubyGems analogue of reading
 * npm `package.json` deps), deduped + sorted. Prefers the Gemfile.lock `DEPENDENCIES` section
 * (resolved declared gems); falls back to the Gemfile's `gem` lines. Pure.
 */
export function rubyManifestNames(sources: { gemfileLock?: string; gemfile?: string }): string[] {
  let raw: string[] = []
  if (sources.gemfileLock) raw = namesFromGemfileLock(sources.gemfileLock)
  if (raw.length === 0 && sources.gemfile) raw = namesFromGemfile(sources.gemfile)
  return [...new Set(raw)].sort()
}
