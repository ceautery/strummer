import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { ContractResult } from '@strummer/api'
import {
  type ComposeInputs,
  composeVerdict,
  fromContractResults,
  fromDependencyAudits,
  fromDiffCoverage,
  fromFlakeVerdicts,
  fromMutationSummary,
  type Severity,
} from '@strummer/verdict'
import type { CliIO } from './index.js'

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'none']

/**
 * `verify --contract f --coverage f --deps f --flake f --mutate f [--fail-at-or-above sev]`
 * — fold the per-pillar JSON outputs into one change verdict (ADR 0013 §1). The
 * human is the operator; each flag points at a pillar's JSON result on disk.
 * Exit codes: 0 pass / 1 fail|warn / 2 inconclusive. NO default severity cut.
 */
export function runVerify(args: string[], io: CliIO): number {
  const { values } = parseArgs({
    args,
    options: {
      contract: { type: 'string' },
      source: { type: 'string' },
      coverage: { type: 'string' },
      deps: { type: 'string' },
      'osv-snapshot-loaded': { type: 'boolean' },
      flake: { type: 'string' },
      mutate: { type: 'string' },
      'fail-at-or-above': { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const failAtOrAbove = values['fail-at-or-above']
  if (failAtOrAbove !== undefined && !SEVERITIES.includes(failAtOrAbove)) {
    io.err(`--fail-at-or-above must be one of ${SEVERITIES.join('|')}\n`)
    return 2
  }

  const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
  const inputs: ComposeInputs = {}

  if (values.contract) {
    // Accept either a bare ContractResult[] or a CaptureContractVerdict ({results}).
    const c = readJson(values.contract) as ContractResult[] | { results?: ContractResult[] }
    const results = Array.isArray(c) ? c : (c.results ?? [])
    inputs.contract = fromContractResults(
      results,
      values.source === 'run' ? 'run' : 'capture-from-HAR',
    )
  }
  if (values.coverage) {
    inputs.coverage = fromDiffCoverage(
      readJson(values.coverage) as Parameters<typeof fromDiffCoverage>[0],
    )
  }
  if (values.deps) {
    inputs.deps = fromDependencyAudits(
      readJson(values.deps) as Parameters<typeof fromDependencyAudits>[0],
      { osvSnapshotLoaded: values['osv-snapshot-loaded'] ?? false },
    )
  }
  if (values.flake) {
    inputs.flake = fromFlakeVerdicts(
      readJson(values.flake) as Parameters<typeof fromFlakeVerdicts>[0],
    )
  }
  if (values.mutate) {
    inputs.mutate = fromMutationSummary(
      readJson(values.mutate) as Parameters<typeof fromMutationSummary>[0],
    )
  }

  const verdict = composeVerdict(inputs, { failAtOrAbove: failAtOrAbove as Severity | undefined })

  if (values.json) {
    io.out(`${JSON.stringify(verdict, null, 2)}\n`)
  } else {
    io.out(`verdict: ${verdict.status.toUpperCase()} (worst severity ${verdict.worstSeverity})\n`)
    for (const p of verdict.pillars) {
      const sev = p.severity !== 'none' ? ` [${p.severity}]` : ''
      io.out(`  ${p.pillar}: ${p.status}${sev} — ${p.headline}\n`)
    }
  }

  if (verdict.status === 'pass') return 0
  if (verdict.status === 'inconclusive') return 2
  return 1
}
