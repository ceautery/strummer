import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type HistoryStore,
  type PytestJsonReport,
  Quarantine,
  type QuarantinePolicy,
  quarantineCandidates,
  type RunHistoryConfig,
  runAndRecord,
  runAndRecordPytest,
  type TestRunner,
  type VitestJsonReport,
} from '@strummer/flake'
import { z } from 'zod'

export interface FlakeToolsOptions {
  /** The open run-history store (operator-provisioned; the bin opens it from a path). */
  store: HistoryStore
  /** OPERATOR run gate. `flake_run` registers only with allowRun AND a non-empty allowlist. */
  runConfig?: { allowRun: boolean; allowedRoots: string[]; timeoutMs?: number }
  /** OPERATOR quarantine gate. `flake_quarantine` registers only with allowQuarantine AND maxExpiryMs>0. */
  quarantinePolicy?: QuarantinePolicy
  /** Injected test runner (tests); the bin wires a live vitest subprocess. */
  runner?: TestRunner
  /** Clock for `now` (tests); defaults to the system clock. */
  now?: () => string
}

const INSTRUCTIONS = `Strummer reports test flakiness from a recorded run history (a private
SQLite store of pass/fail outcomes over time) and lets an operator quarantine a flaky test
for a BOUNDED window.

\`flake_status\` and \`flake_candidates\` are free, read-only: they classify the stored
history (flaky / reliable / broken / insufficient-data) with a Wilson confidence bound
(\`flakeScore\`) and rank quarantine candidates. \`flake_ingest\` records a CI-produced
report (vitest or pytest JSON) into the history store WITHOUT spawning anything — the natural
path when the suite already ran elsewhere (and the only way to feed pytest history). \`flake_release\`
lifts a quarantine (always allowed — it only makes the gate stricter). \`flake_run\` (present
only when the operator enabled it) RUNS the suite repeatedly to gather history; it is gated and
confined to allowlisted roots. \`flake_quarantine\` (present only when enabled) WRITES a quarantine and
requires a bounded, mandatory expiry — it can turn a red gate green, so it is operator-gated.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

/** Trim a verdict to the agent-useful fields (drop the full Wilson object's noise). */
function compactVerdict(v: {
  id: string
  state: string
  runs: number
  failures: number
  failureRate: number
  flakeScore: number
}) {
  return {
    id: v.id,
    state: v.state,
    runs: v.runs,
    failures: v.failures,
    failureRate: Number(v.failureRate.toFixed(4)),
    flakeScore: Number(v.flakeScore.toFixed(4)),
  }
}

/** Register the flake tools. Read tools are always present; run/quarantine are gated. */
export function registerFlakeTools(server: McpServer, opts: FlakeToolsOptions): void {
  const { store } = opts
  const now = opts.now ?? (() => new Date().toISOString())
  // A Quarantine is always constructed for reads + release; the WRITE is gated separately.
  const quarantine = new Quarantine(
    store,
    opts.quarantinePolicy ?? { allowQuarantine: false, maxExpiryMs: 0 },
  )

  server.registerTool(
    'flake_status',
    {
      title: 'Flakiness status from recorded history',
      description:
        'READ-ONLY: classify every test in the run-history store (flaky/reliable/broken/' +
        'insufficient-data with a Wilson flakeScore) and list currently-active quarantines. ' +
        'Optional minRuns, limitPerTest, since (ISO).',
      inputSchema: {
        minRuns: z.number().int().positive().optional(),
        limitPerTest: z.number().int().positive().optional(),
        since: z.string().optional(),
      },
    },
    (args) => {
      const verdicts = store.classify({
        minRuns: args.minRuns,
        limitPerTest: args.limitPerTest,
        since: args.since,
      })
      const summary = verdicts.reduce<Record<string, number>>((acc, v) => {
        acc[v.state] = (acc[v.state] ?? 0) + 1
        return acc
      }, {})
      const result = {
        summary,
        verdicts: verdicts.map(compactVerdict),
        quarantined: quarantine.active(now()),
      }
      return { content: [text(result)], structuredContent: { ...result } }
    },
  )

  server.registerTool(
    'flake_candidates',
    {
      title: 'Quarantine candidates',
      description:
        'READ-ONLY: rank flaky tests as quarantine candidates by flakeScore (Wilson lower ' +
        'bound of the failure rate), highest first. Never proposes a broken test (fix it) ' +
        'or a reliable one. Optional minFlakeScore floor and minRuns.',
      inputSchema: {
        minFlakeScore: z.number().min(0).max(1).optional(),
        minRuns: z.number().int().positive().optional(),
      },
    },
    (args) => {
      const verdicts = store.classify({ minRuns: args.minRuns })
      const candidates = quarantineCandidates(verdicts, { minFlakeScore: args.minFlakeScore }).map(
        compactVerdict,
      )
      return { content: [text({ candidates })], structuredContent: { candidates } }
    },
  )

  server.registerTool(
    'flake_ingest',
    {
      title: 'Ingest a test-run report into the history store',
      description:
        'Record a CI-produced test report (no spawn — the suite already ran) into the run-' +
        'history store, then classify. `format` is "vitest" (`vitest run --reporter=json`) or ' +
        '"pytest" (the pytest-json-report plugin); `report` is the parsed JSON. Skipped / ' +
        'xfailed / xpassed (pytest) and skipped / pending / todo (vitest) carry no pass/fail ' +
        'signal and are dropped. Optional `at` (ISO; defaults to now), `projectRoot` (stable ' +
        'ids), and `runGroup`. Returns { format, recorded, verdicts }.',
      inputSchema: {
        format: z.enum(['vitest', 'pytest']),
        report: z.record(z.string(), z.unknown()).describe('the parsed test-report JSON'),
        at: z.string().optional().describe('ISO timestamp stamped on every run (defaults to now)'),
        projectRoot: z.string().optional(),
        runGroup: z.string().optional(),
      },
    },
    (args) => {
      const parseOpts = {
        at: args.at ?? now(),
        projectRoot: args.projectRoot,
        runGroup: args.runGroup,
      }
      const recorded =
        args.format === 'pytest'
          ? store.ingestPytestReport(args.report as PytestJsonReport, parseOpts)
          : store.ingestReport(args.report as VitestJsonReport, parseOpts)
      const result = {
        format: args.format,
        recorded,
        verdicts: store.classify().map(compactVerdict),
      }
      return { content: [text(result)], structuredContent: { ...result } }
    },
  )

  server.registerTool(
    'flake_release',
    {
      title: 'Release a quarantine',
      description:
        'Lift a test from quarantine. Always allowed — re-enabling a test can only make the ' +
        'gate stricter. Returns { released } (false if it was not quarantined).',
      inputSchema: { testId: z.string() },
    },
    (args) => {
      const released = quarantine.release(args.testId)
      return { content: [text({ released })], structuredContent: { released } }
    },
  )

  // flake_quarantine WRITES a quarantine: gated on allowQuarantine AND a positive expiry cap.
  const qp = opts.quarantinePolicy
  if (qp?.allowQuarantine && qp.maxExpiryMs > 0) {
    server.registerTool(
      'flake_quarantine',
      {
        title: 'Quarantine a flaky test',
        description:
          'Quarantine a test for a BOUNDED window. Operator-gated. `expiresAt` (ISO) is ' +
          'mandatory, must be in the future, and is REFUSED if it exceeds the operator cap ' +
          '(no silent clamp). A non-empty `reason` is required.',
        inputSchema: {
          testId: z.string(),
          reason: z.string(),
          expiresAt: z.string().describe('ISO expiry, within the operator cap'),
          flakeScore: z.number().min(0).max(1).optional(),
        },
      },
      (args) => {
        const entry = quarantine.quarantine({
          testId: args.testId,
          reason: args.reason,
          expiresAt: args.expiresAt,
          flakeScore: args.flakeScore,
          now: now(),
        })
        return { content: [text({ entry })], structuredContent: { entry } }
      },
    )
  }

  // flake_run RUNS the suite: gated on allowRun AND a non-empty root allowlist.
  const rc = opts.runConfig
  if (rc?.allowRun && rc.allowedRoots.length > 0) {
    const allowedRoots = rc.allowedRoots
    const timeoutMs = rc.timeoutMs
    server.registerTool(
      'flake_run',
      {
        title: 'Run the suite to gather flakiness history',
        description:
          'Run the suite `repeat` times (default 1) with the JSON reporter, recording every ' +
          'outcome into the history store, then classify. Operator-gated and confined to ' +
          'allowlisted project roots. Optional `framework` (vitest|pytest, default vitest), ' +
          'positional `files` filters and a `runGroup`.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root (must be operator-allowlisted)'),
          framework: z
            .enum(['vitest', 'pytest'])
            .optional()
            .describe('test framework (default vitest)'),
          repeat: z.number().int().positive().optional(),
          files: z.array(z.string()).optional(),
          runGroup: z.string().optional(),
        },
      },
      async (args) => {
        const config: RunHistoryConfig = {
          projectRoot: args.projectRoot,
          allowedRoots,
          allowRun: true,
          timeoutMs,
        }
        const run = args.framework === 'pytest' ? runAndRecordPytest : runAndRecord
        const result = await run(
          store,
          config,
          { repeat: args.repeat, files: args.files, runGroup: args.runGroup },
          { runner: opts.runner },
        )
        const structured = {
          ran: result.ran,
          iterations: result.iterations,
          recorded: result.recorded,
          results: result.results,
          verdicts: result.verdicts.map(compactVerdict),
        }
        return { content: [text(structured)], structuredContent: structured }
      },
    )
  }
}

/** Build a standalone Strummer flake MCP server. */
export function createFlakeServer(opts: FlakeToolsOptions): McpServer {
  const server = new McpServer(
    { name: 'strummer-flake', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerFlakeTools(server, opts)
  return server
}
