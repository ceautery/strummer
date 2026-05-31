import type { Collection, RunResult } from './model.js'
import { type RunOptions, runRequest } from './runner.js'

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
