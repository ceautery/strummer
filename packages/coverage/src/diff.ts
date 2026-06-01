/**
 * Unified-diff parsing — the input half of the coverage pillar's forgotten-assertion
 * catch. Given a unified diff (`git diff` / `diff -u` output), extract the set of lines
 * each file *gained* on the new side, so {@link uncoveredNewLines} can be asked "of the
 * lines this change introduced, which executable ones were never hit by a test".
 *
 * Pure and offline: producing the diff (shelling out to `git`) and matching its
 * repo-relative paths to the absolute keys in a `coverage-final.json` are bin-layer
 * concerns. Keeping the parse pure is what lets the green gate stay deterministic.
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
