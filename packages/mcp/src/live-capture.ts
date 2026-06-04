/**
 * 5e — verify-DRIVEN live capture (ADR 0013 Addendum 3). Drive an operator-authored
 * browser flow (by NAME), capture its HAR, and return the stored (redacted) handle for
 * the contract bridge to validate. The consume path (a pre-produced HAR by handle) stays
 * in `bin-verify`; this is the PRODUCE half.
 *
 * Load-bearing correction (all three 5e critics, independently): `runFlow` SWALLOWS a
 * step error — it records `ok:false`, breaks, and returns `{passed:false}` WITHOUT
 * re-throwing. So a partially-denied flow (e.g. an SSRF-allowlist denial mid-flow) yields
 * a NON-EMPTY HAR that `validateCapturedTraffic` could validate to a clean PASS —
 * "absence rendered as a pass." Therefore this gates on **flow completeness, not HAR
 * emptiness**: a flow that did not run to clean completion has no trustworthy contract
 * signal, so we THROW (⇒ the orchestrator folds `errorReason` ⇒ `inconclusive`), never
 * validating its HAR.
 *
 * Egress + lifecycle: the runtime (manager + gate + STARTED SSRF proxy + hardening launch
 * args) comes from the single-source `buildBrowserRuntimeFromEnv` via an injected factory
 * — lazy-imported in production so the playwright cold-start stays off the path of
 * compose-only / API-only operators. This is single-shot: `runtime.shutdown()` (manager +
 * proxy) ALWAYS runs in the `finally`, or each verify run leaks a listening SSRF proxy.
 * The HAR is redacted at the `finalizeHar` chokepoint and stored under the VERIFY prefix.
 */

import { randomUUID } from 'node:crypto'
import type { ArtifactStore } from '@strummer/artifacts'
import type { BrowserFlow, FlowResult, HarSummary, PageDriver } from '@strummer/browser'
import type { BrowserRuntime } from './bin-browser.js'
import type { ContractProduceContext } from './verify.js'

/** The browser-touching operations, injectable so the gate suite never spawns a browser.
 * Real defaults are lazy-imported from `@strummer/browser` only when a seam is absent. */
export interface LiveCaptureDeps {
  /** Build the egress-safe runtime (lazy import in prod; fake in tests). Single-shot —
   * `driveBrowserFlowToHar` tears it down (manager + proxy) in a `finally`. */
  runtimeFactory: () => Promise<BrowserRuntime>
  /** VERIFY-prefix artifact store the finalized (redacted) HAR is written to. */
  store: ArtifactStore
  /** Operator flows dir — by-NAME resolution, never a caller path. */
  flowsDir: string
  /** Deterministic id in tests; defaults to `randomUUID`. */
  idFactory?: () => string
  loadCollection?: (dir: string) => { flows: Map<string, BrowserFlow> }
  makeDriver?: (page: unknown, runId: string, runtime: BrowserRuntime) => PageDriver
  runFlow?: (
    driver: PageDriver,
    flow: BrowserFlow,
    opts: { vars?: Record<string, string>; resolveSecret?: (n: string) => string | undefined },
  ) => Promise<FlowResult>
  finalizeHar?: (opts: {
    harPath: string
    runId: string
    store: ArtifactStore
    redact?: (v: string) => string
  }) => Promise<HarSummary | undefined>
  harPathFor?: (dir: string, id: string) => string
}

export interface LiveCapture {
  /** `strummer://verify/<runId>/har` — the redacted, stored HAR archive, by handle. */
  harHandle: string
  summary: HarSummary
}

/** Drive a named flow → capture → return the stored redacted HAR handle. Throws (⇒
 * inconclusive) on an unknown flow, an incomplete flow, or an absent HAR — never a pass. */
export async function driveBrowserFlowToHar(
  ctx: ContractProduceContext,
  deps: LiveCaptureDeps,
): Promise<LiveCapture> {
  const needDefaults =
    !deps.loadCollection ||
    !deps.makeDriver ||
    !deps.runFlow ||
    !deps.finalizeHar ||
    !deps.harPathFor
  // Lazy: only pull playwright-core when a real default is actually needed.
  const b = needDefaults ? await import('@strummer/browser') : undefined
  const loadCollection = deps.loadCollection ?? ((dir: string) => b!.loadFlowCollection(dir))
  const runFlowFn = deps.runFlow ?? (b!.runFlow as NonNullable<LiveCaptureDeps['runFlow']>)
  const finalize = deps.finalizeHar ?? b!.finalizeHar
  const harPath = deps.harPathFor ?? b!.harPathFor
  const makeDriver =
    deps.makeDriver ??
    ((page: unknown, runId: string, rt: BrowserRuntime) =>
      new b!.PageDriver(page as never, {
        runId,
        store: deps.store,
        gate: rt.gate,
        redact: rt.redact,
      }))

  const collection = loadCollection(deps.flowsDir)
  const flow = collection.flows.get(ctx.flow)
  if (!flow) throw new Error(`no flow "${ctx.flow}" in the operator flows dir`)

  const id = (deps.idFactory ?? randomUUID)()
  const runtime = await deps.runtimeFactory()
  try {
    const context = await runtime.manager.createSession(id)
    const page = await context.newPage()
    const driver = makeDriver(page, id, runtime)
    const result = await runFlowFn(driver, flow, {
      vars: ctx.vars,
      resolveSecret: runtime.resolveSecret,
    })
    // Close the context so Playwright flushes the HAR `.zip` to disk.
    await runtime.manager.closeSession(id)

    // FLOW-COMPLETENESS guard (the load-bearing 5e correction): never validate a HAR from
    // a flow that did not run to clean completion. `result.passed` is false when any step
    // errored (ok:false) OR any assertion failed.
    if (!result.passed) {
      const bad = result.steps.find((s) => !s.ok)
      throw new Error(
        `captured flow "${ctx.flow}" did not complete${bad ? ` (step "${bad.action}" failed)` : ''}`,
      )
    }

    const harDir = runtime.config.harDir
    if (!harDir) {
      throw new Error('live capture requires STRUMMER_BROWSER_HAR_DIR (no HAR sink configured)')
    }
    const summary = await finalize({
      harPath: harPath(harDir, id),
      runId: id,
      store: deps.store,
      redact: runtime.redact,
    })
    if (!summary) throw new Error('no HAR was captured for the driven flow')
    return { harHandle: summary.handle, summary }
  } finally {
    // Single-shot: tear down the manager AND close the listening SSRF proxy — always.
    await runtime.shutdown()
  }
}
