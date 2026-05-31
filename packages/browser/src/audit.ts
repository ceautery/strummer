import { AxeBuilder } from '@axe-core/playwright'
import type { Page } from 'playwright-core'
import { type A11ySummary, summarizeA11y } from './a11y.js'
import type { ArtifactStore } from './artifacts.js'

export interface A11yAuditResult {
  summary: A11ySummary
  /** `strummer://browser/run/<id>/a11y` — the full axe report, by handle. */
  resultsHandle: string
}

export interface A11yAuditOptions {
  runId: string
  store: ArtifactStore
}

/**
 * Run an axe-core accessibility audit against an already-loaded page (a free
 * read action — it injects axe and reads the DOM, no navigation or mutation),
 * store the full `AxeResults` by handle, and return a compact summary.
 */
export async function auditA11y(page: Page, opts: A11yAuditOptions): Promise<A11yAuditResult> {
  const results = await new AxeBuilder({ page }).analyze()
  const resultsHandle = opts.store.put(
    opts.runId,
    'a11y',
    JSON.stringify(results),
    'application/json',
  )
  return { summary: summarizeA11y(results), resultsHandle }
}
