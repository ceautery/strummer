/** Domain model for API requests, assertions, and run results. */

// The operator vocabulary is shared across pillars (see @sackville-mcp/assert); the api
// pillar re-exports it so existing `./model.js` importers are unaffected.
import type { AssertionOp } from '@sackville-mcp/assert'

export type { AssertionOp }

export type AssertionSource =
  | 'status'
  | 'statusText'
  | 'header'
  | 'body'
  | 'jsonpath'
  | 'responseTime'
  | 'schema'

/** A declarative assertion (from a `*.sackville.yml` sidecar). */
export interface AssertionSpec {
  source: AssertionSource
  op: AssertionOp
  value?: unknown
  /** JSONPath expression for source 'jsonpath'. */
  path?: string
  /** Header name for source 'header'. */
  name?: string
}

/** Capture a value from a response into the runtime variable scope. */
export interface CaptureSpec {
  var: string
  source: 'status' | 'header' | 'body' | 'jsonpath'
  path?: string
  name?: string
}

/** A multipart-form part: a `text` field or a `file` upload (by path). */
export interface MultipartPart {
  name: string
  kind: 'text' | 'file'
  /** Field value (text parts). */
  value?: string
  /** Source path(s) on disk (file parts; Bruno allows multiple). */
  filePaths?: string[]
  /** Explicit per-part content type (file parts), when set. */
  contentType?: string
}

/** A raw file body — the file's bytes sent as the request body. */
export interface FileBody {
  filePath: string
  contentType?: string
}

/**
 * A request body. Raw types (`json`/`text`/`xml`/`sparql`) carry `content`;
 * `form-urlencoded` carries `params`; `graphql` carries a query + variables;
 * `multipart-form` carries `parts`; `file` carries a single `file`.
 */
export interface RequestBody {
  type: string
  content?: string
  params?: { name: string; value: string }[]
  graphql?: { query: string; variables?: string }
  parts?: MultipartPart[]
  file?: FileBody
}

export interface ApiRequest {
  name: string
  method: string
  url: string
  headers: { name: string; value: string }[]
  body?: RequestBody
}

export interface RequestEntry {
  request: ApiRequest
  assertions: AssertionSpec[]
  captures: CaptureSpec[]
  /** Optional pre-request / post-response sandboxed scripts (from the sidecar). */
  preScript?: string
  postScript?: string
}

/** Result of a `test(name, fn)` in a sandboxed script. */
export interface ScriptTest {
  name: string
  pass: boolean
  error?: string
}

export interface Collection {
  dir: string
  requests: Map<string, RequestEntry>
  /** Environment name → its (non-secret) variables. */
  environments: Map<string, Record<string, string>>
}

export interface AssertionResult {
  source: AssertionSource
  op: AssertionOp
  path?: string
  name?: string
  expected?: unknown
  actual: unknown
  pass: boolean
}

/** Contract-validation finding kinds (OpenAPI + GraphQL drift). */
export type ContractFindingKind =
  | 'missing-operation'
  | 'undocumented-status'
  | 'response-schema'
  | 'graphql-syntax'
  | 'graphql-validation'
  | 'graphql-errors'
  // A captured request matched the GraphQL endpoint but carried no extractable
  // `query` — a hard finding (never an empty pass), used by the capture bridge.
  | 'graphql-no-query'
  // --- Request-side (OpenAPI) drift. See `request-contract.ts`. ---
  // The request body violates the declared requestBody schema (error).
  | 'request-body-schema'
  // A `required: true` requestBody was absent and the caller is authoritative
  // about body presence (direct surfaces); never emitted on the capture path,
  // which cannot distinguish "no body" from "dropped a non-JSON body" (error).
  | 'missing-required-body'
  // A body was sent to an operation that declares no requestBody (warning —
  // frequently client-side noise the server ignored; see the taxonomy note).
  | 'undocumented-body'
  // A body was sent with a Content-Type matching no declared `content` media
  // type (warning; only when a Content-Type is actually present).
  | 'unsupported-media-type'
  // A `required` parameter (path always; query/header when `required: true`) was
  // absent and the caller is authoritative about params (error).
  | 'missing-required-param'
  // A parameter value violates its declared schema (error).
  | 'param-schema'
  // An undocumented QUERY parameter was present (warning; headers excluded —
  // infra/trace headers saturate captures).
  | 'undocumented-param'
  // --- GraphQL request-variable drift. See `graphql.ts` (ADR 0015). ---
  // A required GraphQL variable (non-null, no default) was absent and the caller is
  // authoritative about variables; never on the capture path (which folds to no-signal).
  | 'graphql-variable-missing'
  // A present GraphQL variable value fails coercion against its declared type, or an
  // explicit null was passed to a non-null type (error; authority-independent).
  | 'graphql-variable-invalid'
  // A `variables` key the operation does not declare (warning; the server ignores it).
  | 'graphql-undocumented-variable'

/** A single contract discrepancy between a response and its declared shape. */
export interface ContractFinding {
  kind: ContractFindingKind
  message: string
  /** JSON Pointer / field path to the offending value, when applicable. */
  path?: string
  severity: 'error' | 'warning'
}

/** Result of validating a response against a contract (OpenAPI/GraphQL). */
export interface ContractResult {
  valid: boolean
  findings: ContractFinding[]
  /** Matched OpenAPI operation (lowercased method + path template), when found. */
  operation?: { method: string; path: string }
}

/** Resolves named secrets at the transport boundary. */
export interface SecretStore {
  get(name: string): Promise<string | undefined>
}

/** The request as prepared for the wire — headers/url here are REDACTED for
 * agent-facing output (secret values never appear). */
export interface PreparedRequest {
  method: string
  url: string
  headers: Record<string, string>
  /** Materialized body (redacted), if any. */
  body?: string
}

export interface RunResponse {
  status: number
  latencyMs: number
  headers: Record<string, string>
  assertions: AssertionResult[]
  /** Results of `test(...)` calls in the post-response script (if any). */
  scriptTests: ScriptTest[]
  captured: Record<string, unknown>
  /** Resource handle for the response body — never inlined. */
  bodyHandle: string
  /** Redirect hops followed before the final response (redacted locations).
   * Empty when no redirect was followed. */
  redirects?: { status: number; location: string }[]
}

export interface RunResult {
  /** What was (or, for a dry-run, would be) sent — redacted. */
  request: PreparedRequest
  /** Whether the request was actually dispatched. */
  sent: boolean
  /** True when a mutating request was withheld (dry-run). */
  dryRun: boolean
  /** Why it was withheld, when applicable. */
  reason?: string
  /** Present only when `sent`. */
  response?: RunResponse
}
