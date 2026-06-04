import { randomUUID } from 'node:crypto'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  ArtifactStore,
  isGraphqlEnvelope,
  loadCollection,
  type RequestEntry,
  runRequest,
  runSequence,
  type SecretStore,
  validateCapturedTraffic,
  validateGraphqlOperation,
  validateOpenApiRequest,
  validateOpenApiResponse,
} from '@strummer/api'
import { z } from 'zod'

export interface ApiToolsOptions {
  /** OPERATOR-controlled: unlock mutating requests. Never an agent input (ADR 0004). */
  allowUnsafe?: boolean
  /** OPERATOR-controlled: hosts a mutating request may target. Never an agent input. */
  allowedHosts?: string[]
  /** OPERATOR-controlled: permit loopback/private SSRF targets (default true).
   * Set false for a hardened, internet-only posture. Never an agent input. */
  allowPrivate?: boolean
  secrets?: SecretStore
  artifacts?: ArtifactStore
  /**
   * OPERATOR-controlled: permit `validate_capture` to resolve + parse a stored
   * browser HAR (ADR 0013 §3a). A HAR is operator-gated bytes with known-incomplete
   * redaction, so reading one is NOT free — it requires this explicit opt-in
   * (`STRUMMER_VERIFY_ALLOW_CAPTURE`). Never an agent input.
   */
  allowCapture?: boolean
  /**
   * Injected getter that resolves a HAR handle (e.g. `strummer://browser/run/<id>/har`)
   * to its raw `.zip` bytes — wired by the bin from the shared artifact store
   * (cross-prefix rehydrate). When absent, `validate_capture` is not registered.
   */
  resolveHar?: (handle: string) => Buffer | undefined
  /** Redacts capture finding messages before they leave the surface (ADR 0013 §3b). */
  verifyRedact?: (value: string) => string
  /** Injected: persist the full capture verdict detail by handle; returns the handle. */
  storeVerifyDetail?: (id: string, kind: string, body: string, contentType: string) => string
}

const INSTRUCTIONS = `Strummer drives version-pinned API tests from a Bruno collection on disk.

Use \`list_requests\` to see a collection's requests, \`get_request\` to inspect one
(it reports required secret NAMES, never values), \`run_request\`/\`run_collection\`
to execute them, and \`validate_response\` to check a response/operation against an
OpenAPI or GraphQL contract. Responses are returned by handle: read the
\`strummer://run/{runId}/body\` resource for a full body. Mutating requests are
dry-run unless the OPERATOR has unlocked them — that is not something a caller can
authorize.`

function text(value: unknown) {
  return { type: 'text' as const, text: JSON.stringify(value, null, 2) }
}

const SECRET_REF = /\{\{\s*secret:\s*([^}\s]+)\s*\}\}/g

/** Sorted, unique secret NAMES referenced anywhere in a request (url/headers/body). */
function requiredSecrets(entry: RequestEntry): string[] {
  const found = new Set<string>()
  const scan = (s: string | undefined) => {
    if (!s) return
    for (const m of s.matchAll(SECRET_REF)) found.add(m[1]!)
  }
  const { request } = entry
  scan(request.url)
  for (const h of request.headers) scan(h.value)
  if (request.body) {
    scan(request.body.content)
    for (const p of request.body.params ?? []) {
      scan(p.name)
      scan(p.value)
    }
  }
  return [...found].sort()
}

