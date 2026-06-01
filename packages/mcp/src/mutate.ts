import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type MutationReport,
  type MutationRunner,
  runMutation,
  summarizeMutation,
} from '@strummer/mutate'
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

const INSTRUCTIONS = `Strummer reports mutation-testing results — are the tests MEANINGFUL,
not just present? A surviving mutant is a code change no test caught: a passing-but-vacuous
assertion. This is the complement to the coverage pillar's forgotten-assertion catch.

\`mutate_summarize\` is a free, read-only analysis of a Stryker mutation-report.json (inline
or by path): mutation score, the killed/survived/no-coverage breakdown, and the actionable
survivor list. It runs nothing. \`mutate_run\` (present only when the operator enabled it)
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
        'READ-ONLY: summarize a Stryker mutation-report.json (supply inline `report` or a ' +
        '`reportPath`) — mutation score, status breakdown, per-file metrics, and the ' +
        'survivor list (Survived + NoCoverage, the test gaps to fix). Runs nothing.',
      inputSchema: {
        report: z.unknown().optional().describe('inline mutation-testing-elements report object'),
        reportPath: z.string().optional().describe('path to a mutation-report.json'),
      },
    },
    (args) => {
      const report =
        (args.report as MutationReport | undefined) ??
        (args.reportPath
          ? (JSON.parse(readFileSync(args.reportPath, 'utf8')) as MutationReport)
          : undefined)
      if (report === undefined) {
        throw new Error('supply `report` or `reportPath`')
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
          'Run Stryker over the project (slow — the suite re-runs per mutant), then summarize. ' +
          'Operator-gated and confined to allowlisted roots. Diff-scope with `mutateFiles` ' +
          '(changed source files → Stryker --mutate) and `incremental`. Returns a compact ' +
          'summary (no full report inlined); the report path is included.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          mutateFiles: z
            .array(z.string())
            .optional()
            .describe('changed source files to scope mutation to'),
          incremental: z.boolean().optional().describe("reuse Stryker's incremental cache"),
        },
      },
      async (args) => {
        const result = await runMutation(
          {
            projectRoot: args.projectRoot,
            allowedRoots,
            allowRun: true,
            timeoutMs: opts.timeoutMs,
          },
          { mutateFiles: args.mutateFiles, incremental: args.incremental },
          { runner: opts.runner, reportPath: opts.reportPath },
        )
        const structured = {
          ran: result.ran,
          exitCode: result.exitCode,
          scopedFiles: result.scopedFiles,
          reportPath: result.reportPath,
          metrics: result.summary.metrics,
          survivors: result.summary.survivors,
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )
  }
}

/** Build a standalone Strummer mutate MCP server. */
export function createMutateServer(opts: MutateToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'strummer-mutate', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerMutateTools(server, opts)
  return server
}
