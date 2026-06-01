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

import semver from 'semver'

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
}

const HEADING = /^#{1,6}\s+(.*)$/
const SEMVER_TOKEN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g

/** Extract the first valid semver from a heading line, or null (dates/words ignored). */
function headingVersion(headingText: string): string | null {
  const tokens = headingText.match(SEMVER_TOKEN)
  if (!tokens) return null
  for (const token of tokens) {
    if (semver.valid(token) !== null) return token
  }
  return null
}

/** Coerce a caller-supplied version to comparable semver, throwing if hopeless. */
function requireVersion(value: string, label: string): string {
  const v = semver.valid(value) ?? semver.valid(semver.coerce(value) ?? '')
  if (v === null) throw new Error(`${label} is not a parseable version: ${value}`)
  return v
}

interface RawEntry {
  version: string
  lines: string[]
}

/** Split the markdown into one raw entry per versioned heading (preamble dropped). */
function parseEntries(markdown: string): RawEntry[] {
  const entries: RawEntry[] = []
  let current: RawEntry | undefined
  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line)
    const version = heading ? headingVersion(heading[1] ?? '') : null
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
 * is omitted), newest first. `from`/`to` are coerced to semver; an unparseable
 * `from`/`to` throws (a slice with the wrong bound would silently mislead).
 */
export function sliceChangelog(markdown: string, opts: SliceOptions): ChangelogSlice {
  const from = requireVersion(opts.from, 'from')
  const to = opts.to !== undefined ? requireVersion(opts.to, 'to') : undefined

  const raw = parseEntries(markdown)
  // Latest section wins if a version somehow appears twice (keep first seen by id).
  const seen = new Set<string>()
  const deduped: RawEntry[] = []
  for (const entry of raw) {
    if (seen.has(entry.version)) continue
    seen.add(entry.version)
    deduped.push(entry)
  }

  const sorted = [...deduped].sort((a, b) => semver.rcompare(a.version, b.version))
  const allVersions = sorted.map((e) => e.version)

  const entries: ChangelogEntry[] = sorted
    .filter((e) => semver.gt(e.version, from) && (to === undefined || semver.lte(e.version, to)))
    .map((e) => ({ version: e.version, body: e.lines.join('\n').trim() }))

  return { from, to, entries, allVersions }
}
