/**
 * Verify-DRIVEN live capture (ADR 0013 Addendum 3, milestone 5e): drive an
 * operator-authored flow (by NAME), capture its HAR, and return the stored (redacted)
 * handle for a contract bridge to validate. Lives in `@sackville/browser` — its natural
 * home, alongside {@link runFlow}/{@link finalizeHar}/{@link loadFlowCollection} — so BOTH
 * the verify MCP bin AND the `sackville verify run --flow` CLI share ONE implementation of
 * the security-critical flow-completeness guard (no drift). Callers lazy-import the whole
 * package so the playwright cold-start stays off compose-only / API-only paths.
 *
 * Load-bearing correction (all three 5e critics): {@link runFlow} SWALLOWS a step error —
 * it records `ok:false`, breaks, and returns `{passed:false}` WITHOUT re-throwing. So a
 * partially-denied flow (e.g. an SSRF-allowlist denial mid-flow) yields a NON-EMPTY HAR
 * that could validate to a clean PASS — "absence rendered as a pass." So this gates on
 * **flow completeness, not HAR emptiness**: a flow that did not run to clean completion
 * has no trustworthy contract signal, so we THROW (the orchestrator folds it to
 * `inconclusive`), never finalizing/validating its HAR.
 *
 * Single-shot: `runtime.shutdown()` (manager + the listening SSRF proxy) ALWAYS runs in a
 * `finally`, or each capture leaks a proxy listener. The HAR is redacted at the
 * `finalizeHar` chokepoint and stored under the caller's (verify-prefix) store.
 */

import { randomUUID } from 'node:crypto'
import type { ArtifactStore } from '@sackville/artifacts'
import { PageDriver } from './driver.js'
import { type BrowserFlow, type FlowResult, loadFlowCollection, runFlow } from './flow.js'
import type { BrowserGate } from './gate.js'
import { finalizeHar, type HarSummary, harPathFor } from './har.js'
import type { BrowserManager } from './manager.js'

/** The minimal egress-safe runtime {@link driveBrowserFlowToHar} drives. The verify bin's
 * `buildBrowserRuntimeFromEnv` return AND the CLI's flags-built runtime both satisfy it. */
export interface CaptureRuntime {
  manager: Pick<BrowserManager, 'createSession' | 'closeSession'>
  /** Installed on the manager's contexts; also drives the per-step `PageDriver`. */
  gate: BrowserGate
  /** The (union) redactor for surfaced values + the HAR archive. */
  redact: (value: string) => string
  resolveSecret?: (name: string) => string | undefined
  /** The HAR sink (operator `SACKVILLE_BROWSER_HAR_DIR` / CLI `--har-dir`). */
  config: { harDir?: string }
  /** Tear down the manager AND close the SSRF proxy (single-shot — always in `finally`). */
  shutdown: () => Promise<void>
}

/** What to capture: an operator-authored flow NAME (never a path) + non-secret vars. */
export interface CaptureRequest {
  flow: string
  vars?: Record<string, string>
}

/** Browser-touching ops, injectable so a gate suite never spawns a real browser. */
export interface LiveCaptureDeps {
  runtimeFactory: () => Promise<CaptureRuntime>
  /** Store the finalized (redacted) HAR is written to — the caller's verify-prefix store. */
  store: ArtifactStore
  /** Operator flows dir — by-NAME resolution, never a caller path. */
  flowsDir: string
  /** Redactor for the finalized HAR (the 5e union); defaults to the runtime's redactor. */
  redact?: (value: string) => string
  idFactory?: () => string
  loadCollection?: (dir: string) => { flows: Map<string, BrowserFlow> }
  makeDriver?: (page: unknown, runId: string, runtime: CaptureRuntime) => PageDriver
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
  /** `<store-prefix>://<runId>/har` — the redacted, stored HAR archive, by handle. */
  harHandle: string
  summary: HarSummary
}

/** Drive a named flow → capture → return the stored redacted HAR handle. Throws (⇒
 * inconclusive) on an unknown flow, an incomplete flow, or an absent HAR — never a pass. */
export async function driveBrowserFlowToHar(
  req: CaptureRequest,
  deps: LiveCaptureDeps,
): Promise<LiveCapture> {
  const loadCollection = deps.loadCollection ?? loadFlowCollection
  const runFlowFn = deps.runFlow ?? runFlow
  const finalize = deps.finalizeHar ?? finalizeHar
  const harPath = deps.harPathFor ?? harPathFor
  const makeDriver =
    deps.makeDriver ??
    ((page: unknown, runId: string, rt: CaptureRuntime) =>
      new PageDriver(page as never, {
        runId,
        store: deps.store,
        gate: rt.gate,
        redact: rt.redact,
      }))

  const collection = loadCollection(deps.flowsDir)
  const flow = collection.flows.get(req.flow)
  if (!flow) throw new Error(`no flow "${req.flow}" in the operator flows dir`)

  const id = (deps.idFactory ?? randomUUID)()
  const runtime = await deps.runtimeFactory()
  try {
    const context = await runtime.manager.createSession(id)
    const page = await context.newPage()
    const driver = makeDriver(page, id, runtime)
    const result = await runFlowFn(driver, flow, {
      vars: req.vars,
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
        `captured flow "${req.flow}" did not complete${bad ? ` (step "${bad.action}" failed)` : ''}`,
      )
    }

    const harDir = runtime.config.harDir
    if (!harDir) {
      throw new Error(
        'live capture requires a HAR sink dir (SACKVILLE_BROWSER_HAR_DIR / --har-dir)',
      )
    }
    const summary = await finalize({
      harPath: harPath(harDir, id),
      runId: id,
      store: deps.store,
      redact: deps.redact ?? runtime.redact,
    })
    if (!summary) throw new Error('no HAR was captured for the driven flow')
    return { harHandle: summary.handle, summary }
  } finally {
    // Single-shot: tear down the manager AND close the listening SSRF proxy — always.
    await runtime.shutdown()
  }
}
