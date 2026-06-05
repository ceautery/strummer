/**
 * Pure scope-selection + post-spawn reconciliation primitives for Python mutation diff-scoping
 * (ADR 0010 addendum 2). The config EMITTERS (cosmic-ray TOML / mutmut pyproject) and the runner
 * wiring are STAGED pending slice-0 tool-fact capture; these two functions are the load-bearing,
 * tool-agnostic SAFETY core and ship first (pure, fixture-tested, no real tool in `pnpm gate`):
 *
 * - {@link selectMutationScope} mirrors coverage's `selectPytestScope` (incl. its INJECTED
 *   existence predicate): turn the changed-file list into the set of mutable, existing, in-tree
 *   `.py` files to scope a mutation run to, surfacing everything else as `unmatched` (report-gap;
 *   never silently folded into the scope).
 * - {@link reconcileScope} is the POST-SPAWN partial-under-scope guard (the design's load-bearing
 *   correction): the existing `assertComplete` only catches TOTAL-zero mutants, so it is blind to
 *   a run that mutated only a SUBSET of the selected files — a clean score for files that were
 *   never mutated, i.e. absence-as-a-pass. reconcileScope reports which selected files the tool
 *   actually mutated and which it NEVER SAW; the (staged) runner throws ⇒ inconclusive on any
 *   never-seen selected file.
 */

import type { MutationSummary } from './summarize.js'

/** Normalize a path to a comparable repo-relative POSIX form (backslashes → `/`, drop a leading `./`). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

export interface MutationScope {
  /** Mutable, existing, in-tree `.py` files to scope the run to (repo-relative, normalized, deduped, sorted). */
  files: string[]
  /** Changed `.py` files that are out-of-tree, deleted, or otherwise unplaceable — surfaced as a
   * gap (report-gap), NEVER silently folded into `files` (that would be absence-as-a-pass). */
  unmatched: string[]
}

/**
 * Derive the mutation scope from the changed files. A changed file is selected only when it is a
 * `.py` file, lives under one of the operator's `ownedRoots`, AND exists on disk (`exists`,
 * injected — FS by default in the runner, faked in tests, mirroring `selectPytestScope`'s
 * `testExists`). A `.py` file that is out-of-tree or non-existent (deleted/renamed/typo) is
 * `unmatched`, never scoped. Non-`.py` files are irrelevant to mutation and dropped. Pure given
 * `exists`. Whole-project fallback is NOT decided here — it is the caller's (`mutateFiles ===
 * undefined`) or the cosmic-ray emitter's (`no-scope` on the base config) concern.
 */
export function selectMutationScope(
  mutateFiles: string[],
  ownedRoots: string[],
  exists: (path: string) => boolean,
): MutationScope {
  const roots = ownedRoots.map(normalizePath)
  const underRoot = (p: string): boolean => roots.some((r) => p === r || p.startsWith(`${r}/`))
  const files = new Set<string>()
  const unmatched = new Set<string>()
  for (const raw of mutateFiles) {
    const p = normalizePath(raw)
    if (!p.endsWith('.py')) continue // not a Python source file — irrelevant to mutation
    if (!underRoot(p) || !exists(p)) {
      unmatched.add(p) // out-of-tree, deleted, renamed, or typo'd — a gap, never scoped
      continue
    }
    files.add(p)
  }
  return { files: [...files].sort(), unmatched: [...unmatched].sort() }
}

export interface ScopeReconciliation {
  /** Selected files the tool ACTUALLY mutated (≥1 mutant) — report this as the run's true scope,
   * never the merely-requested set. */
  mutatedFiles: string[]
  /** Selected files the tool NEVER SAW (absent from the per-file summary) — partial under-scope.
   * A non-empty `missing` MUST make the run inconclusive (absence-as-a-pass otherwise). */
  missing: string[]
}

/**
 * Post-spawn partial-under-scope guard. Given the files the run was SELECTED to mutate and the
 * tool's {@link MutationSummary} (whose `files[]` carries a per-file record for every file the
 * tool SAW — even one it found no mutants in), determine which selected files were genuinely
 * mutated and which the tool never saw at all. A selected file present in the summary with zero
 * mutants is SEEN-BUT-EMPTY (benign — no mutable code); a selected file ABSENT from the summary
 * was never mutated (the partial-scope sentinel) and goes in `missing`. Paths are normalized on
 * both sides before comparison. Pure.
 */
export function reconcileScope(selected: string[], summary: MutationSummary): ScopeReconciliation {
  const seen = new Set(summary.files.map((f) => normalizePath(f.path)))
  const mutated = new Set(
    summary.files.filter((f) => f.metrics.totalMutants > 0).map((f) => normalizePath(f.path)),
  )
  const sel = [...new Set(selected.map(normalizePath))].sort()
  return {
    mutatedFiles: sel.filter((p) => mutated.has(p)),
    missing: sel.filter((p) => !seen.has(p)),
  }
}
