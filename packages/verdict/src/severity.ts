/**
 * The single severity scale every pillar reconciles onto (ADR 0013 §2). Seeded
 * from deps' `SeverityBucket` vocabulary but deliberately NOT importing it —
 * extracting a shared scale out of deps is staged (duplicating a small union is
 * cheaper than a refactor that touches the deps gate now). Note: deps'
 * `'unknown'` does NOT appear here — it maps to a `no-signal` pillar, never to
 * `low`/`none` (a tested invariant, not a footnote).
 */
export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'none'

/** Ordinal rank for comparison; higher = worse. */
export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
}

/** The worst (highest-rank) severity among the arguments; `'none'` when empty. */
export function maxSeverity(...severities: Severity[]): Severity {
  let worst: Severity = 'none'
  for (const s of severities) {
    if (SEVERITY_RANK[s] > SEVERITY_RANK[worst]) worst = s
  }
  return worst
}

/** True when `a` is at least as severe as `b`. */
export function atLeast(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b]
}
