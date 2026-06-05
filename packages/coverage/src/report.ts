/**
 * Diff ↔ coverage integrator — joins the two pure halves of the forgotten-assertion
 * catch: {@link parseUnifiedDiff} (the lines a change added) and {@link uncoveredNewLines}
 * (which of a file's lines are covered/uncovered/non-executable). The result answers the
 * headline question — "of the lines this change introduced, which executable ones did no
 * test exercise" — across every file in the diff.
 *
 * The one real subtlety is **path reconciliation**: a unified diff names files
 * repo-relative (`packages/app/src/math.ts`), while a `coverage-final.json` is keyed by
 * **absolute** path (`/abs/repo/packages/app/src/math.ts`). With a `projectRoot` we match
 * exactly (`<root>/<diffPath>`); without one we fall back to a **unique** path-suffix
 * match and refuse to guess when more than one key matches (so a stray second checkout in
 * the coverage map can't cause a wrong attribution). Pure/offline.
 */

import { parseUnifiedDiff } from '@sackville/diff'
import { type FileCoverage, type UncoveredNewLines, uncoveredNewLines } from './uncovered.js'

export interface DiffCoverageFile {
  /** The diff (repo-relative) path. */
  path: string
  /** Whether a coverage entry was confidently matched. */
  found: boolean
  /** The matched absolute coverage key, when found. */
  coveragePath?: string
  /** New-side added line numbers from the diff. */
  addedLines: number[]
  /** The per-line classification, present only when coverage was found. */
  result?: UncoveredNewLines
}

export interface DiffCoverageReport {
  files: DiffCoverageFile[]
  /** Every executable-but-unhit new line across the diff — the headline finding. */
  uncovered: { path: string; line: number }[]
  summary: {
    covered: number
    uncovered: number
    nonExecutable: number
    /** Classified new lines (across files that had coverage). */
    total: number
    filesWithoutCoverage: number
  }
}

export interface UncoveredInDiffOptions {
  /** Absolute project root; when set, a diff path resolves to `<root>/<path>` exactly. */
  projectRoot?: string
}

/** Forward-slash + collapse repeated separators, for cross-platform path comparison. */
function norm(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
}

/**
 * Match a repo-relative diff path to a coverage key. Prefer an exact `<root>/<path>`
 * resolution; else require a single key ending in `/<path>` (refusing an ambiguous match).
 */
function matchCoverageKey(
  diffPath: string,
  keys: { norm: string; orig: string }[],
  projectRoot?: string,
): string | undefined {
  const p = norm(diffPath)
  if (projectRoot !== undefined) {
    const target = norm(`${projectRoot}/${p}`)
    const exactRoot = keys.find((k) => k.norm === target)
    if (exactRoot) return exactRoot.orig
  }
  const exact = keys.find((k) => k.norm === p)
  if (exact) return exact.orig
  const suffix = keys.filter((k) => k.norm.endsWith(`/${p}`))
  return suffix.length === 1 ? suffix[0]?.orig : undefined
}

/**
 * Report the coverage of a diff's added lines. Each diff file is matched to its coverage
 * entry and classified; files with no (or no confident) coverage match are returned with
 * `found:false` and counted in `summary.filesWithoutCoverage`.
 */
export function uncoveredInDiff(
  diff: string,
  coverage: Record<string, FileCoverage>,
  opts: UncoveredInDiffOptions = {},
): DiffCoverageReport {
  const keys = Object.keys(coverage).map((orig) => ({ orig, norm: norm(orig) }))
  const files: DiffCoverageFile[] = []
  const uncovered: { path: string; line: number }[] = []
  let covered = 0
  let uncov = 0
  let nonExecutable = 0
  let filesWithoutCoverage = 0

  for (const { path, addedLines } of parseUnifiedDiff(diff)) {
    const key = matchCoverageKey(path, keys, opts.projectRoot)
    if (key === undefined) {
      filesWithoutCoverage++
      files.push({ path, found: false, addedLines })
      continue
    }
    const result = uncoveredNewLines(coverage[key] as FileCoverage, addedLines)
    covered += result.summary.covered
    uncov += result.summary.uncovered
    nonExecutable += result.summary.nonExecutable
    for (const line of result.uncovered) uncovered.push({ path, line })
    files.push({ path, found: true, coveragePath: key, addedLines, result })
  }

  return {
    files,
    uncovered,
    summary: {
      covered,
      uncovered: uncov,
      nonExecutable,
      total: covered + uncov + nonExecutable,
      filesWithoutCoverage,
    },
  }
}
