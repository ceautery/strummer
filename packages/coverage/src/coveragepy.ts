/**
 * coverage.py adapter — converts a `coverage json` report into the istanbul
 * {@link FileCoverage} shape the pure differ ({@link uncoveredNewLines}/`uncoveredInDiff`)
 * already consumes. The Python sibling of the `@vitest/coverage-v8` `coverage-final.json`
 * path: the differ is entirely ecosystem-agnostic (it reads `statementMap` + `s`), so the
 * Python adapter is purely this shape converter — no change to the differ.
 *
 * THE GRANULARITY GAP: coverage.py is **line-based** (`executed_lines` / `missing_lines` /
 * `excluded_lines`), while istanbul is **statement-based**. We bridge by minting one synthetic
 * single-line statement per executed/missing line — executed → hit count 1, missing → 0. This
 * is loss-free for the forgotten-assertion catch, because that question is asked per *line*
 * (`uncoveredNewLines` reduces statements to lines via the max hit count on each start line),
 * never per sub-expression. `excluded_lines` are simply omitted from the map, so — exactly like
 * istanbul's blank/brace/comment lines — they fall into the `nonExecutable` third state and are
 * never reported as a finding (the ADR-0010 correctness trap, honoured for free). Pure, offline.
 */

import type { FileCoverage } from './uncovered.js'

/** The per-file shape inside a `coverage json` report (line-number lists). */
export interface CoveragePyFile {
  executed_lines: number[]
  missing_lines: number[]
  /** Lines coverage.py was told to exclude; omitted from the map (→ nonExecutable). */
  excluded_lines?: number[]
}

/** A `coverage json` report — `files` keyed by source path (relative or absolute). */
export interface CoveragePyReport {
  files?: Record<string, CoveragePyFile>
  meta?: Record<string, unknown>
}

/**
 * Convert one coverage.py file entry into a {@link FileCoverage}. Each executed line becomes a
 * synthetic statement hit once; each missing line a statement hit zero times; excluded lines are
 * left out entirely (they classify as `nonExecutable`).
 */
export function fileCoverageFromCoveragePy(path: string, file: CoveragePyFile): FileCoverage {
  const statementMap: FileCoverage['statementMap'] = {}
  const s: FileCoverage['s'] = {}
  let id = 0
  const add = (line: number, hits: number) => {
    const key = String(id++)
    statementMap[key] = { start: { line, column: 0 }, end: { line, column: 0 } }
    s[key] = hits
  }
  for (const line of file.executed_lines ?? []) add(line, 1)
  for (const line of file.missing_lines ?? []) add(line, 0)
  return { path, statementMap, s }
}

/**
 * Convert a whole `coverage json` report into the `Record<path, FileCoverage>` map
 * `uncoveredInDiff` consumes, preserving coverage.py's path keys (its own diff-path↔key
 * reconciliation handles relative vs absolute).
 */
export function coveragePyToIstanbul(report: CoveragePyReport): Record<string, FileCoverage> {
  const out: Record<string, FileCoverage> = {}
  for (const [path, file] of Object.entries(report.files ?? {})) {
    out[path] = fileCoverageFromCoveragePy(path, file)
  }
  return out
}
