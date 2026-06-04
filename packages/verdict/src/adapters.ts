/**
 * The five per-pillar adapters (ADR 0013 §1, slices 8–9). Each maps a pillar's
 * native result onto the shared `PillarVerdict` shape. **Type-only imports** of the
 * pillar result interfaces — `@strummer/verdict` must never import a pillar runtime
 * (that would drag `better-sqlite3`/`playwright-core` in and break the
 * independent-gate posture). The inline severity choices are documented per
 * mapping; the load-bearing rule is that no `no-signal`/absence path ever returns
 * `pass`.
 */
import type { ContractResult } from '@strummer/api'
import type { DiffCoverageReport } from '@strummer/coverage'
import type { DependencyAudit } from '@strummer/deps'
import type { FlakeVerdict } from '@strummer/flake'
import type { MutationSummary } from '@strummer/mutate'
import { maxSeverity, type Severity } from './severity.js'
import type { PillarVerdict } from './types.js'

/** Contract drift over validated responses (live run or capture-from-HAR). */
export function fromContractResults(
  results: ContractResult[],
  source: 'run' | 'capture-from-HAR' = 'capture-from-HAR',
): PillarVerdict {
  if (results.length === 0) {
    // Zero entries validated = no signal, NOT a pass (ADR 0013 §1).
    return {
      pillar: 'contract',
      status: 'no-signal',
      severity: 'none',
      headline: 'no contract entries validated',
      source,
    }
  }
  let errors = 0
  let warnings = 0
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === 'error') errors++
      else warnings++
    }
  }
  if (errors > 0) {
    // A response-schema violation / undocumented operation is a real breach → high.
    return {
      pillar: 'contract',
      status: 'fail',
      severity: 'high',
      headline: `${errors} contract error(s) across ${results.length} response(s)`,
      counts: { errors, warnings, entries: results.length },
      source,
    }
  }
  if (warnings > 0) {
    return {
      pillar: 'contract',
      status: 'warn',
      severity: 'low',
      headline: `${warnings} contract warning(s)`,
      counts: { errors, warnings, entries: results.length },
      source,
    }
  }
  return {
    pillar: 'contract',
    status: 'pass',
    severity: 'none',
    headline: `${results.length} response(s) match the contract`,
    counts: { errors, warnings, entries: results.length },
    source,
  }
}

/**
 * The capture-verdict facts a contract sub-verdict needs to fold WITHOUT laundering an
 * unverifiable entry into a pass (5f, ADR 0013 Addendum 4). A superset of
 * `@strummer/api`'s `CaptureContractVerdict` — its no-signal/unresolved entries push NO
 * `ContractResult`, so `fromContractResults` (results-only) can't see them. `clean` is
 * the load-bearing flag (`entriesValidated>0 ∧ unresolvedBodies===0 ∧ noSignal===0 ∧ all
 * valid`).
 */
export interface CaptureVerdictFacts {
  results: ContractResult[]
  clean: boolean
  noSignal: number
  unresolvedBodies: number
  entriesValidated: number
}

/**
 * Fold the FULL capture verdict (clean-aware): an error finding is a real breach (`fail`);
 * else a NOT-clean capture (no-signal / unresolved / zero validated) is `no-signal`
 * (inconclusive) — NEVER a pass riding on a sibling valid entry (ADR 0013 §1, the latent
 * hole this closes in the shipped 5e produce + consume paths); else a warning is `warn`;
 * else `pass`. Used by the verify orchestrator for the consume + both produce capture paths.
 */
