import { randomUUID } from 'node:crypto'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ContractResult } from '@strummer/api'
import type { DiffCoverageReport } from '@strummer/coverage'
import type { DependencyAudit } from '@strummer/deps'
import type { FlakeVerdict } from '@strummer/flake'
import type { MutationSummary } from '@strummer/mutate'
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
import { gateDenied, type OrchestrateRequest, orchestrate } from '@strummer/verify'
import { z } from 'zod'

/** Per-call context the operator-wired pillar runners receive (slice 5 builds these). */
export interface RunDrivingContext {
  projectRoot: string
  changedFiles: string[]
  diff?: string
}

/** The agent-supplied consume-only capture inputs for the contract sub-verdict. */
export interface ContractCaptureContext {
  harHandle: string
  openapiSpec?: unknown
  graphqlSchema?: string
  graphqlEndpoint?: string
}

/**
 * The operator-wired, ALREADY-GATED pillar runners for the run-driving `verify_change`
 * tool (ADR 0013 Addendum, milestone 5c). The bin wires a pillar's runner here ONLY
 * when that pillar's gate is satisfied — `STRUMMER_VERIFY_ENABLE_RUN` AND the pillar's
 * OWN `*_ALLOW_RUN` ("both required" — slice 5). A requested pillar with no runner here
 * ⇒ `skipReason:'gate-not-set'` (never run, surfaced). `verify_change` is registered
 * ONLY when ≥1 runner is wired — deny-by-default REGISTRATION, not just a runtime check.
 * Safety is operator-set: nothing here is settable from a tool input ("compose, never
 * widen"). The runners are injected so the gate suite never spawns.
 */
export interface RunDrivingOptions {
  coverage?: (ctx: RunDrivingContext) => Promise<DiffCoverageReport>
  flake?: (ctx: RunDrivingContext) => Promise<FlakeVerdict[]>
  mutate?: (ctx: RunDrivingContext) => Promise<MutationSummary>
  deps?: (
    ctx: RunDrivingContext,
  ) => Promise<{ audits: DependencyAudit[]; osvSnapshotLoaded: boolean }>
  /** Consume-only capture→contract bridge, wired only behind the existing capture gate. */
  contract?: (ctx: ContractCaptureContext) => Promise<ContractResult[]>
  /** Operator redactor applied to an errored pillar's message before it enters the verdict. */
  redact?: (value: string) => string
}

export interface VerifyToolsOptions {
  /** Injected: persist the full verdict by handle; returns the handle. */
  storeVerdict?: (id: string, kind: string, body: string, contentType: string) => string
  /** Injected: resolve a stored verdict handle to its bytes (for the resource). */
  resolveVerdict?: (handle: string) => { contentType: string; body: Buffer } | undefined
  /** Operator-wired run-driving runners. Absent ⇒ `verify_change` is NOT registered. */
  runDriving?: RunDrivingOptions
}

