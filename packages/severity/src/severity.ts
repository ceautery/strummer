/**
 * The shared qualitative severity vocabulary every pillar reconciles onto (ADR 0013
 * §2). Extracted out of `@strummer/deps` so the verdict scale and the deps scale stop
 * each carrying their own copy of the same four-bucket ordering.
 *
 * Two scales build on this ONE base so their common ranks can never silently drift:
 *   - `@strummer/verdict`  `Severity`      = {@link QualitativeSeverity} | 'none'
 *   - `@strummer/deps`     `SeverityBucket` = {@link QualitativeSeverity} | 'unknown'
 *
 * The fifth member differs ON PURPOSE and is load-bearing: verdict's `'none'` means
 * "no severity"; deps' `'unknown'` means "severity indeterminable" and maps to a
 * `no-signal` pillar, NEVER to `low`/`none` (a tested invariant, not a footnote — the
 * absence-is-never-a-pass rule). So `'unknown'` is deliberately absent from this scale;
 * deps owns it.
 *
 * Pure, zero-dependency leaf (mirrors `@strummer/diff`/`assert`/`artifacts`): no spawn,
 * no network, no disk, no heavy runtime deps to drag into a consumer's bundle.
 */

/** The four qualitative buckets shared by every severity scale, worst (4) to best (1). */
export type QualitativeSeverity = 'critical' | 'high' | 'moderate' | 'low'

/** Ordinal rank for the qualitative buckets; higher = worse. The single source of truth. */
export const QUALITATIVE_RANK: Record<QualitativeSeverity, number> = {
  critical: 4,
  high: 3,
  moderate: 2,
  low: 1,
}

/** The verdict-side scale: the qualitative buckets plus a `'none'` (no-severity) sentinel. */
export type Severity = QualitativeSeverity | 'none'

/**
 * Ordinal rank for comparison; higher = worse. Derived from {@link QUALITATIVE_RANK}
 * (not re-typed) so the shared buckets cannot drift, with `none` as the zero sentinel.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  ...QUALITATIVE_RANK,
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
