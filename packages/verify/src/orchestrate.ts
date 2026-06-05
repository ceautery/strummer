import { randomUUID } from 'node:crypto'
import type { ContractResult } from '@sackville-mcp/api'
import type { DiffCoverageReport } from '@sackville-mcp/coverage'
import type { DependencyAudit } from '@sackville-mcp/deps'
import type { FlakeVerdict } from '@sackville-mcp/flake'
import type { MutationSummary } from '@sackville-mcp/mutate'
import {
  type CaptureVerdictFacts,
  type ComposeInputs,
  type CompositeVerdict,
  composeVerdict,
  fromCaptureVerdict,
  fromContractResults,
  fromDependencyAudits,
  fromDiffCoverage,
  fromFlakeVerdicts,
  fromMutationSummary,
  type PillarName,
  type PillarVerdict,
  type VerdictPolicy,
} from '@sackville-mcp/verdict'
import { isGateDenial } from './gate.js'

/**
 * Per-pillar run request. Each present pillar carries an async `run` thunk that
 * produces that pillar's NATIVE result — the orchestrator maps it via the existing
 * `@sackville-mcp/verdict` `from*` adapter. The thunk is wired by the surface (bin/CLI)
 * to the pillar's own gated runner, so `@sackville-mcp/verify` itself imports zero
 * spawn-capable engine code (§ gate (e)). A rejection branded as a gate denial maps
 * to `skipReason:'gate-not-set'`; any other rejection to a redacted `errorReason`.
 */
export interface OrchestrateRequest {
  /** The contract thunk returns EITHER the bare results (compose path — folded by
   * `fromContractResults`) OR the FULL capture verdict facts (consume / produce paths —
   * folded by `fromCaptureVerdict` so a not-`clean` capture is inconclusive, never a pass;
   * 5f, ADR 0013 Addendum 4). */
  contract?: {
    run: () => Promise<ContractResult[] | CaptureVerdictFacts>
    source?: 'run' | 'capture-from-HAR'
  }
  coverage?: { run: () => Promise<DiffCoverageReport> }
  deps?: { run: () => Promise<{ audits: DependencyAudit[]; osvSnapshotLoaded: boolean }> }
  flake?: { run: () => Promise<FlakeVerdict[]> }
  mutate?: { run: () => Promise<MutationSummary> }
}

export interface OrchestrateOptions {
  /** The policy cut threaded straight through to `composeVerdict` (no default). */
  policy?: VerdictPolicy
  /** Mint the verdict id (default `randomUUID`); tests inject a deterministic stub. */
  idFactory?: () => string
  /** Redact a string before it enters the verdict (default identity). */
  redact?: (value: string) => string
}

export interface OrchestrateResult {
  /** The id under which the surface stores the full verdict by handle. */
  id: string
  verdict: CompositeVerdict
}

/**
 * Drive the requested pillars and fold them into one `CompositeVerdict` (ADR 0013
 * Addendum, milestone 5c). Each requested pillar's `run` thunk is invoked
 * concurrently; each task catches its own rejection (the per-pillar failure
 * isolation `Promise.allSettled` gives) so one pillar's crash/timeout never sinks the
 * verdict. A fulfilled run is mapped through the existing `from*` adapter; a rejected
 * run becomes a `no-signal` contributor: a branded gate denial ⇒
 * `skipReason:'gate-not-set'` (never run), any other crash ⇒ a **redacted**
 * `errorReason`. Pillars not in the request are folded as `missing`. "Absence is
 * never a pass" therefore holds for skipped/errored/missing pillars for free (all
 * fold to `inconclusive`).
 *
 * Pure orchestration: the `run` thunks (wired by the surface to each pillar's own
 * gated runner) are the only side-effecting code; this module imports no engine
 * runtime — gate denials are recognized structurally via the global-symbol brand.
 */
export async function orchestrate(
  request: OrchestrateRequest,
  options: OrchestrateOptions = {},
): Promise<OrchestrateResult> {
  const idFactory = options.idFactory ?? randomUUID
  const redact = options.redact ?? ((value: string) => value)

  // One labelled task per requested pillar, each composing the pillar's native
  // `run` thunk with its `from*` adapter. Each task catches its OWN rejection and
  // resolves to a skipped (gate-denied) or errored contributor — so the concurrent
  // `Promise.all` never rejects (the same per-pillar failure isolation
  // `Promise.allSettled` gives), while the pillar label rides along with each result.
  const tasks: Array<Promise<{ pillar: PillarName; verdict: PillarVerdict }>> = []
  const add = (pillar: PillarName, produce: () => Promise<PillarVerdict>): void => {
    tasks.push(
      produce()
        .then((verdict) => ({ pillar, verdict }))
        .catch((reason: unknown) => ({
          pillar,
          verdict: rejectionToPillar(pillar, reason, redact),
        })),
    )
  }

  if (request.contract) {
    const { run, source } = request.contract
    add('contract', () =>
      run().then((r) =>
        Array.isArray(r) ? fromContractResults(r, source) : fromCaptureVerdict(r, source),
      ),
    )
  }
  if (request.coverage) {
    const { run } = request.coverage
    add('coverage', () => run().then(fromDiffCoverage))
  }
  if (request.deps) {
    const { run } = request.deps
    add('deps', () =>
      run().then((r) => fromDependencyAudits(r.audits, { osvSnapshotLoaded: r.osvSnapshotLoaded })),
    )
  }
  if (request.flake) {
    const { run } = request.flake
    add('flake', () => run().then(fromFlakeVerdicts))
  }
  if (request.mutate) {
    const { run } = request.mutate
    add('mutate', () => run().then(fromMutationSummary))
  }

  const inputs: ComposeInputs = {}
  for (const { pillar, verdict } of await Promise.all(tasks)) {
    inputs[pillar] = verdict
  }

  return { id: idFactory(), verdict: composeVerdict(inputs, options.policy) }
}

/**
 * Map a rejected pillar run to its `no-signal` contributor — never a pass (ADR 0013
 * Addendum, milestone 5c). "Compose, never widen": a rejection BRANDED as a gate
 * denial (the pillar's own `assertAllowed`, or the surface's no-fetcher/no-DB check)
 * becomes `skipReason:'gate-not-set'` — the pillar was never run, surfaced, and its
 * raw message is dropped (a skip needs no detail and must not leak a path). Any other
 * rejection is a genuine crash ⇒ `errorReason`, with the message **redacted**.
 */
function rejectionToPillar(
  pillar: PillarName,
  reason: unknown,
  redact: (value: string) => string,
): PillarVerdict {
  if (isGateDenial(reason)) {
    return {
      pillar,
      status: 'no-signal',
      severity: 'none',
      headline: `${pillar} gate not set — pillar not run`,
      skipReason: 'gate-not-set',
    }
  }
  const message = reason instanceof Error ? reason.message : String(reason)
  return {
    pillar,
    status: 'no-signal',
    severity: 'none',
    headline: 'pillar run failed',
    errorReason: redact(message),
  }
}

export type { PillarName, PillarVerdict }