const INSTRUCTIONS = `Strummer composes the per-pillar verification signals into ONE change verdict.

Supply whichever pillar results you have — contract (from validate_capture/validate_response),
coverage (uncovered_in_diff/run_scoped), deps (audit_project), flake, mutation — and request_verdict
folds them. ABSENCE IS NEVER A PASS: a missing or no-signal pillar yields an \`inconclusive\` verdict,
not \`pass\`. The overall posture has NO baked-in threshold — pass \`failAtOrAbove\` to declare which
severity should fail the change; without it a severity-only finding stays \`warn\`.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'none'] as const

/** Register the cross-pillar `request_verdict` tool (+ verdict resource) onto a server. */
export function registerVerifyTools(server: McpServer, opts: VerifyToolsOptions = {}): void {
  server.registerTool(
    'request_verdict',
    {
      title: 'Compose a cross-pillar change verdict',
      description:
        'Fold the per-pillar verification results into one CompositeVerdict. Supply any subset of ' +
        'contract/coverage/deps/flake/mutate results; omitted pillars are `missing`. Absence is ' +
        'never a pass. Pass `failAtOrAbove` to declare the failing severity cut (no default).',
      inputSchema: {
        contract: z
          .object({
            results: z
              .array(z.unknown())
              .describe('ContractResult[] (from validate_capture/_response)'),
            source: z.enum(['run', 'capture-from-HAR']).optional(),
          })
          .optional(),
        coverage: z.unknown().optional().describe('a DiffCoverageReport (from uncovered_in_diff)'),
        deps: z
          .object({
            audits: z.array(z.unknown()).describe('DependencyAudit[] (from audit_project)'),
            osvSnapshotLoaded: z.boolean().describe('whether an OSV snapshot backed the audit'),
          })
          .optional(),
        flake: z.array(z.unknown()).optional().describe('FlakeVerdict[]'),
        mutate: z.unknown().optional().describe('a MutationSummary'),
        failAtOrAbove: z
          .enum(SEVERITIES)
          .optional()
          .describe('escalate any pillar at/above this severity to a failing verdict (no default)'),
      },
    },
    (args) => {
      const inputs: ComposeInputs = {}
      if (args.contract) {
        inputs.contract = fromContractResults(
          args.contract.results as ContractResult[],
          args.contract.source,
        )
      }
      if (args.coverage !== undefined) {
        inputs.coverage = fromDiffCoverage(args.coverage as DiffCoverageReport)
      }
      if (args.deps) {
        inputs.deps = fromDependencyAudits(args.deps.audits as DependencyAudit[], {
          osvSnapshotLoaded: args.deps.osvSnapshotLoaded,
        })
      }
      if (args.flake) inputs.flake = fromFlakeVerdicts(args.flake as FlakeVerdict[])
      if (args.mutate !== undefined) {
        inputs.mutate = fromMutationSummary(args.mutate as MutationSummary)
      }
      // NO baked-in default: failAtOrAbove is threaded straight through (ADR 0013 §3a).
      const verdict = composeVerdict(inputs, { failAtOrAbove: args.failAtOrAbove as Severity })

      let detailHandle: string | undefined
      if (opts.storeVerdict) {
        detailHandle = opts.storeVerdict(
          randomUUID(),
          'verdict',
          JSON.stringify(verdict, null, 2),
          'application/json',
        )
      }
      const out = { ...verdict, ...(detailHandle ? { detailHandle } : {}) }
      return { content: [text(out)], structuredContent: out }
    },
  )

  // verify_change DRIVES the pillars (it spawns/audits), so it is registered ONLY when
  // the operator enabled run-driving and wired ≥1 pillar runner — deny-by-default
  // REGISTRATION (mirrors run_scoped/flake_run/mutate_run), not just a runtime check.
  const rd = opts.runDriving
  if (rd && (rd.coverage || rd.deps || rd.flake || rd.mutate || rd.contract)) {
    const SPAWN_PILLARS = ['coverage', 'deps', 'flake', 'mutate'] as const
    server.registerTool(
      'verify_change',
      {
        title: 'Drive the pillars and compose one change verdict',
        description:
          'Run the enabled verification pillars (coverage/flake/mutate/deps + the consume-only ' +
          'capture→contract bridge) for a change and fold them into ONE CompositeVerdict — the ' +
          '"is this change safe?" one-shot. Each pillar runs behind its OWN operator gate: a ' +
          'requested pillar whose gate is unmet is `skipReason:gate-not-set` (surfaced, never run, ' +
          'never a pass). Absence is never a pass. Pass `failAtOrAbove` to declare the failing cut.',
        inputSchema: {
          projectRoot: z.string().describe('absolute project root of the change'),
          changedFiles: z
            .array(z.string())
            .optional()
            .describe('changed source files (e.g. for coverage `vitest related`)'),
          diff: z.string().optional().describe('unified diff, for pillars that use it'),
          pillars: z
            .array(z.enum(['coverage', 'deps', 'flake', 'mutate', 'contract']))
            .optional()
            .describe('which pillars to attempt; omitted ⇒ all enabled pillars'),
          contract: z
            .object({
              harHandle: z.string().describe('a stored browser HAR handle to validate'),
              openapiSpec: z.unknown().optional(),
              graphqlSchema: z.string().optional(),
              graphqlEndpoint: z.string().optional(),
            })
            .optional()
            .describe('consume-only capture→contract inputs (behind the capture gate)'),
          failAtOrAbove: z
            .enum(SEVERITIES)
            .optional()
            .describe(
              'escalate any pillar at/above this severity to a failing verdict (no default)',
            ),
        },
      },
      async (args) => {
        const ctx: RunDrivingContext = {
          projectRoot: args.projectRoot,
          changedFiles: args.changedFiles ?? [],
          diff: args.diff,
        }
        // Default: attempt every WIRED spawn pillar. An explicitly-requested pillar that
        // is NOT wired is surfaced as skipped:gate-not-set (a denied thunk), never run.
        const requested = args.pillars ?? SPAWN_PILLARS.filter((p) => rd[p] !== undefined)
        const wants = (p: (typeof SPAWN_PILLARS)[number]) =>
          (requested as readonly string[]).includes(p)
        const denied = (name: string) => () =>
          Promise.reject(gateDenied(`${name} run is not enabled (operator gate not set)`))
        const spawnRun = <T>(
          fn: ((c: RunDrivingContext) => Promise<T>) | undefined,
          name: string,
        ) => (fn ? () => fn(ctx) : denied(name))

        const request: OrchestrateRequest = {}
        if (wants('coverage')) request.coverage = { run: spawnRun(rd.coverage, 'coverage') }
        if (wants('deps')) request.deps = { run: spawnRun(rd.deps, 'deps') }
        if (wants('flake')) request.flake = { run: spawnRun(rd.flake, 'flake') }
        if (wants('mutate')) request.mutate = { run: spawnRun(rd.mutate, 'mutate') }
        if (args.contract) {
          const cc = args.contract
          const crun = rd.contract
          request.contract = {
            source: 'capture-from-HAR',
            run: crun ? () => crun(cc) : denied('contract'),
          }
        }

        const { id, verdict } = await orchestrate(request, {
          policy: { failAtOrAbove: args.failAtOrAbove as Severity },
          redact: rd.redact,
        })
        let detailHandle: string | undefined
        if (opts.storeVerdict) {
          detailHandle = opts.storeVerdict(
            id,
            'verdict',
            JSON.stringify(verdict, null, 2),
            'application/json',
          )
        }
        const out = { ...verdict, ...(detailHandle ? { detailHandle } : {}) }
        return { content: [text(out)], structuredContent: out }
      },
    )
  }

  if (opts.resolveVerdict) {
    const resolveVerdict = opts.resolveVerdict
    server.registerResource(
      'verify-verdict',
      new ResourceTemplate('strummer://verify/{id}/{kind}', { list: undefined }),
      {
        title: 'Composite verdict',
        description: 'A stored cross-pillar verdict, by handle',
        mimeType: 'application/json',
      },
      (uri, variables) => {
        const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
        const handle = `strummer://verify/${pick(variables.id)}/${pick(variables.kind)}`
        const artifact = resolveVerdict(handle)
        if (!artifact) throw new Error(`No stored verdict for ${handle}`)
        return {
          contents: [
            { uri: uri.href, mimeType: artifact.contentType, text: artifact.body.toString('utf8') },
          ],
        }
      },
    )
  }
}

/** Build a standalone Strummer verify MCP server. */
export function createVerifyServer(opts: VerifyToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'strummer-verify', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerVerifyTools(server, opts)
  return server
}
