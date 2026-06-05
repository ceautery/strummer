/**
 * Unified-diff parsing — the shared changed-set primitive. Given a unified diff
 * (`git diff` / `diff -u` output), two pure derivations:
 *
 * - {@link parseUnifiedDiff} — the set of lines each file *gained* on the new side
 *   (feeds the coverage pillar's forgotten-assertion catch: "of the lines this change
 *   introduced, which executable ones were never hit by a test").
 * - {@link changedFiles} — the set of non-deleted files a change touched (the scope
 *   primitive: which tests to re-run, which files to mutate, which packages to audit).
 *
 * Pure and offline: producing the diff (shelling out to `git`) and matching its
 * repo-relative paths to absolute keys / package manifests are caller concerns.
 * Keeping the parse pure is what lets every consuming gate stay deterministic — and
 * what lets `@sackville/verify` runtime-import this without dragging in a pillar's
 * spawn-capable code (this package has zero dependencies).
 *
 * The parser is a state machine that tracks each hunk's declared line counts (from its
 * `@@ -a,b +c,d @@` header) and ends the hunk exactly when those are consumed. That is
 * what lets it tell a file header (`--- `/`+++ `) apart from a removed/added line whose
 * *content* starts with `-`/`+` (e.g. `--- foo`): inside a live hunk every line is body,
 * classified by its first character; once the counts are exhausted, the next `--- `/
 * `+++ ` is a header again — so it is correct even for prefix-less multi-file diffs.
 */

export interface DiffFile {
  /** New-side path, `a/`/`b/` prefix stripped (repo-relative as git emits it). */
  path: string
  /** Added (new-side) line numbers, sorted ascending, deduped. */
  addedLines: number[]
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Strip a leading `a/` or `b/` prefix and any trailing tab-timestamp (POSIX diff). */
function cleanPath(raw: string): string {
  const path = raw.split('\t')[0] ?? raw
  return path.replace(/^[ab]\//, '')
}

/**
 * Parse a unified diff into per-file added-line sets. Files with no new-side lines
 * (pure deletions, or a `+++ /dev/null` target) are omitted. Result is sorted by path.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const added = new Map<string, Set<number>>()
  let currentFile: string | null = null
  let newLine = 0
  let remainingOld = 0
  let remainingNew = 0
  const inHunk = () => remainingOld > 0 || remainingNew > 0

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    // A new file header / hunk header always delimits, even mid-hunk.
    if (line.startsWith('diff --git')) {
      remainingOld = 0
      remainingNew = 0
      currentFile = null
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk) {
      newLine = Number(hunk[2])
      remainingOld = hunk[1] === undefined ? 1 : Number(hunk[1])
      remainingNew = hunk[3] === undefined ? 1 : Number(hunk[3])
      continue
    }

    if (inHunk()) {
      const marker = line[0]
      if (marker === '+') {
        if (currentFile !== null) {
          let set = added.get(currentFile)
          if (set === undefined) {
            set = new Set()
            added.set(currentFile, set)
          }
          set.add(newLine)
        }
        newLine++
        remainingNew--
      } else if (marker === '-') {
        remainingOld--
      } else if (marker === '\\') {
        // "\ No newline at end of file" — annotates the previous line, counts for neither.
      } else {
        // Context line (' ' prefix, or a trailing-space-stripped blank).
        newLine++
        remainingNew--
        remainingOld--
      }
      continue
    }

    // Outside a hunk: file headers (the `+++` new-side path drives `currentFile`).
    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4))
      currentFile = path === '/dev/null' ? null : path
    }
    // `--- ` (old-side) and other header lines (index, mode, …) need no action.
  }

  return [...added.entries()]
    .map(([path, set]) => ({ path, addedLines: [...set].sort((a, b) => a - b) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * The new-side paths a change touched, deduped and sorted — the scope primitive.
 *
 * Distinct from {@link parseUnifiedDiff}, which omits any file that did not *gain*
 * a line: `changedFiles` also includes a file that was modified by removals only
 * (its tests should still re-run). It excludes a deleted file (`+++ /dev/null`) —
 * a gone file is not a test/mutation/audit target. New files are included.
 *
 * Uses the same hunk state machine so a body line beginning with `+++ ` is never
 * mistaken for a file header.
 */
export function changedFiles(diff: string): string[] {
  const files = new Set<string>()
  let remainingOld = 0
  let remainingNew = 0
  const inHunk = () => remainingOld > 0 || remainingNew > 0

  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    if (line.startsWith('diff --git')) {
      remainingOld = 0
      remainingNew = 0
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk) {
      remainingOld = hunk[1] === undefined ? 1 : Number(hunk[1])
      remainingNew = hunk[3] === undefined ? 1 : Number(hunk[3])
      continue
    }

    if (inHunk()) {
      const marker = line[0]
      if (marker === '+') {
        remainingNew--
      } else if (marker === '-') {
        remainingOld--
      } else if (marker === '\\') {
        // no-op
      } else {
        remainingNew--
        remainingOld--
      }
      continue
    }

    if (line.startsWith('+++ ')) {
      const path = cleanPath(line.slice(4))
      if (path !== '/dev/null') files.add(path)
    }
  }

  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
