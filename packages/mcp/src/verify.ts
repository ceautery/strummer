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
import { z } from 'zod'

export interface VerifyToolsOptions {
  /** Injected: persist the full verdict by handle; returns the handle. */
  storeVerdict?: (id: string, kind: string, body: string, contentType: string) => string
  /** Injected: resolve a stored verdict handle to its bytes (for the resource). */
  resolveVerdict?: (handle: string) => { contentType: string; body: Buffer } | undefined
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
