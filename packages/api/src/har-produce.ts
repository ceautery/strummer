/**
 * The verify-DRIVEN API capture driver (ADR 0013 Addendum 4, milestone 5f). Drives the
 * `@strummer/api` runner for an operator-authored request (or sequence), SYNTHESIZES a
 * HAR from the run, redacts + stores it, and validates it against the contract via the
 * SHIPPED {@link validateCapturedTraffic} — the api-runner analogue of the browser
 * pillar's `driveBrowserFlowToHar` (5e). Unlike `har-synth.ts` this is NOT a pure leaf
 * (it imports the runner), so it lives in its own module.
 *
 * "Absence is never a pass" — TRANSPORT completeness is enforced HERE by THROWING
 * (⇒ the verify thunk rejects ⇒ inconclusive, mirroring `driveBrowserFlowToHar`): a
 * withheld/dry-run/blocked request, a non-sent step in a sequence, or a truncated
 * redirect chain never yields a validatable HAR. CONTRACT completeness (the verdict's
 * `clean` flag) is folded to inconclusive downstream by `@strummer/verdict`
 * `fromCaptureVerdict` (slice 6) — this driver returns the FULL verdict so that fold can.
 *
 * Redaction: the driver folds the run-resolved `{{secret:NAME}}` pairs (off the runner's
 * out-of-band channel) into the caller's union redactor BEFORE synthesizing or
 * validating, and {@link synthesizeRedactedHarZip} re-redacts at store time — so no raw
 * secret reaches the stored artifact or the findings.
 */
import { randomUUID } from 'node:crypto'
import type { CaptureContract, CaptureContractVerdict } from './har-capture.js'
import { validateCapturedTraffic } from './har-capture.js'
import { type HarHopRecord, synthesizeRedactedHarZip } from './har-synth.js'
import type { Collection } from './model.js'
import { type HarCapture, type RunOptions, runRequestForHar } from './runner.js'
import type { Redactor } from './secrets.js'
import { runSequenceForHar, type SequenceOptions } from './sequence.js'

/** The minimal artifact store the driver writes the redacted HAR to — satisfied by the
 * verify-prefix `@strummer/artifacts` `ArtifactStore` (kept structural so `@strummer/api`
 * needn't depend on `@strummer/artifacts`). */
export interface HarArtifactSink {
  put(runId: string, kind: string, body: string | Buffer, contentType: string): string
}

/** Compact HAR summary (shape-compatible with `@strummer/browser` `HarSummary`). */
export interface ProducedHarSummary {
  handle: string
  byteSize: number
  entryCount: number
  byStatus: Record<string, number>
  byMethod: Record<string, number>
}

export interface ProducedHar {
  /** `<store-prefix>://<id>/har` — the redacted, stored HAR archive, by handle. */
  harHandle: string
  summary: ProducedHarSummary
  /** The FULL contract verdict (incl. `clean`/`noSignal`/`unresolvedBodies`) so the
   * downstream fold can hold "absence is never a pass" on the contract dimension. */
  verdict: CaptureContractVerdict
}

export interface HarProduceDeps {
  store: HarArtifactSink
  /** The union redactor (verify ∪ api seed); the driver folds in the run-resolved
   * secrets and uses it at BOTH chokepoints (synthesize + validate). */
  redactor: Redactor
  contract: CaptureContract
  validate?: { baseDir?: string; allowedOrigins?: string[] }
  idFactory?: () => string
  /** Injected so the gate suite needn't fetch. */
  runForHar?: typeof runRequestForHar
  runSequenceForHar?: typeof runSequenceForHar
}

function countsFromRecords(hops: HarHopRecord[]): Omit<ProducedHarSummary, 'handle' | 'byteSize'> {
  const byStatus: Record<string, number> = {}
  const byMethod: Record<string, number> = {}
  for (const h of hops) {
    byStatus[String(h.status)] = (byStatus[String(h.status)] ?? 0) + 1
    byMethod[h.method] = (byMethod[h.method] ?? 0) + 1
  }
  return { entryCount: hops.length, byStatus, byMethod }
}

/** Synthesize → redact → store → validate, after the transport guards have passed.
 * The caller has already folded the run-resolved secrets into the union redactor. */
function finishProduce(capture: HarCapture, deps: HarProduceDeps): ProducedHar {
  if (capture.redirectTruncated) {
    throw new Error(
      'captured traffic did not complete its redirect chain (terminal status was a redirect)',
    )
  }
  const redact = (v: string) => deps.redactor.redact(v)
  const zip = synthesizeRedactedHarZip(capture.hops, redact)
  const id = (deps.idFactory ?? randomUUID)()
  const handle = deps.store.put(id, 'har', zip, 'application/zip')
  const verdict = validateCapturedTraffic(zip, deps.contract, {
    redact,
    baseDir: deps.validate?.baseDir,
    allowedOrigins: deps.validate?.allowedOrigins,
  })
  return {
    harHandle: handle,
    summary: { handle, byteSize: zip.byteLength, ...countsFromRecords(capture.hops) },
    verdict,
  }
}

/** Drive ONE request → synthesize + validate its HAR. Throws (⇒ inconclusive) when the
 * request was not sent (withheld/dry-run/blocked) or its redirect chain was truncated. */
export async function runRequestToHar(
  collection: Collection,
  name: string,
  opts: RunOptions,
  deps: HarProduceDeps,
): Promise<ProducedHar> {
  const { result, capture } = await (deps.runForHar ?? runRequestForHar)(collection, name, opts)
  // Fold run secrets first so a thrown reason can be scrubbed.
  for (const s of capture.registeredSecrets) deps.redactor.register(s.name, s.value)
  if (result.sent !== true) {
    throw new Error(
      `captured request "${name}" was not sent (${deps.redactor.redact(result.reason ?? 'withheld')})`,
    )
  }
  return finishProduce(capture, deps)
}

/** Drive a SEQUENCE → synthesize + validate the aggregated HAR. Throws (⇒ inconclusive)
 * when ANY step was not sent (per `step.result.sent`) or any hop truncated a redirect. */
export async function runSequenceToHar(
  collection: Collection,
  names: string[],
  opts: SequenceOptions,
  deps: HarProduceDeps,
): Promise<ProducedHar> {
  const { result, capture } = await (deps.runSequenceForHar ?? runSequenceForHar)(
    collection,
    names,
    opts,
  )
  for (const s of capture.registeredSecrets) deps.redactor.register(s.name, s.value)
  const unsent = result.steps.find((s) => s.result.sent !== true)
  if (unsent) {
    throw new Error(
      `captured sequence step "${unsent.name}" was not sent (${deps.redactor.redact(unsent.result.reason ?? 'withheld')})`,
    )
  }
  return finishProduce(capture, deps)
}
