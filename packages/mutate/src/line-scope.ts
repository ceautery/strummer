/**
 * Line-precise mutation scope — the pure, diff-driven narrowing that mirrors cosmic-ray's own
 * `cr-filter-git` (a built-in filter that marks SKIPPED any mutation whose `[start..end]` line
 * range misses the git-changed lines), but driven by Sackville's SUPPLIED unified diff rather
 * than the working-tree git state — so it stays consistent with every other pillar's diff-scoping
 * (`@sackville-mcp/diff`'s `parseUnifiedDiff`) and never couples a result to which branch is
 * checked out.
 *
 * It is a REPORTING refinement, not an execution one: cosmic-ray still mutates the whole scoped
 * file: line precision here sharpens the surfaced survivors/score to the lines the change actually
 * touched, so a surviving mutant on an UNCHANGED line of a touched file is not attributed to this
 * diff. (The completeness/under-scope guards in {@link runCosmicRay} run on the FULL report, before
 * this filter — line-filtering can never resurrect a swallowed-tool inconclusive into a pass.)
 *
 * Pure. Takes a pre-built per-file changed-line map so this leaf carries no `@sackville-mcp/diff`
 * dependency; the surface builds the map from `parseUnifiedDiff` output via {@link changedLinesByFile}.
 */

import { parseUnifiedDiff } from '@sackville-mcp/diff'
import type { MutationReport } from './summarize.js'

/** Per-file changed (added) line numbers — the line map a diff-scoped mutation report is narrowed to. */
export type ChangedLines = ReadonlyMap<string, ReadonlySet<number>>

/** Build a {@link ChangedLines} map directly from a unified diff (the surface convenience). */
export function changedLinesFromDiff(diff: string): ChangedLines {
  return changedLinesByFile(parseUnifiedDiff(diff))
}

/** Build a {@link ChangedLines} map from `parseUnifiedDiff`-shaped entries (the pure core — no diff dep). */
export function changedLinesByFile(
  diffFiles: readonly { path: string; addedLines: readonly number[] }[],
): ChangedLines {
  const map = new Map<string, Set<number>>()
  for (const { path, addedLines } of diffFiles) {
    let set = map.get(path)
    if (set === undefined) {
      set = new Set()
      map.set(path, set)
    }
    for (const line of addedLines) set.add(line)
  }
  return map
}

/** True when the mutant's `[start.line..end.line]` span intersects `changed` (end defaults to start). */
function spanHitsChanged(
  location: NonNullable<MutationReport['files'][string]['mutants'][number]['location']> | undefined,
  changed: ReadonlySet<number>,
): boolean {
  if (!location) return false // unplaceable ⇒ cannot prove it is on a changed line ⇒ drop (never inflate)
  const start = location.start.line
  const end = location.end?.line ?? start
  for (let line = start; line <= end; line++) {
    if (changed.has(line)) return true
  }
  return false
}

/**
 * Narrow a mutation report to only mutants whose source span hits a changed line of their file.
 * A file absent from `changedLines` is dropped wholesale; a file left with no in-scope mutant is
 * omitted (so the re-summarized report counts only changed-line mutants). Pure.
 */
export function filterToChangedLines(
  report: MutationReport,
  changedLines: ChangedLines,
): MutationReport {
  const files: MutationReport['files'] = {}
  for (const [path, file] of Object.entries(report.files)) {
    const changed = changedLines.get(path)
    if (changed === undefined || changed.size === 0) continue
    const mutants = file.mutants.filter((m) => spanHitsChanged(m.location, changed))
    if (mutants.length === 0) continue
    files[path] = { ...file, mutants }
  }
  return { ...report, files }
}
