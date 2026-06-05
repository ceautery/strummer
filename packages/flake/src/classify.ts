/**
 * Pure flakiness classifier — the first slice of `@sackville/flake`, and the only one
 * that touches no I/O. Given each test's run history (an ordered list of pass/fail
 * outcomes), it labels the test and quantifies *how* flaky it is with a binomial
 * confidence bound, so a later operator-gated quarantine slice has a defensible,
 * sample-size-aware number to threshold on rather than a raw "it failed once" reflex.
 *
 * Why Wilson and not the naive p̂ = failures/runs:
 * - The naive rate is wildly overconfident on small samples (1 failure in 2 runs reads
 *   as a 50% failure rate; 1 in 100 reads as 1%, but with no sense of how trustworthy
 *   either is). The **Wilson score interval** for a binomial proportion gives an
 *   asymmetric, always-in-[0,1] confidence interval that stays sane at small n and at
 *   the p̂=0 / p̂=1 boundaries (where the normal-approximation Wald interval collapses to
 *   a useless zero-width point). We expose its lower bound as `flakeScore`: the
 *   conservative "we're confident the test fails at least this often" magnitude — a test
 *   that failed 1/100 from infra noise scores far below one failing 30/100, even though a
 *   naive "has failed" flag treats them alike.
 *
 * Classification policy (deliberately conservative toward *catching* flakes, but
 * cautious about *condemning* a test as reliable/broken on thin evidence):
 * - A history with **both** a pass and a failure is `flaky` at any run count — observed
 *   inconsistency is the definition of flaky; one mixed pair is enough to flag it.
 * - An all-pass or all-fail history is only trusted as `reliable` / `broken` once it
 *   clears `minRuns`; below that it is `insufficient-data` (a brand-new all-pass test may
 *   simply not have hit its flake yet; a single failure may be a one-off).
 * - An empty history is `insufficient-data`.
 */

/** A single recorded execution of a test. */
export interface TestRun {
  passed: boolean
  /**
   * ISO timestamp of the run. Carried through from the (future) history store for later
   * time-windowing slices; the pure classifier reads only `passed`.
   */
  at?: string
}

export interface TestHistory {
  /** Stable test identifier, e.g. `<file> > <test name>`. */
  id: string
  /** Runs in any order — the classifier only counts pass/fail, never their sequence. */
  runs: TestRun[]
}

export type FlakeState = 'flaky' | 'reliable' | 'broken' | 'insufficient-data'

/** A Wilson score interval, clamped to [0, 1]. */
export interface WilsonInterval {
  lower: number
  center: number
  upper: number
}

export interface FlakeVerdict {
  id: string
  state: FlakeState
  runs: number
  passes: number
  failures: number
  /** Observed failure rate failures/runs (0 when there are no runs). */
  failureRate: number
  /** Wilson score interval for the true failure rate at the configured confidence. */
  wilson: WilsonInterval
  /**
   * Conservative flakiness magnitude = the Wilson lower bound of the failure rate. The
   * number a quarantine policy thresholds on: high only when the test fails often AND we
   * have enough runs to be confident. 0 for reliable / empty histories.
   */
  flakeScore: number
}

export interface ClassifyOptions {
  /** z-score for the Wilson interval; default 1.96 (two-sided 95%). */
  z?: number
  /**
   * Minimum runs before an all-pass / all-fail history is trusted as `reliable` /
   * `broken`. Below it (with no observed inconsistency) the verdict is
   * `insufficient-data`. A *mixed* history is `flaky` at any run count. Default 5.
   */
  minRuns?: number
}

const DEFAULT_Z = 1.96
const DEFAULT_MIN_RUNS = 5

/**
 * The Wilson score interval for `failures` successes in `runs` Bernoulli trials at
 * confidence `z`. Bounds are clamped to [0, 1]. Zero runs yields a degenerate zero
 * interval (the rate is undefined; the caller marks it insufficient-data).
 */
export function wilsonInterval(failures: number, runs: number, z = DEFAULT_Z): WilsonInterval {
  if (runs <= 0) return { lower: 0, center: 0, upper: 0 }
  const n = runs
  const p = failures / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    lower: Math.max(0, center - margin),
    center,
    upper: Math.min(1, center + margin),
  }
}

/** Classify a single test's run history into a {@link FlakeVerdict}. */
export function classifyHistory(history: TestHistory, opts: ClassifyOptions = {}): FlakeVerdict {
  const z = opts.z ?? DEFAULT_Z
  const minRuns = opts.minRuns ?? DEFAULT_MIN_RUNS

  const runs = history.runs.length
  const passes = history.runs.reduce((n, r) => n + (r.passed ? 1 : 0), 0)
  const failures = runs - passes
  const failureRate = runs > 0 ? failures / runs : 0
  const wilson = wilsonInterval(failures, runs, z)

  let state: FlakeState
  if (runs === 0) {
    state = 'insufficient-data'
  } else if (passes > 0 && failures > 0) {
    state = 'flaky'
  } else if (runs < minRuns) {
    // All-pass or all-fail, but too few runs to trust the verdict.
    state = 'insufficient-data'
  } else if (failures === 0) {
    state = 'reliable'
  } else {
    state = 'broken'
  }

  return {
    id: history.id,
    state,
    runs,
    passes,
    failures,
    failureRate,
    wilson,
    flakeScore: wilson.lower,
  }
}

/**
 * Classify many histories, preserving input order. Callers rank quarantine candidates by
 * sorting on `flakeScore` (or filtering `state === 'flaky'`).
 */
export function classifyHistories(
  histories: TestHistory[],
  opts: ClassifyOptions = {},
): FlakeVerdict[] {
  return histories.map((h) => classifyHistory(h, opts))
}
