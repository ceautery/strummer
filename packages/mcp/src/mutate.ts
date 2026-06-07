import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  changedLinesFromDiff,
  type MutationReport,
  type MutationRunner,
  parseMutmutResults,
  runCosmicRay,
  runMutation,
  runMutmut,
  summarizeMutation,
} from '@sackville-mcp/mutate'
import { z } from 'zod'

export interface MutateToolsOptions {
  /** OPERATOR: enable `mutate_run` (deny-by-default — it runs Stryker over the project). */
  allowRun?: boolean
  /** OPERATOR: project roots `mutate_run` may execute in (load-bearing even with allowRun). */
  allowedRoots?: string[]
  /** OPERATOR: wall-clock cap for a mutation run (ms). */
  timeoutMs?: number
  /** OPERATOR: override the Stryker JSON report path (default <root>/reports/mutation/mutation.json). */
  reportPath?: string
  /** Injected mutation runner (tests); defaults to the live stryker subprocess in the bin. */
  runner?: MutationRunner
}

const INSTRUCTIONS = `Sackville reports mutation-testing results — are the tests MEANINGFUL,
not just present? A surviving mutant is a code change no test caught: a passing-but-vacuous
assertion. This is the complement to the coverage pillar's forgotten-assertion catch.

\`mutate_summarize\` is a free, read-only analysis: mutation score, the killed/survived/
no-coverage breakdown, and the actionable survivor list. \`format\` selects the input — \`stryker\`
(a mutation-report.json object, the default) or \`mutmut\` (the text of \`mutmut results --all true\`,
the Python tool). It runs nothing. \`mutate_run\` (present only when the operator enabled it)
actually runs Stryker — slow and operator-gated, confined to allowlisted roots, and
diff-scopable via \`mutateFiles\`/\`incremental\`.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

/** Register the mutate tools. `mutate_summarize` is always present; `mutate_run` is gated. */
export function registerMutateTools(server: McpServer, opts: MutateToolsOptions = {}): void {
  server.registerTool(
    'mutate_summarize',
    {
      title: 'Summarize a mutation report',
      description:
        'READ-ONLY: summarize a mutation report (supply inline `report` or a `reportPath`) — ' +
        'mutation score, status breakdown, per-file metrics, and the survivor list (Survived + ' +
        'NoCoverage, the test gaps to fix). `format` is `stryker` (a mutation-report.json, the ' +
        'default) or `mutmut` (the text of `mutmut results --all true`). Runs nothing.',
      inputSchema: {
        report: z
          .unknown()
          .optional()
          .describe(
            'inline report: a Stryker report object, or mutmut results text (format=mutmut)',
          ),
        reportPath: z
          .string()
          .optional()
          .describe('path to the report (JSON for stryker, text for mutmut)'),
        format: z
          .enum(['stryker', 'mutmut'])
          .optional()
          .describe('report format (default stryker)'),
      },
    },
    (args) => {
      let report: MutationReport
      if (args.format === 'mutmut') {
        const raw =
          typeof args.report === 'string'
            ? args.report
            : args.reportPath
              ? readFileSync(args.reportPath, 'utf8')
              : undefined
        if (raw === undefined) {
          throw new Error('supply mutmut `report` text or `reportPath`')
        }
        report = parseMutmutResults(raw)
      } else {
        const r =
          (args.report as MutationReport | undefined) ??
          (args.reportPath
            ? (JSON.parse(readFileSync(args.reportPath, 'utf8')) as MutationReport)
            : undefined)
        if (r === undefined) {
          throw new Error('supply `report` or `reportPath`')
        }
        report = r
      }
      const summary = summarizeMutation(report)
      return { content: [text(summary)], structuredContent: { ...summary } }
    },
  )

  // mutate_run runs Stryker, so it is registered only when the operator enabled it
  // (allowRun) AND supplied a non-empty root allowlist — deny-by-default.
  const allowedRoots = opts.allowedRoots ?? []
  if (opts.allowRun && allowedRoots.length > 0) {
    server.registerTool(
      'mutate_run',
      {
        title: 'Run mutation testing',
        description:
          'Run a mutation tool over the project (slow — the suite re-runs per mutant), then ' +
          'summarize. `tool` is `stryker` (JS, default), `mutmut`, or `cosmic-ray` (Python — its ' +
          'dump carries real file:line:operator). Operator-gated and confined to allowlisted ' +
          'roots. Stryker diff-scopes with `mutateFiles`/`incremental`; cosmic-ray reads an ' +
          'operator config (`configPath`, default cosmic-ray.toml). Returns a compact summary.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          tool: z
            .enum(['stryker', 'mutmut', 'cosmic-ray'])
            .optional()
            .describe('mutation tool (default stryker)'),
          mutateFiles: z
            .array(z.string())
            .optional()
            .describe('changed source files to scope mutation to (Stryker)'),
          incremental: z.boolean().optional().describe("reuse Stryker's incremental cache"),
          configPath: z
            .string()
            .optional()
            .describe('cosmic-ray config path relative to projectRoot (default cosmic-ray.toml)'),
          diff: z
            .string()
            .optional()
            .describe(
              'unified diff: line-scopes the cosmic-ray summary to changed lines (cr-filter-git parity, cosmic-ray only)',
            ),
        },
      },
      async (args) => {
        const config = {
          projectRoot: args.projectRoot,
          allowedRoots,
          allowRun: true,
          timeoutMs: opts.timeoutMs,
        }
        const input = {
          mutateFiles: args.mutateFiles,
          incremental: args.incremental,
          configPath: args.configPath,
          // cosmic-ray line-scopes its summary to the diff's changed lines (cr-filter-git parity);
          // other tools have no per-line dump, so this is a cosmic-ray-only refinement.
          ...(args.tool === 'cosmic-ray' && args.diff
            ? { changedLines: changedLinesFromDiff(args.diff) }
            : {}),
        }
        const result =
          args.tool === 'mutmut'
            ? await runMutmut(config, input, { runner: opts.runner })
            : args.tool === 'cosmic-ray'
              ? await runCosmicRay(config, input, { runner: opts.runner })
              : await runMutation(config, input, {
                  runner: opts.runner,
                  reportPath: opts.reportPath,
                })
        const structured = {
          ran: result.ran,
          exitCode: result.exitCode,
          scopedFiles: result.scopedFiles,
          reportPath: result.reportPath,
          metrics: result.summary.metrics,
          survivors: result.summary.survivors,
          ...(result.lineScoped ? { lineScoped: true } : {}),
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )
  }
}

/** Build a standalone Sackville mutate MCP server. */
export function createMutateServer(opts: MutateToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'sackville-mutate', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerMutateTools(server, opts)
  return server
}
