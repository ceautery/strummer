/**
 * Diff-scoping config EMITTERS for the Python mutation tools (ADR 0010 addendum 2). These turn a
 * selected-file scope into a per-run tool config, PINNED to the slice-0 captures of the installed
 * cosmic-ray 8.4.6 / mutmut 3.5.0 (see `test/fixtures/README.md`) — never doc-derived guesses:
 *
 * - cosmic-ray scopes via a `module-path` FILE LIST (Fork A — verified 8.4.6 accepts a list); its
 *   `excluded-modules` SUBTRACTS from the scope via exact path AND fnmatch glob, so an inherited
 *   exclusion that matches a selected file is reconciled (stripped), never copied blind (blocker #3).
 * - mutmut scopes via `paths_to_mutate` (Fork B was WRONG — 3.5.0 has NO `only_mutate`/`source_paths`;
 *   `paths_to_mutate` + `do_not_mutate` are the real keys, Fork F). Scoping a subset breaks the
 *   baseline unless the rest of the source tree is `also_copy`'d so unscoped tests still import; an
 *   inherited `do_not_mutate` glob matching a selected file is stripped (blocker #3, mutmut form).
 *
 * Both emitters are PURE (TOML in → TOML out via `smol-toml`). They reduce SPURIOUS inconclusives by
 * reconciling exclusions up front; the load-bearing under-scope guarantee is the POST-SPAWN
 * {@link reconcileScope} guard in the runner, which folds any genuinely-unmutated selected file to
 * inconclusive regardless of why (absence-is-never-a-pass).
 */

import { parse, stringify } from 'smol-toml'

/** Thrown when a scoped config cannot be safely synthesized (empty scope, missing base table, etc.). */
export class ScopeEmitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeEmitError'
  }
}

/** Normalize a path to a comparable repo-relative POSIX form (backslashes → `/`, drop a leading `./`). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Dedupe + normalize + sort, the canonical scope form used everywhere. */
function canonicalize(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath))].sort()
}

/**
 * Translate a Python `fnmatch` pattern to an anchored RegExp. Mirrors `fnmatch.translate`: a star →
 * `.*` (crosses `/`, unlike shell glob — so a `star + /strutil.py` glob matches `pkg/strutil.py`),
 * `?` → any one char, `[seq]`/`[!seq]` → char class, everything else escaped. This is the matcher
 * cosmic-ray's `excluded-modules` and mutmut's `do_not_mutate` both use (the latter via
 * `fnmatch.fnmatch` in `Config.should_ignore_for_mutation`).
 */
function fnmatchToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const c = pattern[i++]
    if (c === '*') {
      re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '[') {
      let j = i
      if (j < n && (pattern[j] === '!' || pattern[j] === ']')) j++
      while (j < n && pattern[j] !== ']') j++
      if (j >= n) {
        re += '\\[' // unterminated class → literal '['
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, '\\\\')
        i = j + 1
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`
        else if (stuff.startsWith('^')) stuff = `\\${stuff}`
        re += `[${stuff}]`
      }
    } else {
      re += (c ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^(?:${re})$`, 's')
}

/** True if an exclusion entry (exact path or fnmatch glob) matches any of the selected files. */
function exclusionCollides(entry: string, selected: string[]): boolean {
  const norm = normalizePath(entry)
  if (selected.includes(norm)) return true // exact path
  const re = fnmatchToRegExp(norm)
  return selected.some((f) => re.test(f))
}

export interface ScopedCosmicRayConfig {
  /** The synthesized per-run `cosmic-ray.toml` text. */
  toml: string
  /** The selected file list written to `module-path` (canonical form). */
  modulePath: string[]
  /** Inherited `excluded-modules` entries removed because they would subtract a selected file. */
  strippedExclusions: string[]
}

/**
 * Synthesize a per-run cosmic-ray config from a base config + the selected files. Overrides
 * `module-path` to the canonical selected FILE LIST and reconciles `excluded-modules`: any entry
 * (exact or fnmatch glob) that matches a selected file is stripped (it would otherwise silently
 * subtract that file — blocker #3); non-colliding entries are preserved. All other keys/tables
 * (`timeout`, `test-command`, `[cosmic-ray.distributor]`, …) are preserved verbatim. Pure.
 */
