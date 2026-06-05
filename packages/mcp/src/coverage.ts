import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type CoveragePyReport,
  coveragePyToIstanbul,
  type FileCoverage,
  runScoped,
  runScopedPython,
  type TestRunner,
  uncoveredInDiff,
} from '@sackville/coverage'
import { z } from 'zod'

export interface CoverageToolsOptions {
  /** OPERATOR: enable `run_scoped` (deny-by-default — it executes the project's tests). */
  allowRun?: boolean
  /** OPERATOR: project roots `run_scoped` may execute in (load-bearing even with allowRun). */
  allowedRoots?: string[]
  /** OPERATOR: wall-clock cap for a scoped run (ms). */
  timeoutMs?: number
  /** Injected test runner (tests); defaults to the live vitest subprocess in the bin. */
  runner?: TestRunner
}

const INSTRUCTIONS = `Sackville reports test coverage scoped to a change — the "forgotten
assertion" catch: of the lines a diff ADDED, which executable ones did no test exercise.

\`uncovered_in_diff\` is a free, read-only analysis: give it a unified diff and a coverage
report (inline or by path) and it returns the uncovered new lines. \`coverageFormat\` selects
the report shape — \`istanbul\` (a \`coverage-final.json\`, the default) or \`coveragepy\` (a
Python \`coverage json\` report, converted to the same line model). It does NOT run anything.
\`run_scoped\` (only present when the operator enabled it) actually runs
the tests a change touches (\`vitest related\`) with coverage and then analyses the diff —
that is operator-gated and confined to allowlisted project roots.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

/** Register the coverage tools onto a server. `run_scoped` is registered only when enabled. */
export function registerCoverageTools(server: McpServer, opts: CoverageToolsOptions = {}): void {
  server.registerTool(
    'uncovered_in_diff',
    {
      title: 'Uncovered new lines in a diff',
      description:
        'READ-ONLY: given a unified diff and a coverage report, report the lines the diff ' +
        'added that are executable but unhit (the forgotten-assertion catch). Supply the diff ' +
        'inline (`diff`) or by path (`diffPath`), and coverage inline (`coverage`) or by path ' +
        '(`coveragePath`). `coverageFormat` is `istanbul` (a coverage-final.json, default) or ' +
        '`coveragepy` (a Python `coverage json` report). Runs nothing.',
      inputSchema: {
        diff: z.string().optional().describe('unified diff text'),
        diffPath: z.string().optional().describe('path to a unified diff file'),
        coverage: z.unknown().optional().describe('inline coverage report object'),
        coveragePath: z.string().optional().describe('path to a coverage report JSON'),
        coverageFormat: z
          .enum(['istanbul', 'coveragepy'])
          .optional()
          .describe('coverage report shape (default istanbul)'),
        projectRoot: z
          .string()
          .optional()
          .describe('absolute project root, for exact diff-path↔coverage-key resolution'),
      },
    },
    (args) => {
      const diff = args.diff ?? (args.diffPath ? readFileSync(args.diffPath, 'utf8') : undefined)
      if (diff === undefined) {
        throw new Error('supply `diff` or `diffPath`')
      }
      const raw =
        args.coverage ??
        (args.coveragePath ? JSON.parse(readFileSync(args.coveragePath, 'utf8')) : undefined)
      if (raw === undefined) {
        throw new Error('supply `coverage` or `coveragePath`')
      }
      const coverage =
        args.coverageFormat === 'coveragepy'
          ? coveragePyToIstanbul(raw as CoveragePyReport)
          : (raw as Record<string, FileCoverage>)
      const report = uncoveredInDiff(diff, coverage, { projectRoot: args.projectRoot })
      return { content: [text(report)], structuredContent: { ...report } }
    },
  )

  // run_scoped executes tests, so it is registered only when the operator has enabled it
  // (allowRun) AND supplied a non-empty root allowlist — deny-by-default.
  const allowedRoots = opts.allowedRoots ?? []
  if (opts.allowRun && allowedRoots.length > 0) {
    server.registerTool(
      'run_scoped',
      {
        title: 'Run the tests a change touches',
        description:
          'Run only the tests related to the changed files (vitest related) WITH coverage, ' +
          'then report the uncovered new lines for the supplied diff. Operator-gated and ' +
          'confined to allowlisted project roots. Returns a compact result (no inlined ' +
          'coverage map); the full coverage-final.json path is included.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          changedFiles: z
            .array(z.string())
            .describe('changed source files to scope the test selection to'),
          diff: z.string().optional().describe('unified diff to analyse against the new coverage'),
          diffPath: z.string().optional().describe('path to a unified diff file'),
        },
      },
      async (args) => {
        const diff = args.diff ?? (args.diffPath ? readFileSync(args.diffPath, 'utf8') : undefined)
        const result = await runScoped(
          {
            projectRoot: args.projectRoot,
            allowedRoots,
            allowRun: true,
            timeoutMs: opts.timeoutMs,
          },
          { changedFiles: args.changedFiles, diff },
          { runner: opts.runner },
        )
        // Compact result: omit the full coverage map (large); keep the diff-bounded report.
        const structured = {
          ran: result.ran,
          passed: result.passed,
          exitCode: result.exitCode,
          scopedFiles: result.scopedFiles,
          coveragePath: result.coveragePath,
          report: result.report,
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )

    server.registerTool(
      'py_run_scoped',
      {
        title: 'Run the Python tests a change touches (pytest + coverage.py)',
        description:
          'Run only the pytest tests related to the changed files WITH coverage.py, then report ' +
          'the uncovered new lines for the supplied diff. `measureTargets` are the coverage.py ' +
          '`--cov` targets. When a changed source maps to no test, `scopeMode` chooses report-gap ' +
          '(default — report the gap, run matched tests) or widen (run the whole suite). pytest ' +
          '"no tests collected" is reported as inconclusive, never a clean pass. Operator-gated.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          changedFiles: z
            .array(z.string())
            .describe('changed source files to scope the test selection to'),
          measureTargets: z.array(z.string()).describe('coverage.py --cov targets (package/path)'),
          scopeMode: z
            .enum(['report-gap', 'widen'])
            .optional()
            .describe('no-test fallback (default report-gap)'),
          diff: z.string().optional().describe('unified diff to analyse against the new coverage'),
          diffPath: z.string().optional().describe('path to a unified diff file'),
        },
      },
      async (args) => {
        const diff = args.diff ?? (args.diffPath ? readFileSync(args.diffPath, 'utf8') : undefined)
        const result = await runScopedPython(
          {
            projectRoot: args.projectRoot,
            allowedRoots,
            allowRun: true,
            timeoutMs: opts.timeoutMs,
          },
          {
            changedFiles: args.changedFiles,
            diff,
            measureTargets: args.measureTargets,
            scopeMode: args.scopeMode,
          },
          { runner: opts.runner },
        )
        const structured = {
          ran: result.ran,
          passed: result.passed,
          inconclusive: result.inconclusive,
          exitCode: result.exitCode,
          scopedFiles: result.scopedFiles,
          unmatched: result.unmatched,
          widened: result.widened,
          coveragePath: result.coveragePath,
          report: result.report,
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )
  }
}

/** Build a standalone Sackville coverage MCP server. */
export function createCoverageServer(opts: CoverageToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'sackville-coverage', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerCoverageTools(server, opts)
  return server
}
