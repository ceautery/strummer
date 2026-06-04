import type { Collection, RunResult } from './model.js'
import type { HarCapture } from './runner.js'
import { type RunOptions, runRequest, runRequestForHar } from './runner.js'

export interface SequenceOptions extends RunOptions {
  /** Stop the sequence if a request's assertions fail. */
  stopOnFailure?: boolean
}

export interface SequenceStep {
  name: string
  result: RunResult
}

export interface SequenceResult {
  steps: SequenceStep[]
  /** Variables captured across the whole sequence (threaded forward). */
  captured: Record<string, unknown>
}

/**
 * Run requests in order, threading each response's captured variables into the
 * scope of the requests that follow (request chaining). Per-run options
 * (secrets, allowUnsafe, allowlist, artifacts) apply to every request; the
 * variable scope is the shared, accumulating one.
 */
export async function runSequence(
  collection: Collection,
  names: string[],
  opts: SequenceOptions = {},
): Promise<SequenceResult> {
  const scope: Record<string, unknown> = { ...(opts.vars ?? {}) }
  const captured: Record<string, unknown> = {}
  const steps: SequenceStep[] = []

  for (const name of names) {
    const result = await runRequest(collection, name, { ...opts, vars: scope })
    steps.push({ name, result })

    if (result.sent && result.response) {
      Object.assign(scope, result.response.captured)
      Object.assign(captured, result.response.captured)
      if (opts.stopOnFailure && !result.response.assertions.every((a) => a.pass)) break
    }
  }

  return { steps, captured }
}

/**
 * Like {@link runSequence} but ALSO retains the raw per-hop capture across every step
 * (ADR 0013 Addendum 4, 5f) — for the verify-driven api capture path. Each step's
 * `SequenceStep.result` is UNCHANGED (redacted); `capture` aggregates all hops + the
 * union of run-resolved secret pairs. The transport-completeness guard (every
 * `step.result.sent`) lives in the driver, which folds a non-sent step to inconclusive.
 */
export async function runSequenceForHar(
  collection: Collection,
  names: string[],
  opts: SequenceOptions = {},
): Promise<{ result: SequenceResult; capture: HarCapture }> {
  const scope: Record<string, unknown> = { ...(opts.vars ?? {}) }
  const captured: Record<string, unknown> = {}
  const steps: SequenceStep[] = []
  const capture: HarCapture = { hops: [], registeredSecrets: [], redirectTruncated: false }

  for (const name of names) {
    const { result, capture: hopCap } = await runRequestForHar(collection, name, {
      ...opts,
      vars: scope,
    })
    steps.push({ name, result })
    capture.hops.push(...hopCap.hops)
    capture.registeredSecrets.push(...hopCap.registeredSecrets)
    if (hopCap.redirectTruncated) capture.redirectTruncated = true

    if (result.sent && result.response) {
      Object.assign(scope, result.response.captured)
      Object.assign(captured, result.response.captured)
      if (opts.stopOnFailure && !result.response.assertions.every((a) => a.pass)) break
    }
  }

  return { result: { steps, captured }, capture }
}
