import { type AssertionOp, applyOp } from '@sackville-mcp/assert'
import type { Locator, Page } from 'playwright-core'

type Role = Parameters<Page['getByRole']>[0]

/** What a browser assertion reads. Page-level: `url`/`title`/`ariaSnapshot`.
 * Element-level (needs a `ref` or `role`): `text`/`value`/`visible`/`count`. */
export type BrowserAssertionSource =
  | 'url'
  | 'title'
  | 'ariaSnapshot'
  | 'text'
  | 'value'
  | 'visible'
  | 'count'

/** A declarative browser assertion. Element sources target via a snapshot `ref`
 * OR a `role` (+ optional accessible `name`). The operator vocabulary (`op`) is
 * the shared `@sackville-mcp/assert` set — one assertion engine across pillars. */
export interface BrowserAssertionSpec {
  source: BrowserAssertionSource
  op: AssertionOp
  value?: unknown
  ref?: string
  role?: string
  name?: string
  /** Max ms to auto-wait for the condition to hold (UI is async). Default 5000. */
  timeout?: number
}

export interface BrowserAssertionResult {
  source: BrowserAssertionSource
  op: AssertionOp
  ref?: string
  role?: string
  name?: string
  expected?: unknown
  /** The observed value at the last probe (redacted if a string). */
  actual: unknown
  pass: boolean
}

export interface AssertContext {
  page: Page
  /** Resolve a snapshot ref to a locator (throws on a stale/unknown ref). */
  locatorForRef: (ref: string) => Locator
  /** Redact a string value before it surfaces. */
  redact: (value: string) => string
  /** Clock (injectable for tests). */
  now: () => number
}

const POLL_MS = 50
const DEFAULT_TIMEOUT_MS = 5000

function locatorFor(ctx: AssertContext, spec: BrowserAssertionSpec): Locator {
  if (spec.ref !== undefined) return ctx.locatorForRef(spec.ref)
  if (spec.role !== undefined) {
    return spec.name === undefined
      ? ctx.page.getByRole(spec.role as Role)
      : ctx.page.getByRole(spec.role as Role, { name: spec.name })
  }
  throw new Error(`assertion source "${spec.source}" needs a ref or role to target an element`)
}

/**
 * Probe the current `actual` value for a spec — **immediately**, never auto-waiting
 * inside Playwright (the poll loop owns waiting). Element existence is checked with
 * `count()` (synchronous against the current DOM) so a missing element returns
 * fast instead of blocking on a locator's default timeout.
 */
async function probe(ctx: AssertContext, spec: BrowserAssertionSpec): Promise<unknown> {
  switch (spec.source) {
    case 'url':
      return ctx.page.url()
    case 'title':
      return ctx.page.title()
    case 'ariaSnapshot':
      return ctx.page.locator('body').ariaSnapshot()
    default: {
      const loc = locatorFor(ctx, spec)
      if (spec.source === 'count') return loc.count()
      if ((await loc.count()) === 0) return spec.source === 'visible' ? false : undefined
      const first = loc.first()
      if (spec.source === 'visible') return first.isVisible()
      if (spec.source === 'value') return first.inputValue()
      return first.textContent()
    }
  }
}

async function evaluateOne(
  ctx: AssertContext,
  spec: BrowserAssertionSpec,
): Promise<BrowserAssertionResult> {
  const timeout = spec.timeout ?? DEFAULT_TIMEOUT_MS
  const start = ctx.now()
  let actual: unknown
  let pass = false
  // Auto-wait: re-probe until the condition holds or the timeout elapses.
  while (true) {
    try {
      actual = await probe(ctx, spec)
    } catch {
      actual = undefined // element detached mid-probe / stale ref this tick — retry
    }
    pass = applyOp(spec.op, actual, spec.value)
    if (pass || ctx.now() - start >= timeout) break
    await ctx.page.waitForTimeout(POLL_MS)
  }
  return {
    source: spec.source,
    op: spec.op,
    ...(spec.ref !== undefined ? { ref: spec.ref } : {}),
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    ...(spec.name !== undefined ? { name: spec.name } : {}),
    expected: spec.value,
    actual: typeof actual === 'string' ? ctx.redact(actual) : actual,
    pass,
  }
}

/** Evaluate browser assertions concurrently, each auto-waiting up to its timeout. */
export function evaluateBrowserAssertions(
  ctx: AssertContext,
  specs: BrowserAssertionSpec[],
): Promise<BrowserAssertionResult[]> {
  return Promise.all(specs.map((spec) => evaluateOne(ctx, spec)))
}
