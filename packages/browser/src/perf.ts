import { launch } from 'chrome-launcher'
import lighthouse from 'lighthouse'
import type { ArtifactStore } from './artifacts.js'

/**
 * Performance audit via the **Lighthouse node API** (ADR 0006; ROADMAP Phase 3).
 *
 * Lighthouse drives its own Chrome over CDP, so we launch one with `chrome-launcher`
 * pointed at the operator-supplied chromium binary and **operator-supplied flags**
 * (the bin passes the mandatory SSRF proxy + hardening args, so Lighthouse's
 * navigations traverse the same egress boundary). The full LHR JSON + HTML report
 * are stored **by handle** (redacted before write); the returned summary carries the
 * performance score + the core web-vitals metrics. Per ADR 0006, callers should
 * assert on metric **shape/thresholds**, never an exact score (scores vary run to
 * run with machine load).
 */

/** One Lighthouse metric audit (a core web vital). */
export interface PerfMetric {
  id: string
  /** Lighthouse's 0–1 score for this metric, or null when not scored. */
  score: number | null
  /** Raw measured value (ms, or unitless for CLS). */
  numericValue?: number
  /** Human display value, e.g. `"0.6 s"`. */
  displayValue?: string
}

export interface PerfSummary {
  /** Overall performance category score, 0–1 (or null). */
  performanceScore: number | null
  /** Core metrics: FCP, LCP, TBT, CLS, Speed Index, TTI. */
  metrics: PerfMetric[]
  lighthouseVersion: string
}

export interface PerfAuditResult {
  summary: PerfSummary
  /** `sackville://browser/run/<id>/perf[-s<n>]` — the full LHR JSON, by handle. */
  reportHandle: string
  /** `sackville://browser/run/<id>/perf[-s<n>]-html` — the HTML report, by handle. */
  htmlHandle: string
}

export interface PerfAuditOptions {
  runId: string
  store: ArtifactStore
  /** Path to the chromium binary Lighthouse should launch. */
  chromePath: string
  /** Flags for the launched chrome — the bin supplies the SSRF proxy + hardening. */
  chromeFlags?: string[]
  /** Per-run index → `perf-s<n>` handles when auditing repeatedly in one run. */
  index?: number
  /** Applied to both stored reports before write. Default identity. */
  redact?: (value: string) => string
}

/** The Lighthouse metric audit ids surfaced in the summary, most-relevant first. */
const CORE_METRICS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
  'interactive',
] as const

export async function auditPerf(url: string, opts: PerfAuditOptions): Promise<PerfAuditResult> {
  const chrome = await launch({ chromePath: opts.chromePath, chromeFlags: opts.chromeFlags ?? [] })
  try {
    const result = await lighthouse(url, {
      port: chrome.port,
      output: ['json', 'html'],
      onlyCategories: ['performance'],
      logLevel: 'silent',
    })
    if (!result) throw new Error('lighthouse produced no result')
    const lhr = result.lhr
    // `output: [json, html]` ⇒ `report` is a string[] in that order.
    const reports = result.report as string[]
    const redact = opts.redact ?? ((v: string) => v)

    const suffix = opts.index === undefined ? '' : `-s${opts.index}`
    const reportHandle = opts.store.put(
      opts.runId,
      `perf${suffix}`,
      redact(reports[0] ?? ''),
      'application/json',
    )
    const htmlHandle = opts.store.put(
      opts.runId,
      `perf${suffix}-html`,
      redact(reports[1] ?? ''),
      'text/html',
    )

    const metrics: PerfMetric[] = CORE_METRICS.map((id) => {
      const audit = lhr.audits[id]
      return {
        id,
        score: audit?.score ?? null,
        ...(audit?.numericValue !== undefined ? { numericValue: audit.numericValue } : {}),
        ...(audit?.displayValue !== undefined ? { displayValue: audit.displayValue } : {}),
      }
    })

    return {
      summary: {
        performanceScore: lhr.categories.performance?.score ?? null,
        metrics,
        lighthouseVersion: lhr.lighthouseVersion,
      },
      reportHandle,
      htmlHandle,
    }
  } finally {
    await chrome.kill()
  }
}
