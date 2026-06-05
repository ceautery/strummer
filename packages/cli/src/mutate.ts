import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  MutateGateError,
  type MutationReport,
  type MutationRunner,
  type MutationSummary,
  parseMutmutResults,
  runCosmicRay,
  runMutation,
  runMutmut,
  summarizeMutation,
} from '@sackville-mcp/mutate'
import type { CliIO } from './index.js'

/**
 * `sackville mutate` — the human surface over `@sackville-mcp/mutate`.
 *
 * `summarize` is a pure report viewer (Stryker JSON or `mutmut results` text). `run` is the
 * gated, diff-scopable mutation run. The CLI's human IS the operator, so the run gate is a
 * straight-through `--allow-run` flag (mirroring `sackville api --unsafe`): the typed project
 * root is auto-allowed (explicit operator intent). The `runner` is injectable so the suite
 * never spawns a real Stryker (ADR 0010: no real spawn in the gate).
 */
export async function runMutate(
  args: string[],
  io: CliIO,
  deps: { runner?: MutationRunner } = {},
): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'summarize':
      return cmdSummarize(rest, io)
    case 'run':
      return cmdRun(rest, io, deps)
    default:
      io.err(`unknown mutate subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
}

/** Format a percent metric (`null` ⇒ not applicable, e.g. zero valid mutants). */
function pct(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(1)}%`
}

function printSummary(io: CliIO, summary: MutationSummary): void {
  const { metrics, survivors } = summary
  const c = metrics.counts
  io.out(
    `mutation score: ${pct(metrics.mutationScore)}  (detected ${metrics.detected} / valid ${metrics.valid})\n`,
  )
  io.out(`covered-code score: ${pct(metrics.mutationScoreBasedOnCoveredCode)}\n`)
  io.out(
    `killed ${c.killed}  survived ${c.survived}  timeout ${c.timeout}  no-coverage ${c.noCoverage}  ` +
      `compile-errors ${c.compileErrors}  runtime-errors ${c.runtimeErrors}  ignored ${c.ignored}  pending ${c.pending}\n`,
  )
  if (survivors.length === 0) {
    io.out('survivors: (none)\n')
    return
  }
  io.out(`survivors (${survivors.length}):\n`)
  for (const s of survivors) {
    io.out(`  ${s.file}:${s.line}  ${s.mutatorName}  [${s.status}]\n`)
  }
}

function cmdSummarize(args: string[], io: CliIO): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { format: { type: 'string' }, json: { type: 'boolean' } },
  })
  const reportFile = positionals[0]
  if (!reportFile) {
    io.err('mutate summarize needs a <report-file>\n')
    return 1
  }
  const format = values.format ?? 'stryker'
  if (format !== 'stryker' && format !== 'mutmut') {
    io.err(`unknown report format: ${format} (expected stryker|mutmut)\n`)
    return 1
  }
  const text = readFileSync(reportFile, 'utf8')
  // mutmut emits plain `module.fn__mutmut_N: status` lines; Stryker emits the
  // mutation-testing-elements JSON. Both normalize to a MutationReport.
  const report: MutationReport =
    format === 'mutmut' ? parseMutmutResults(text) : (JSON.parse(text) as MutationReport)
  const summary = summarizeMutation(report)

  if (values.json) {
    io.out(`${JSON.stringify(summary, null, 2)}\n`)
    return 0
  }
  printSummary(io, summary)
  return 0
}

async function cmdRun(
  args: string[],
  io: CliIO,
  deps: { runner?: MutationRunner },
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tool: { type: 'string' },
      file: { type: 'string', multiple: true },
      incremental: { type: 'boolean' },
      'config-path': { type: 'string' },
      'allow-run': { type: 'boolean' },
      'timeout-ms': { type: 'string' },
      'report-path': { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const projectRoot = positionals[0]
  if (!projectRoot) {
    io.err('mutate run needs a <project-root>\n')
    return 1
  }
  const tool = values.tool ?? 'stryker'
  if (tool !== 'stryker' && tool !== 'mutmut' && tool !== 'cosmic-ray') {
    io.err(`unknown tool: ${tool} (expected stryker|mutmut|cosmic-ray)\n`)
    return 1
  }
  const timeoutRaw = values['timeout-ms']
  const timeoutMs = timeoutRaw !== undefined ? Number(timeoutRaw) : undefined

  try {
    const config = {
      projectRoot,
      // The human typed this root, so it is the operator allowlist (explicit intent),
      // exactly as `sackville browser` auto-allows the typed host.
      allowedRoots: [resolve(projectRoot)],
      allowRun: values['allow-run'] ?? false,
      timeoutMs: timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    }
    const input = {
      mutateFiles: values.file,
      incremental: values.incremental ?? false,
      configPath: values['config-path'],
    }
    const result =
      tool === 'mutmut'
        ? await runMutmut(config, input, { runner: deps.runner })
        : tool === 'cosmic-ray'
          ? await runCosmicRay(config, input, { runner: deps.runner })
          : await runMutation(config, input, {
              runner: deps.runner,
              reportPath: values['report-path'],
            })

    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      return result.exitCode === 0 ? 0 : 1
    }
    io.out(
      `ran ${tool} (exit ${result.exitCode}); scoped: ${result.scopedFiles.join(', ') || '(project default)'}\n`,
    )
    printSummary(io, result.summary)
    return result.exitCode === 0 ? 0 : 1
  } catch (e) {
    if (e instanceof MutateGateError) {
      io.err(`refused: ${e.message} (pass --allow-run)\n`)
      return 1
    }
    io.err(`${(e as Error).message}\n`)
    return 1
  }
}