/** Register Strummer's API-testing tools + run-body resource onto a server. */
export function registerApiTools(server: McpServer, opts: ApiToolsOptions = {}): void {
  // A single shared store so stored bodies stay fetchable via the resource.
  const artifacts = opts.artifacts ?? new ArtifactStore()

  server.registerTool(
    'list_requests',
    {
      title: 'List requests',
      description: 'List the requests in a Bruno collection directory (name, method, url).',
      inputSchema: { dir: z.string().describe('absolute path to the collection directory') },
      outputSchema: {
        requests: z.array(z.object({ name: z.string(), method: z.string(), url: z.string() })),
      },
    },
    (args) => {
      const coll = loadCollection(args.dir)
      const requests = [...coll.requests.entries()].map(([name, entry]) => ({
        name,
        method: entry.request.method,
        url: entry.request.url,
      }))
      const structured = { requests }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'get_request',
    {
      title: 'Inspect a request',
      description:
        'Inspect one request: method, url, headers, required secret NAMES (never values), ' +
        'and assertion/capture/script counts.',
      inputSchema: {
        dir: z.string().describe('absolute path to the collection directory'),
        name: z.string().describe('request name (collection key) from list_requests'),
      },
      outputSchema: {
        name: z.string(),
        method: z.string(),
        url: z.string(),
        headers: z.array(z.object({ name: z.string(), value: z.string() })),
        requiredSecrets: z.array(z.string()),
        assertionCount: z.number().int(),
        captureCount: z.number().int(),
        hasPreScript: z.boolean(),
        hasPostScript: z.boolean(),
      },
    },
    (args) => {
      const coll = loadCollection(args.dir)
      const entry = coll.requests.get(args.name)
      if (!entry) {
        throw new Error(`No request named ${args.name} in ${args.dir}`)
      }
      const structured = {
        name: args.name,
        method: entry.request.method,
        url: entry.request.url,
        headers: entry.request.headers.map((h) => ({ name: h.name, value: h.value })),
        requiredSecrets: requiredSecrets(entry),
        assertionCount: entry.assertions.length,
        captureCount: entry.captures.length,
        hasPreScript: Boolean(entry.preScript),
        hasPostScript: Boolean(entry.postScript),
      }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'run_request',
    {
      title: 'Run a request',
      description:
        'Execute one request and evaluate its assertions. The full response body is returned ' +
        'by handle (read the strummer://run/{runId}/body resource). Mutating requests are ' +
        'dry-run unless the operator has unlocked them.',
      inputSchema: {
        dir: z.string().describe('absolute path to the collection directory'),
        name: z.string().describe('request name (collection key)'),
        vars: z.record(z.string(), z.unknown()).optional().describe('runtime variables'),
        env: z.string().optional().describe('named environment to load'),
      },
    },
    async (args) => {
      const coll = loadCollection(args.dir)
      const result = await runRequest(coll, args.name, {
        vars: args.vars as Record<string, string> | undefined,
        env: args.env,
        secrets: opts.secrets,
        artifacts,
        allowUnsafe: opts.allowUnsafe,
        allowedHosts: opts.allowedHosts,
        allowPrivate: opts.allowPrivate,
      })
      return { content: [text(result)], structuredContent: { ...result } }
    },
  )

  server.registerTool(
    'run_collection',
    {
      title: 'Run a sequence of requests',
      description:
        'Run several requests in order, chaining captured values. Returns a COMPACT per-step ' +
        'summary (no inlined bodies) plus the captured variables.',
      inputSchema: {
        dir: z.string().describe('absolute path to the collection directory'),
        names: z.array(z.string()).describe('request names (collection keys), in order'),
        vars: z.record(z.string(), z.unknown()).optional().describe('runtime variables'),
        env: z.string().optional().describe('named environment to load'),
        stopOnFailure: z
          .boolean()
          .optional()
          .describe('stop the sequence at the first failing step'),
      },
      outputSchema: {
        steps: z.array(
          z.object({
            name: z.string(),
            status: z.number().nullable(),
            sent: z.boolean(),
            dryRun: z.boolean(),
            assertionsPassed: z.boolean(),
            bodyHandle: z.string().optional(),
          }),
        ),
        captured: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => {
      const coll = loadCollection(args.dir)
      const seq = await runSequence(coll, args.names, {
        vars: args.vars as Record<string, string> | undefined,
        env: args.env,
        secrets: opts.secrets,
        artifacts,
        allowUnsafe: opts.allowUnsafe,
        allowedHosts: opts.allowedHosts,
        allowPrivate: opts.allowPrivate,
        stopOnFailure: args.stopOnFailure,
      })
      const steps = seq.steps.map(({ name, result }) => ({
        name,
        status: result.response?.status ?? null,
        sent: result.sent,
        dryRun: result.dryRun,
        assertionsPassed: result.response ? result.response.assertions.every((a) => a.pass) : false,
        bodyHandle: result.response?.bodyHandle,
      }))
      const structured = { steps, captured: seq.captured }
      return { content: [text(structured)], structuredContent: structured }
    },
  )

  server.registerTool(
    'validate_response',
    {
      title: 'Validate against a contract',
      description:
        'Validate a response/operation against a contract. Supply either an OpenAPI 3.1 spec ' +
        '(+ method/path/status/body) or a GraphQL SDL schema (+ query).',
      inputSchema: {
        openapiSpec: z.unknown().optional().describe('a parsed OpenAPI 3.1 document'),
        method: z.string().optional().describe('HTTP method for the OpenAPI operation'),
        path: z.string().optional().describe('request path for the OpenAPI operation'),
        status: z.number().int().optional().describe('response status to validate'),
        body: z.unknown().optional().describe('response body to validate'),
        graphqlSchema: z.string().optional().describe('GraphQL schema (SDL)'),
        query: z.string().optional().describe('GraphQL operation/query text'),
        operationName: z
          .string()
          .optional()
          .describe('scope GraphQL drift to a named operation in a multi-operation document'),
      },
    },
    (args) => {
      let result: import('@strummer/api').ContractResult
      if (args.graphqlSchema !== undefined) {
        result = validateGraphqlOperation(args.graphqlSchema, args.query ?? '', {
          json: args.body,
          operationName: args.operationName,
        })
      } else if (args.openapiSpec !== undefined) {
        result = validateOpenApiResponse(
          args.openapiSpec as Parameters<typeof validateOpenApiResponse>[0],
          { method: args.method ?? 'GET', path: args.path ?? '/' },
          { status: args.status ?? 200, body: args.body },
        )
      } else {
        throw new Error(
          'Supply either `openapiSpec` (with method/path/status/body) or `graphqlSchema` (with query).',
        )
      }
      return { content: [text(result)], structuredContent: { ...result } }
    },
  )

  // validate_request — the REQUEST half of contract validation (sibling of
  // validate_response). A DIRECT surface: the caller holds the real request, so body
  // presence + params are authoritative. Findings (message AND path) are redacted via
  // the operator redactor when wired. A GraphQL envelope is refused (H4), not failed.
  {
    const redact = opts.verifyRedact ?? ((v: string) => v)
    server.registerTool(
      'validate_request',
      {
        title: 'Validate a request against an OpenAPI contract',
        description:
          'Validate a request (body + path/query/header params) against an OpenAPI 3.1 operation. ' +
          'Body presence and params are treated as authoritative (this surface holds the real request). ' +
          'Returns structured ContractFindings; a GraphQL request envelope is refused, not schema-failed.',
        inputSchema: {
          openapiSpec: z.unknown().describe('a parsed OpenAPI 3.1 document'),
          method: z.string().describe('HTTP method for the operation'),
          path: z.string().describe('request path (pathname) for the operation'),
          body: z.unknown().optional().describe('parsed request body to validate'),
          query: z
            .record(z.string(), z.union([z.string(), z.array(z.string())]))
            .optional()
            .describe('decoded query parameters'),
          headers: z
            .record(z.string(), z.string())
            .optional()
            .describe('lower-cased request header names → value'),
        },
      },
      (args) => {
        if (isGraphqlEnvelope(args.body)) {
          throw new Error(
            'The request body is a GraphQL envelope ({query}); use a GraphQL schema with validate_response, not OpenAPI request validation.',
          )
        }
        const raw = validateOpenApiRequest(
          args.openapiSpec as Parameters<typeof validateOpenApiRequest>[0],
          {
            method: args.method,
            path: args.path,
            body: args.body,
            query: args.query as Record<string, string | string[]> | undefined,
            headers: args.headers as Record<string, string> | undefined,
          },
          { bodyPresenceAuthoritative: true, paramsAuthoritative: true },
        )
        // Redact every finding message AND path (request bodies/params are secret-bearing).
        const result = {
          ...raw,
          findings: raw.findings.map((f) => ({
            ...f,
            message: redact(f.message),
            ...(f.path !== undefined ? { path: redact(f.path) } : {}),
          })),
        }
        return { content: [text(result)], structuredContent: { ...result } }
      },
    )
  }

  // validate_capture — the capture→contract bridge (ADR 0013 §3, milestone 5a).
  // Registered ONLY when the bin injected a HAR resolver (i.e. an artifacts root is
  // configured). Resolving a HAR additionally requires the operator capture gate.
  if (opts.resolveHar) {
    const resolveHar = opts.resolveHar
    const redact = opts.verifyRedact ?? ((v: string) => v)
    server.registerTool(
      'validate_capture',
      {
        title: 'Validate a captured run against an OpenAPI or GraphQL contract',
        description:
          'Validate the traffic in a stored browser/API HAR (by handle) against an OpenAPI 3.1 ' +
          'spec and/or a GraphQL SDL — no request is re-run. REST entries report drift ' +
          '(undocumented operations/statuses, schema violations) + which documented operations ' +
          'the run exercised; GraphQL entries (at the given endpoint) report query-vs-schema drift ' +
          'and response errors. Supply openapiSpec, graphqlSchema (+ graphqlEndpoint), or both. ' +
          'Requires the operator capture gate; finding messages are redacted; raw headers/cookies ' +
          'never enter the result.',
        inputSchema: {
          harHandle: z
            .string()
            .describe('handle of a stored HAR, e.g. strummer://browser/run/<id>/har'),
          openapiSpec: z.unknown().optional().describe('a parsed OpenAPI 3.1 document'),
          graphqlSchema: z
            .string()
            .optional()
            .describe('GraphQL schema (SDL) to validate captured operations against'),
          graphqlEndpoint: z
            .string()
            .optional()
            .describe('request pathname that serves GraphQL (default /graphql)'),
          allowedOrigins: z
            .array(z.string())
            .optional()
            .describe('restrict validation to entries from these request origins'),
        },
      },
      (args) => {
        if (opts.allowCapture !== true) {
          throw new Error(
            'validate_capture is disabled: the operator must set STRUMMER_VERIFY_ALLOW_CAPTURE to ' +
              'resolve an operator-gated HAR (its redaction is known-incomplete).',
          )
        }
        if (args.openapiSpec === undefined && args.graphqlSchema === undefined) {
          throw new Error(
            'Supply at least one contract: `openapiSpec` (REST) and/or `graphqlSchema` (+ optional `graphqlEndpoint`).',
          )
        }
        const bytes = resolveHar(args.harHandle)
        if (!bytes) throw new Error(`no stored HAR for ${args.harHandle}`)
        const contract: import('@strummer/api').CaptureContract = {
          ...(args.openapiSpec !== undefined
            ? { openapi: args.openapiSpec as import('@strummer/api').CaptureContract['openapi'] }
            : {}),
          ...(args.graphqlSchema !== undefined
            ? {
                graphql: {
                  endpointPath: args.graphqlEndpoint ?? '/graphql',
                  sdl: args.graphqlSchema,
                },
              }
            : {}),
        }
        const verdict = validateCapturedTraffic(bytes, contract, {
          redact,
          allowedOrigins: args.allowedOrigins,
        })
        // Compact inline; full per-entry detail (redacted) by handle when a store is wired.
        const compact = {
          clean: verdict.clean,
          entriesValidated: verdict.entriesValidated,
          findingsByKind: verdict.findingsByKind,
          firstFailing: verdict.firstFailing,
          exercisedOperations: verdict.exercisedOperations,
          unexercisedOperations: verdict.unexercisedOperations,
          unresolvedBodies: verdict.unresolvedBodies,
          noSignal: verdict.noSignal,
        }
        let detailHandle: string | undefined
        if (opts.storeVerifyDetail) {
          detailHandle = opts.storeVerifyDetail(
            randomUUID(),
            'capture-verdict',
            JSON.stringify(verdict, null, 2),
            'application/json',
          )
        }
        const out = { ...compact, ...(detailHandle ? { detailHandle } : {}) }
        return { content: [text(out)], structuredContent: out }
      },
    )
  }

  server.registerResource(
    'run-body',
    new ResourceTemplate('strummer://run/{runId}/body', { list: undefined }),
    {
      title: 'Run response body',
      description: 'Full stored response body for a run, by handle',
      mimeType: 'application/json',
    },
    (uri, variables) => {
      const raw = Array.isArray(variables.runId) ? variables.runId[0] : variables.runId
      const handle = `strummer://run/${raw}/body`
      const artifact = artifacts.get(handle)
      if (!artifact) {
        throw new Error(`No stored body for ${handle}`)
      }
      return {
        contents: [{ uri: uri.href, mimeType: artifact.contentType, text: artifact.body }],
      }
    },
  )
}

/** Build a standalone Strummer API MCP server. */
export function createApiServer(opts: ApiToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'strummer-api', version: '0.0.0' },
    { instructions: INSTRUCTIONS },
  )
  registerApiTools(server, opts)
  return server
}