export function fromCaptureVerdict(
  v: CaptureVerdictFacts,
  source: 'run' | 'capture-from-HAR' = 'capture-from-HAR',
): PillarVerdict {
  let errors = 0
  let warnings = 0
  for (const r of v.results) {
    for (const f of r.findings) {
      if (f.severity === 'error') errors++
      else warnings++
    }
  }
  if (errors > 0) {
    return {
      pillar: 'contract',
      status: 'fail',
      severity: 'high',
      headline: `${errors} contract error(s) across ${v.entriesValidated} response(s)`,
      counts: { errors, warnings, entries: v.entriesValidated },
      source,
    }
  }
  if (!v.clean) {
    const headline =
      v.entriesValidated === 0
        ? 'no contract entries validated'
        : v.unresolvedBodies > 0
          ? `${v.unresolvedBodies} captured body(ies) could not be resolved`
          : `${v.noSignal} captured entr(ies) had no matching contract`
    return { pillar: 'contract', status: 'no-signal', severity: 'none', headline, source }
  }
  if (warnings > 0) {
    return {
      pillar: 'contract',
      status: 'warn',
      severity: 'low',
      headline: `${warnings} contract warning(s)`,
      counts: { errors, warnings, entries: v.entriesValidated },
      source,
    }
  }
  return {
    pillar: 'contract',
    status: 'pass',
    severity: 'none',
    headline: `${v.entriesValidated} response(s) match the contract`,
    counts: { errors, warnings, entries: v.entriesValidated },
    source,
  }
}

/** Coverage of a diff — the forgotten-assertion catch. */
export function fromDiffCoverage(report: DiffCoverageReport): PillarVerdict {
  const { summary, uncovered } = report
  if (summary.total === 0) {
    // No new executable lines were classified — nothing to assert on.
    return {
      pillar: 'coverage',
      status: 'no-signal',
      severity: 'none',
      headline: 'no new executable lines classified',
      counts: { filesWithoutCoverage: summary.filesWithoutCoverage },
    }
  }
  if (uncovered.length > 0) {
    // A new executable line with no covering test under a TDD gate is a real gap,
    // but not a security-grade severity → moderate.
    return {
      pillar: 'coverage',
      status: 'fail',
      severity: 'moderate',
      headline: `${uncovered.length} uncovered new line(s)`,
      counts: {
        uncovered: uncovered.length,
        covered: summary.covered,
        filesWithoutCoverage: summary.filesWithoutCoverage,
      },
    }
  }
  return {
    pillar: 'coverage',
    status: 'pass',
    severity: 'none',
    headline: `all ${summary.covered} new executable line(s) covered`,
    counts: { covered: summary.covered },
  }
}

/** deps' `SeverityBucket` → the shared scale. `'unknown'` is NOT a severity here. */
function bucketToSeverity(bucket: DependencyAudit['worstSeverity']): Severity | 'unknown' {
  switch (bucket) {
    case 'critical':
    case 'high':
    case 'moderate':
    case 'low':
    case 'none':
      return bucket
    default:
      // 'unknown' — never silently map to low/none (ADR 0013 slice 8 invariant).
      return 'unknown'
  }
}

/** Dependency vulnerability/deprecation audit over the installed versions. */
export function fromDependencyAudits(
  audits: DependencyAudit[],
  opts: { osvSnapshotLoaded: boolean },
): PillarVerdict {
  if (!opts.osvSnapshotLoaded) {
    // "No known vulnerabilities" without a snapshot is not authoritative — no-signal,
    // never a pass (deps' own `osvSnapshotLoaded:false` honesty; ADR 0013 §1).
    return {
      pillar: 'deps',
      status: 'no-signal',
      severity: 'none',
      headline: 'no OSV snapshot loaded — vulnerability status unknown',
      counts: { packages: audits.length },
    }
  }
  let worst: Severity = 'none'
  let hasUnknown = false
  let vulnerable = 0
  let deprecated = 0
  for (const a of audits) {
    const sev = bucketToSeverity(a.worstSeverity)
    if (sev === 'unknown') hasUnknown = true
    else {
      worst = maxSeverity(worst, sev)
      if (sev !== 'none') vulnerable++
    }
    if (a.deprecated.isDeprecated) deprecated++
  }
  const counts = { packages: audits.length, vulnerable, deprecated }
  if (worst !== 'none') {
    // A real, severity-rated vulnerability — `warn` here; the caller's policy decides
    // whether that severity escalates the whole verdict to `fail`.
    return {
      pillar: 'deps',
      status: 'warn',
      severity: worst,
      headline: `${vulnerable} vulnerable package(s), worst ${worst}`,
      counts,
    }
  }
  if (deprecated > 0) {
    return {
      pillar: 'deps',
      status: 'warn',
      severity: 'low',
      headline: `${deprecated} deprecated package(s)`,
      counts,
    }
  }
  if (hasUnknown) {
    // Some advisory severity could not be determined — not clean, not a pass.
    return {
      pillar: 'deps',
      status: 'no-signal',
      severity: 'none',
      headline: 'a matched advisory has an undetermined severity',
      counts,
    }
  }
  return {
    pillar: 'deps',
    status: 'pass',
    severity: 'none',
    headline: `${audits.length} package(s) clean`,
    counts,
  }
}

