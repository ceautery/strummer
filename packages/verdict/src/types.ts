import type { Severity } from './severity.js'

/** The pillars a composite verdict can fold. */
export type PillarName = 'contract' | 'coverage' | 'deps' | 'flake' | 'mutate'

/**
 * A pillar's contribution to the verdict.
 * - `pass` — ran, clean.
 * - `warn` — a real signal of a problem the policy may or may not treat as failing.
 * - `fail` — a problem this pillar treats as failing on its own.
 * - `no-signal` — ran but had no usable signal (mutation null+no survivors, flake
 *   insufficient-data, deps with no OSV snapshot, contract with zero entries).
 * - `missing` — no input was supplied for this pillar.
 *
 * `no-signal` and `missing` NEVER count as a pass (ADR 0013 §1).
 */
export type PillarStatus = 'pass' | 'warn' | 'fail' | 'no-signal' | 'missing'

export interface PillarVerdict {
  pillar: PillarName
  status: PillarStatus
  /** The worst severity this pillar observed (drives the composite worstSeverity). */
  severity: Severity
  /** A short, redaction-safe one-line summary. */
  headline: string
  /** Optional small tallies (e.g. `{ findings: 3 }`) — never large/inlined detail. */
  counts?: Record<string, number>
  /**
   * Provenance for the contract pillar: whether the result came from a live run or
   * from a captured HAR (different trust/redaction story — ADR 0013 §1).
   */
  source?: 'run' | 'capture-from-HAR'
}

/** The overall posture. `inconclusive` is the honest "couldn't claim pass" state. */
export type OverallStatus = 'pass' | 'warn' | 'fail' | 'inconclusive'

export interface CompositeVerdict {
  /** `true` ONLY when the overall status is `pass`. warn/fail/inconclusive ⇒ false. */
  ok: boolean
  status: OverallStatus
  /** The worst severity across all present pillars. */
  worstSeverity: Severity
  /** The pillar driving the worst outcome, when there is one. */
  worstPillar?: PillarName
  /** Every pillar's verdict (including `missing` ones), in a stable order. */
  pillars: PillarVerdict[]
  /** Pillars with no input supplied. */
  missing: PillarName[]
}

/**
 * The policy cut. There is intentionally NO baked-in default (ADR 0013 §3a/slice
 * 10): the operator/agent must declare `failAtOrAbove` to escalate a severity to a
 * failing overall posture — the rollup must not silently encode a value judgment.
 */
export interface VerdictPolicy {
  /** A pillar whose severity is at least this becomes a failing overall posture. */
  failAtOrAbove?: Severity
}
