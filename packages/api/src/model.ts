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

export interface ApiRequest {
  name: string
  method: string
  url: string
  headers: { name: string; value: string }[]
}

export interface RequestEntry {
  request: ApiRequest
  assertions: AssertionSpec[]
  captures: CaptureSpec[]
}

export interface Collection {
  dir: string
  requests: Map<string, RequestEntry>
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

export interface RunResult {
  status: number
  latencyMs: number
  headers: Record<string, string>
  assertions: AssertionResult[]
  captured: Record<string, unknown>
  /** Resource handle for the response body — never inlined. */
  bodyHandle: string
}
