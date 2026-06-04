import { atLeast, maxSeverity, SEVERITY_RANK, type Severity } from './severity.js'
import type {
  CompositeVerdict,
  OverallStatus,
  PillarName,
  PillarVerdict,
  VerdictPolicy,
} from './types.js'

/** Per-pillar adapter outputs. Any omitted pillar is folded as `missing`. */
export interface ComposeInputs {
  contract?: PillarVerdict
  coverage?: PillarVerdict
  deps?: PillarVerdict
  flake?: PillarVerdict
  mutate?: PillarVerdict
}

/** Stable pillar order for the breakdown + tie-breaking the worst pillar. */
const ORDER: PillarName[] = ['contract', 'coverage', 'deps', 'flake', 'mutate']

function missingPillar(pillar: PillarName): PillarVerdict {
  return { pillar, status: 'missing', severity: 'none', headline: 'no input supplied' }
}

/**
 * Fold the per-pillar verdicts into one composite verdict (ADR 0013 §1). Pure and
 * deterministic. The load-bearing invariant: **absence is never a pass** — an
 * empty fold, or any present `missing`/`no-signal` pillar with no failing/warning
 * signal elsewhere, yields `inconclusive` (`ok:false`), never `pass`.
 *
 * The overall posture has NO baked-in threshold: a pillar only escalates the whole
 * verdict to `fail` either because the pillar itself decided `fail`, or because the
 * caller's `policy.failAtOrAbove` says its severity is failing. With no policy, a
 * severity-only finding stays `warn`.
 */
export function composeVerdict(
  inputs: ComposeInputs,
  policy: VerdictPolicy = {},
): CompositeVerdict {
  const pillars = ORDER.map((name) => inputs[name] ?? missingPillar(name))
  const missing = pillars.filter((p) => p.status === 'missing').map((p) => p.pillar)

  const worstSeverity = maxSeverity(...pillars.map((p) => p.severity))
  // The worst pillar: highest severity, ties broken by ORDER; only when non-`none`.
  let worstPillar: PillarName | undefined
  if (worstSeverity !== 'none') {
    for (const p of pillars) {
      if (SEVERITY_RANK[p.severity] === SEVERITY_RANK[worstSeverity]) {
        worstPillar = p.pillar
        break
      }
    }
  }

  const failsByPolicy = (p: PillarVerdict): boolean =>
    policy.failAtOrAbove !== undefined &&
    (p.status === 'warn' || p.status === 'fail') &&
    atLeast(p.severity, policy.failAtOrAbove)

  const anyFail = pillars.some((p) => p.status === 'fail' || failsByPolicy(p))
  const anyWarn = pillars.some((p) => p.status === 'warn')
  const anyInconclusive = pillars.some((p) => p.status === 'missing' || p.status === 'no-signal')

  let status: OverallStatus
  if (anyFail) status = 'fail'
  else if (anyWarn) status = 'warn'
  else if (anyInconclusive) status = 'inconclusive'
  else status = 'pass'

  return {
    ok: status === 'pass',
    status,
    worstSeverity,
    ...(worstPillar ? { worstPillar } : {}),
    pillars,
    missing,
  }
}

export type { Severity }
