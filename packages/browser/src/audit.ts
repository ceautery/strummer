import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from 'playwright-core'
import { type A11ySummary, summarizeA11y } from './a11y.js'
import type { ArtifactStore } from './artifacts.js'

export interface A11yAuditResult {
  summary: A11ySummary
  /** `strummer://browser/run/<id>/a11y[-s<index>]` — the full axe report, by handle. */
  resultsHandle: string
}

export interface A11yAuditOptions {
  runId: string
  store: ArtifactStore
  /** Per-run audit index. When set, the report is keyed `a11y-s<index>` so
   * repeated audits in one run produce distinct, non-overwriting handles. */
  index?: number
}

/**
 * Run an axe-core accessibility audit against an already-loaded page (a free
 * read action — it injects axe and reads the DOM, no navigation or mutation),
 * store the full `AxeResults` by handle, and return a compact summary.
 */
export async function auditA11y(page: Page, opts: A11yAuditOptions): Promise<A11yAuditResult> {
  const results = await new AxeBuilder({ page }).analyze()
  const kind = opts.index === undefined ? 'a11y' : `a11y-s${opts.index}`
  const resultsHandle = opts.store.put(
    opts.runId,
    kind,
    JSON.stringify(results),
    'application/json',
  )
  return { summary: summarizeA11y(results), resultsHandle }
}