/** Severity of a flaky test scaled by its conservative flake magnitude. */
function flakeSeverity(flakeScore: number): Severity {
  if (flakeScore >= 0.5) return 'high'
  if (flakeScore >= 0.2) return 'moderate'
  return 'low'
}

/** Flaky/broken test detection over recorded run histories. */
export function fromFlakeVerdicts(verdicts: FlakeVerdict[]): PillarVerdict {
  if (verdicts.length === 0) {
    return {
      pillar: 'flake',
      status: 'no-signal',
      severity: 'none',
      headline: 'no test histories supplied',
    }
  }
  let broken = 0
  let flaky = 0
  let reliable = 0
  let insufficient = 0
  let worstFlakeScore = 0
  for (const v of verdicts) {
    switch (v.state) {
      case 'broken':
        broken++
        break
      case 'flaky':
        flaky++
        worstFlakeScore = Math.max(worstFlakeScore, v.flakeScore)
        break
      case 'reliable':
        reliable++
        break
      default:
        insufficient++
    }
  }
  const counts = { broken, flaky, reliable, insufficientData: insufficient, total: verdicts.length }
  if (broken > 0) {
    // A consistently-failing test is a real failure → high.
    return {
      pillar: 'flake',
      status: 'fail',
      severity: 'high',
      headline: `${broken} broken test(s)`,
      counts,
    }
  }
  if (flaky > 0) {
    return {
      pillar: 'flake',
      status: 'warn',
      severity: flakeSeverity(worstFlakeScore),
      headline: `${flaky} flaky test(s)`,
      counts,
    }
  }
  if (insufficient > 0) {
    // Not enough runs to call the rest reliable — no-signal, never a pass.
    return {
      pillar: 'flake',
      status: 'no-signal',
      severity: 'none',
      headline: `${insufficient} test(s) with insufficient run history`,
      counts,
    }
  }
  return {
    pillar: 'flake',
    status: 'pass',
    severity: 'none',
    headline: `${reliable} reliable test(s)`,
    counts,
  }
}

/** Mutation testing — are the tests meaningful? Keyed off survivors, not only score. */
export function fromMutationSummary(summary: MutationSummary): PillarVerdict {
  const survivors = summary.survivors.length
  // No valid mutants AND nothing survived = nothing ran meaningfully → no-signal.
  // (Keying only off `mutationScore===null` would launder a real gap — ADR slice 9.)
  if (summary.metrics.mutationScore === null && survivors === 0) {
    return {
      pillar: 'mutate',
      status: 'no-signal',
      severity: 'none',
      headline: 'no valid mutants evaluated',
    }
  }
  if (survivors > 0) {
    // Surviving / never-covered mutants are the actionable test gap → moderate.
    return {
      pillar: 'mutate',
      status: 'warn',
      severity: 'moderate',
      headline: `${survivors} surviving mutant(s)`,
      counts: { survivors, valid: summary.metrics.valid },
    }
  }
  return {
    pillar: 'mutate',
    status: 'pass',
    severity: 'none',
    headline: 'all valid mutants detected',
    counts: { survivors: 0, valid: summary.metrics.valid },
  }
}
