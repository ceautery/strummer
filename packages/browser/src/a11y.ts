import type { AxeResults, ImpactValue } from 'axe-core'

/** A token-cheap summary of an axe accessibility run. The full `AxeResults` is
 * returned separately by an artifact handle, never inlined here. */
export interface A11ySummary {
  violationCount: number
  /** Count of violations bucketed by impact (e.g. `{ critical: 1, moderate: 2 }`). */
  byImpact: Record<string, number>
  /** The most-severe violations first, capped so the summary stays small. */
  top: A11yViolationSummary[]
}

export interface A11yViolationSummary {
  id: string
  impact: ImpactValue | null
  help: string
  helpUrl: string
  nodeCount: number
}

const IMPACT_RANK: Record<string, number> = { critical: 4, serious: 3, moderate: 2, minor: 1 }
const TOP_LIMIT = 10

function rank(impact: ImpactValue | null | undefined): number {
  return impact ? (IMPACT_RANK[impact] ?? 0) : 0
}

/** Reduce a full axe report to a compact, agent-friendly summary. */
export function summarizeA11y(results: AxeResults): A11ySummary {
  const { violations } = results
  const byImpact: Record<string, number> = {}
  for (const v of violations) {
    const bucket = v.impact ?? 'unknown'
    byImpact[bucket] = (byImpact[bucket] ?? 0) + 1
  }
  const top = [...violations]
    .sort((a, b) => rank(b.impact) - rank(a.impact))
    .slice(0, TOP_LIMIT)
    .map(
      (v): A11yViolationSummary => ({
        id: v.id,
        impact: v.impact ?? null,
        help: v.help,
        helpUrl: v.helpUrl,
        nodeCount: v.nodes.length,
      }),
    )
  return { violationCount: violations.length, byImpact, top }
}
