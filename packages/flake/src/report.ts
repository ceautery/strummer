/**
 * Vitest JSON-report ingestion — turns a `vitest run --reporter=json` report into the
 * {@link RecordedRun}s the history store records.
 *
 * Per ADR 0010 the flake pillar **spawns** `vitest run --reporter=json` and parses its
 * output (a different execution model from coverage's in-process/child-process run and
 * mutation's Stryker delegation — there is no shared runner seam). This module is the
 * pure parser half: no spawning, no I/O — it just maps the report's shape to runs, so it
 * is unit-tested against a committed real-shaped fixture. The gated spawn that produces
 * the report lives in a later slice.
 *
 * The report's `fullName` is the ancestor titles + title joined by a single space, which
 * is lossy (a describe/test boundary is indistinguishable from a space inside a title).
 * We therefore build a stable, file-qualified id from `ancestorTitles + title` joined by
 * ` > ` ourselves, falling back to `fullName`, then `title`, when those are absent.
 */

import { relative } from 'node:path'
import type { RecordedRun } from './store.js'

/** The subset of a vitest json assertion result we read. */
export interface VitestAssertion {
  ancestorTitles?: string[]
  title?: string
  fullName?: string
  status?: string
  duration?: number | null
}

export interface VitestFileResult {
  /** Test file path (absolute as vitest emits it). */
  name?: string
  assertionResults?: VitestAssertion[]
}

export interface VitestJsonReport {
  testResults?: VitestFileResult[]
}

export interface ParseReportOptions {
  /** ISO timestamp stamped on every parsed run. */
  at: string
  /** When set, file paths are made relative to it for stable, machine-independent ids. */
  projectRoot?: string
  /** Optional id grouping all runs from this report (a CI run / batch). */
  runGroup?: string
}

/** A status that carries a pass/fail signal. Skipped/pending/todo do not. */
function outcome(status: string | undefined): boolean | undefined {
  if (status === 'passed') return true
  if (status === 'failed') return false
  return undefined
}

function titlePart(a: VitestAssertion): string {
  if (a.ancestorTitles?.length) return [...a.ancestorTitles, a.title ?? ''].join(' > ')
  return a.fullName ?? a.title ?? '<unknown>'
}

function fileLabel(name: string | undefined, projectRoot?: string): string {
  if (!name) return ''
  return projectRoot ? relative(projectRoot, name) : name
}

/**
 * Parse a vitest json report into recorded runs — one per pass/fail assertion. Skipped /
 * pending / todo assertions are dropped (no pass/fail signal). Pure: no spawning, no I/O.
 */
export function parseVitestJson(report: VitestJsonReport, opts: ParseReportOptions): RecordedRun[] {
  const runs: RecordedRun[] = []
  for (const file of report.testResults ?? []) {
    const label = fileLabel(file.name, opts.projectRoot)
    for (const a of file.assertionResults ?? []) {
      const passed = outcome(a.status)
      if (passed === undefined) continue
      const id = label ? `${label} > ${titlePart(a)}` : titlePart(a)
      const run: RecordedRun = { testId: id, passed, at: opts.at }
      if (typeof a.duration === 'number') run.durationMs = a.duration
      if (opts.runGroup !== undefined) run.runGroup = opts.runGroup
      runs.push(run)
    }
  }
  return runs
}
