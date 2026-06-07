/**
 * Changelog slicing — the pure core of the `changelog_diff` deps slice. Given a
 * package's CHANGELOG markdown and a version range, extract the sections that fall
 * between the installed version and an upgrade target, so an agent can see *what
 * actually changed* before recommending a bump (rather than "upgrade to latest").
 *
 * Pure and offline: fetching the changelog text (operator-gated, SSRF-pinned) and
 * returning the result by artifact handle live at the bin/MCP layer. Keeping the
 * parse/slice deterministic here is what lets the green gate stay deterministic.
 *
 * Changelogs are conventionally a list of version sections under ATX headings —
 * either Keep-a-Changelog style (`## [1.2.3] - 2021-01-01`) or a plain `## v1.2.3`.
 * We split on versioned headings (a heading carrying a valid semver), treat the
 * lines beneath one — including any non-versioned subsection headings like
 * `### Bug Fixes` — as that version's body, and select the versions in range.
 */

import { semverComparator, type VersionComparator } from './comparator.js'

export interface ChangelogEntry {
  version: string
  /** The section's markdown, including its heading line, trimmed. */
  body: string
}

export interface ChangelogSlice {
  from: string
  to?: string
  /** Sections for versions in `(from, to]` (or `> from` when `to` is omitted), newest first. */
  entries: ChangelogEntry[]
  /** Every versioned heading found in the changelog, newest first (diagnostics). */
  allVersions: string[]
}

export interface SliceOptions {
  /** The installed version — its section and everything older is excluded. */
  from: string
  /** The upgrade target (inclusive). Omit for an open upper bound (everything newer). */
  to?: string
  /**
   * The ecosystem version algebra (ADR 0010 addendum). Defaults to semver (npm); pass
   * {@link comparatorFor}'s PEP 440 / Gem comparator for PyPI / RubyGems so bounds and section
   * ordering are correct for those ecosystems. Heading DETECTION is also ecosystem-aware: when the
   * comparator supplies a `versionTokens` extractor (PyPI/RubyGems do), 2-segment (`1.0`),
   * letter-prerelease (`1.0rc1`), and Gem N-segment (`1.2.3.4`) headings are detected too — npm
   * keeps the strict 3-part semver token. The comparator drives from/to bounds + the dedupe/sort.
   */
  comparator?: VersionComparator
}

const HEADING = /^#{1,6}\s+(.*)$/
const SEMVER_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g

/**
 * Extract the first comparator-valid version token from a heading line, or null. Candidate tokens
 * come from the comparator's own ecosystem-aware extractor when it has one (PyPI/RubyGems surface
 * 2-segment / letter-prerelease / N-segment headings); npm and any comparator without one fall
 * back to the strict 3-part semver token. `isValid` is always the final authority.
 */
function headingVersion(headingText: string, comparator: VersionComparator): string | null {
  const tokens = comparator.versionTokens?.(headingText) ?? headingText.match(SEMVER_TOKEN) ?? []
  for (const token of tokens) {
    if (comparator.isValid(token)) return token
  }
  return null
}

/** Clean a caller-supplied version to a comparable string, throwing if hopeless. */
function requireVersion(value: string, label: string, comparator: VersionComparator): string {
  const v = comparator.clean(value)
  if (v === null) throw new Error(`${label} is not a parseable version: ${value}`)
  return v
}

interface RawEntry {
  version: string
  lines: string[]
}

/** Split the markdown into one raw entry per versioned heading (preamble dropped). */
function parseEntries(markdown: string, comparator: VersionComparator): RawEntry[] {
  const entries: RawEntry[] = []
  let current: RawEntry | undefined
  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line)
    const version = heading ? headingVersion(heading[1] ?? '', comparator) : null
    if (version !== null) {
      current = { version, lines: [line] }
      entries.push(current)
    } else if (current) {
      current.lines.push(line)
    }
    // Lines before the first versioned heading are preamble — ignored.
  }
  return entries
}

/**
 * Slice a changelog to the version sections in `(from, to]` (or `> from` when `to`
 * is omitted), newest first. `from`/`to` are cleaned via the (ecosystem) comparator; an
 * unparseable `from`/`to` throws (a slice with the wrong bound would silently mislead).
 */
export function sliceChangelog(markdown: string, opts: SliceOptions): ChangelogSlice {
  const comparator = opts.comparator ?? semverComparator
  const from = requireVersion(opts.from, 'from', comparator)
  const to = opts.to !== undefined ? requireVersion(opts.to, 'to', comparator) : undefined

  const raw = parseEntries(markdown, comparator)
  // Latest section wins if a version somehow appears twice (keep first seen by id).
  const seen = new Set<string>()
  const deduped: RawEntry[] = []
  for (const entry of raw) {
    if (seen.has(entry.version)) continue
    seen.add(entry.version)
    deduped.push(entry)
  }

  const sorted = [...deduped].sort((a, b) => -comparator.compare(a.version, b.version))
  const allVersions = sorted.map((e) => e.version)

  const entries: ChangelogEntry[] = sorted
    .filter(
      (e) => comparator.gt(e.version, from) && (to === undefined || comparator.lte(e.version, to)),
    )
    .map((e) => ({ version: e.version, body: e.lines.join('\n').trim() }))

  return { from, to, entries, allVersions }
}