export function synthesizeScopedCosmicRayConfig(
  baseToml: string,
  selectedFiles: string[],
): ScopedCosmicRayConfig {
  const selected = canonicalize(selectedFiles)
  if (selected.length === 0) {
    throw new ScopeEmitError('cannot synthesize a scoped cosmic-ray config for an empty selection')
  }
  const data = parse(baseToml) as Record<string, unknown>
  const cr = data['cosmic-ray']
  if (cr === undefined || typeof cr !== 'object') {
    throw new ScopeEmitError('base config has no [cosmic-ray] table')
  }
  const table = cr as Record<string, unknown>
  table['module-path'] = selected

  const strippedExclusions: string[] = []
  const inherited = Array.isArray(table['excluded-modules'])
    ? (table['excluded-modules'] as unknown[]).map(String)
    : []
  const kept = inherited.filter((entry) => {
    if (exclusionCollides(entry, selected)) {
      strippedExclusions.push(entry)
      return false
    }
    return true
  })
  table['excluded-modules'] = kept

  return { toml: stringify(data), modulePath: selected, strippedExclusions }
}

export interface MutmutScopePlan {
  /** The selected files written to `paths_to_mutate` (canonical form). */
  pathsToMutate: string[]
  /** Sibling source files to `also_copy` so unscoped tests still import (source tree minus scope). */
  alsoCopy: string[]
  /** Inherited `do_not_mutate` globs preserved (those that do NOT collide with the scope). */
  doNotMutate: string[]
  /** Inherited `do_not_mutate` globs removed because they would exclude a selected file (blocker #3). */
  strippedDoNotMutate: string[]
}

/**
 * Plan a scoped mutmut run. `paths_to_mutate` = the selected files; `also_copy` = every other source
 * file in `allSourceFiles` (so a test importing an unscoped sibling module still resolves in mutmut's
 * `mutants/` sandbox — verified necessary in slice 0). An inherited `do_not_mutate` glob that matches
 * a selected file is stripped (it would otherwise exclude a file we deliberately scoped). Pure given
 * `allSourceFiles` (the runner derives it by walking the owned roots).
 */
export function planMutmutScope(
  selectedFiles: string[],
  allSourceFiles: string[],
  inheritedDoNotMutate: string[] = [],
): MutmutScopePlan {
  const pathsToMutate = canonicalize(selectedFiles)
  if (pathsToMutate.length === 0) {
    throw new ScopeEmitError('cannot plan a scoped mutmut run for an empty selection')
  }
  const scope = new Set(pathsToMutate)
  const alsoCopy = canonicalize(allSourceFiles).filter((f) => !scope.has(f))

  const strippedDoNotMutate: string[] = []
  const doNotMutate = inheritedDoNotMutate.filter((entry) => {
    if (exclusionCollides(entry, pathsToMutate)) {
      strippedDoNotMutate.push(entry)
      return false
    }
    return true
  })
  return { pathsToMutate, alsoCopy, doNotMutate, strippedDoNotMutate }
}

/**
 * Render a `pyproject.toml` for a scoped mutmut run: merge the {@link MutmutScopePlan}'s
 * `paths_to_mutate`/`also_copy` (+ reconciled `do_not_mutate`) into the base pyproject's
 * `[tool.mutmut]` table (Fork F: only slice-0-verified keys), preserving every other section and any
 * other verified `[tool.mutmut]` key the operator set (e.g. `pytest_add_cli_args`). An empty
 * `do_not_mutate` is omitted entirely. Pure.
 */
export function synthesizeScopedMutmutPyproject(
  basePyproject: string,
  plan: MutmutScopePlan,
): string {
  const data = (basePyproject.trim() ? parse(basePyproject) : {}) as Record<string, unknown>
  const tool = (data.tool && typeof data.tool === 'object' ? data.tool : {}) as Record<
    string,
    unknown
  >
  const mutmut = (tool.mutmut && typeof tool.mutmut === 'object' ? tool.mutmut : {}) as Record<
    string,
    unknown
  >
  mutmut.paths_to_mutate = plan.pathsToMutate
  mutmut.also_copy = plan.alsoCopy
  if (plan.doNotMutate.length > 0) mutmut.do_not_mutate = plan.doNotMutate
  else delete mutmut.do_not_mutate
  tool.mutmut = mutmut
  data.tool = tool
  return stringify(data)
}
