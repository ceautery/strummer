/**
 * Pure mutation-report summarizer — the first slice of `@strummer/mutate`, and the one
 * with no I/O and no Stryker dependency.
 *
 * Mutation testing asks "are the tests meaningful?" — it perturbs the source (a `+`
 * becomes `-`, a `true` becomes `false`) and re-runs the suite; a mutant that survives is
 * a behaviour the tests do not actually pin down. Under Strummer's TDD gate the agent
 * wrote a passing test, but a passing test can still assert nothing useful — surviving
 * mutants are the catch for that, the natural complement to coverage's forgotten-assertion
 * catch (covered-but-unkilled vs added-but-uncovered).
 *
 * This module reads the **mutation-testing-elements report schema** (`schemaVersion`,
 * `files[path].mutants[].status`) that Stryker emits as `mutation-report.json`. The schema
 * is stable and decoupled from the Stryker version (ADR 0010 update 2026-06-01), so this
 * core carries no `@stryker-mutator/*` import — it is unit-tested against a committed
 * golden report. Producing a real report is a gated, injected `stryker run` (a later slice).
 *
 * Metric definitions mirror mutation-testing-elements exactly:
 *   detected   = killed + timeout
 *   undetected = survived + noCoverage
 *   covered    = detected + survived            (NoCoverage excluded — it was never run)
 *   valid      = detected + undetected
 *   invalid    = compileErrors + runtimeErrors
 *   total      = valid + invalid + ignored + pending
 *   mutationScore                 = detected / valid   (null when valid === 0)
 *   mutationScoreBasedOnCoveredCode = detected / covered (null when covered === 0)
 */

/** Mutant statuses from the mutation-testing-elements schema. */
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'Timeout'
  | 'CompileError'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending'

export interface MutantPosition {
  line: number
  column?: number
}

export interface Mutant {
  id: string
  mutatorName: string
  status: MutantStatus
  replacement?: string
  location?: { start: MutantPosition; end?: MutantPosition }
}

export interface MutationFile {
  language?: string
  source?: string
  mutants: Mutant[]
}

export interface MutationReport {
  schemaVersion?: string
  thresholds?: { high: number; low: number }
  files: Record<string, MutationFile>
}

export interface StatusCounts {
  killed: number
  survived: number
  timeout: number
  noCoverage: number
  compileErrors: number
  runtimeErrors: number
  ignored: number
  pending: number
}

export interface MutationMetrics {
  counts: StatusCounts
  detected: number
  undetected: number
  covered: number
  valid: number
  invalid: number
  totalMutants: number
  /** detected / valid (percent); null when there are no valid mutants. */
  mutationScore: number | null
  /** detected / covered (percent); null when no covered mutants. */
  mutationScoreBasedOnCoveredCode: number | null
}

export interface FileSummary {
  path: string
  metrics: MutationMetrics
}

/** A surviving (or never-covered) mutant — the actionable test gap. */
export interface Survivor {
  file: string
  mutatorName: string
  status: 'Survived' | 'NoCoverage'
  line: number
}

export interface MutationSummary {
  metrics: MutationMetrics
  files: FileSummary[]
  /** Survived + NoCoverage mutants, sorted by file then line — what to go fix. */
  survivors: Survivor[]
}

const ZERO: StatusCounts = {
  killed: 0,
  survived: 0,
  timeout: 0,
  noCoverage: 0,
  compileErrors: 0,
  runtimeErrors: 0,
  ignored: 0,
  pending: 0,
}

function tally(mutants: Mutant[]): StatusCounts {
  const c: StatusCounts = { ...ZERO }
  for (const m of mutants) {
    switch (m.status) {
      case 'Killed':
        c.killed++
        break
      case 'Survived':
        c.survived++
        break
      case 'Timeout':
        c.timeout++
        break
      case 'NoCoverage':
        c.noCoverage++
        break
      case 'CompileError':
        c.compileErrors++
        break
      case 'RuntimeError':
        c.runtimeErrors++
        break
      case 'Ignored':
        c.ignored++
        break
      case 'Pending':
        c.pending++
        break
    }
  }
  return c
}

function metricsFrom(c: StatusCounts): MutationMetrics {
  const detected = c.killed + c.timeout
  const undetected = c.survived + c.noCoverage
  const covered = detected + c.survived
  const valid = detected + undetected
  const invalid = c.compileErrors + c.runtimeErrors
  const totalMutants = valid + invalid + c.ignored + c.pending
  return {
    counts: c,
    detected,
    undetected,
    covered,
    valid,
    invalid,
    totalMutants,
    mutationScore: valid > 0 ? (detected / valid) * 100 : null,
    mutationScoreBasedOnCoveredCode: covered > 0 ? (detected / covered) * 100 : null,
  }
}

function sumCounts(a: StatusCounts, b: StatusCounts): StatusCounts {
  return {
    killed: a.killed + b.killed,
    survived: a.survived + b.survived,
    timeout: a.timeout + b.timeout,
    noCoverage: a.noCoverage + b.noCoverage,
    compileErrors: a.compileErrors + b.compileErrors,
    runtimeErrors: a.runtimeErrors + b.runtimeErrors,
    ignored: a.ignored + b.ignored,
    pending: a.pending + b.pending,
  }
}

/** Summarize a Stryker mutation report into aggregate + per-file metrics and the survivor list. Pure. */
export function summarizeMutation(report: MutationReport): MutationSummary {
  const files: FileSummary[] = []
  const survivors: Survivor[] = []
  let total: StatusCounts = { ...ZERO }

  for (const path of Object.keys(report.files).sort()) {
    const file = report.files[path]
    if (!file) continue
    const counts = tally(file.mutants)
    total = sumCounts(total, counts)
    files.push({ path, metrics: metricsFrom(counts) })

    for (const m of file.mutants) {
      if (m.status === 'Survived' || m.status === 'NoCoverage') {
        survivors.push({
          file: path,
          mutatorName: m.mutatorName,
          status: m.status,
          line: m.location?.start.line ?? 0,
        })
      }
    }
  }

  survivors.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))

  return { metrics: metricsFrom(total), files, survivors }
}
