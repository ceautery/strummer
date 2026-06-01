/**
 * Uncovered-new-line detection — the first, pure slice of the coverage pillar. Given a
 * file's istanbul coverage and the set of lines a diff *added/changed*, classify each
 * new line as covered, uncovered, or non-executable, and surface the
 * executable-but-unhit ones: the **forgotten-assertion catch** that is the genuinely
 * novel win under Strummer's TDD gate (a generic "what's uncovered" report largely
 * duplicates the suite the agent already runs — the new lines a change introduced
 * without a test exercising them is the signal worth isolating).
 *
 * Pure and offline: running the scoped suite to *produce* the coverage needs a
 * child-process boundary (the repo has a single root `vitest.config.ts`, so there is no
 * in-process Vitest-in-Vitest) and is a later slice. Keeping the differ pure is what
 * lets the green gate stay deterministic.
 *
 * THE CORRECTNESS TRAP (ADR 0010): istanbul derives line coverage from `statementMap`,
 * so a line carrying **no statement** (a blank line, a lone brace, a bare comment) is
 * in *neither* the covered nor the uncovered set. A differ that treats "not covered" as
 * "uncovered" would flag those false positives. We model an explicit third state,
 * `nonExecutable`, and never report it as a finding.
 */

export interface IstanbulPosition {
  line: number
  column?: number
}

export interface IstanbulRange {
  start: IstanbulPosition
  end: IstanbulPosition
}

/**
 * The subset of an istanbul `FileCoverage` we read — the per-file shape inside a
 * `coverage-final.json` (as emitted by `@vitest/coverage-v8`). `s` holds statement hit
 * counts keyed identically to `statementMap`.
 */
export interface FileCoverage {
  path?: string
  statementMap: Record<string, IstanbulRange>
  s: Record<string, number>
}

export type LineState = 'covered' | 'uncovered' | 'nonExecutable'

export interface ClassifiedLine {
  line: number
  state: LineState
}

export interface UncoveredNewLines {
  /** Every new line, classified, sorted ascending (input deduped). */
  lines: ClassifiedLine[]
  /** The executable new lines with zero hits — the forgotten-assertion catch. */
  uncovered: number[]
  summary: { covered: number; uncovered: number; nonExecutable: number; total: number }
}

/**
 * Map each source line to its statement hit count, mirroring istanbul's
 * `getLineCoverage`: a line's count is the **max** hit count over the statements that
 * *start* on it. A line absent from the map carries no statement (non-executable).
 */
function lineHitCounts(fc: FileCoverage): Map<number, number> {
  const hits = new Map<number, number>()
  for (const [id, range] of Object.entries(fc.statementMap)) {
    const line = range.start.line
    const count = fc.s[id] ?? 0
    const prev = hits.get(line)
    if (prev === undefined || count > prev) hits.set(line, count)
  }
  return hits
}

/**
 * Classify a diff's `newLines` against a file's istanbul coverage. New lines are
 * deduped and sorted; each is `covered` (a statement on it was hit), `uncovered` (a
 * statement on it was never hit), or `nonExecutable` (no statement maps to it).
 */
export function uncoveredNewLines(fc: FileCoverage, newLines: number[]): UncoveredNewLines {
  const hits = lineHitCounts(fc)
  const lines: ClassifiedLine[] = []
  const uncovered: number[] = []
  let covered = 0
  let uncov = 0
  let nonExecutable = 0

  for (const line of [...new Set(newLines)].sort((a, b) => a - b)) {
    const count = hits.get(line)
    let state: LineState
    if (count === undefined) {
      state = 'nonExecutable'
      nonExecutable++
    } else if (count > 0) {
      state = 'covered'
      covered++
    } else {
      state = 'uncovered'
      uncov++
      uncovered.push(line)
    }
    lines.push({ line, state })
  }

  return { lines, uncovered, summary: { covered, uncovered: uncov, nonExecutable, total: lines.length } }
}
