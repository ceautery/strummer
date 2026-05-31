/** Domain model for API requests, assertions, and run results. */

export type AssertionSource =
  | 'status'
  | 'statusText'
  | 'header'
  | 'body'
  | 'jsonpath'
  | 'responseTime'
  | 'schema'

export type AssertionOp =
  | 'equals'
  | 'notEquals'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'exists'
  | 'notExists'

/** A declarative assertion (from a `*.strummer.yml` sidecar). */
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

/** A request body. Raw types carry `content`; form-urlencoded carries `params`. */
export interface RequestBody {
  type: string
  content?: string
  params?: { name: string; value: string }[]
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
