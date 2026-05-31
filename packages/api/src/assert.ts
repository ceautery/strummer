import { JSONPath } from 'jsonpath-plus'
import type { AssertionOp, AssertionResult, AssertionSpec, CaptureSpec } from './model.js'
import { validateSchema } from './schema.js'

export interface ResponseContext {
  status: number
  statusText: string
  headers: Record<string, string>
  bodyText: string
  json: unknown
  latencyMs: number
}

/** Resolve a value from a response by source kind (shared by assertions + captures). */
function valueFrom(
  source: string,
  ctx: ResponseContext,
  opts: { path?: string; name?: string },
): unknown {
  switch (source) {
    case 'status':
      return ctx.status
    case 'statusText':
      return ctx.statusText
    case 'responseTime':
      return ctx.latencyMs
    case 'body':
      return ctx.bodyText
    case 'header':
      return opts.name ? ctx.headers[opts.name.toLowerCase()] : undefined
    case 'jsonpath':
      // eval disabled: no script (`()`/`?()`) expressions — jsonpath-plus has a
      // history of eval CVEs; only plain path navigation is allowed.
      return JSONPath({
        path: opts.path ?? '$',
        json: ctx.json as object,
        wrap: false,
        eval: false,
      })
    default:
      return undefined
  }
}

/** Evaluate declarative assertions against a response. */
export function evaluateAssertions(
  specs: AssertionSpec[],
  ctx: ResponseContext,
): AssertionResult[] {
  return specs.map((spec) => {
    // 'schema' is pass/fail against a JSON Schema, not an op comparison: the
    // schema lives in `value`, the subject is the body (or a jsonpath subtree).
    if (spec.source === 'schema') {
      const subject = spec.path ? valueFrom('jsonpath', ctx, spec) : ctx.json
      const { valid, errors } = validateSchema(spec.value, subject)
      return {
        source: spec.source,
        op: spec.op,
        path: spec.path,
        expected: spec.value,
        actual: valid ? null : errors,
        pass: valid,
      }
    }
    const actual = valueFrom(spec.source, ctx, spec)
    return {
      source: spec.source,
      op: spec.op,
      path: spec.path,
      name: spec.name,
      expected: spec.value,
      actual,
      pass: applyOp(spec.op, actual, spec.value),
    }
  })
}

/** Extract captured variables from a response into a name→value map. */
export function extractCaptures(
  specs: CaptureSpec[],
  ctx: ResponseContext,
): Record<string, unknown> {
  const captured: Record<string, unknown> = {}
  for (const spec of specs) {
    captured[spec.var] = valueFrom(spec.source, ctx, spec)
  }
  return captured
}

function applyOp(op: AssertionOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case 'equals':
      return deepEqual(actual, expected)
    case 'notEquals':
      return !deepEqual(actual, expected)
    case 'exists':
      return actual !== undefined && actual !== null
    case 'notExists':
      return actual === undefined || actual === null
    case 'gt':
      return Number(actual) > Number(expected)
    case 'gte':
      return Number(actual) >= Number(expected)
    case 'lt':
      return Number(actual) < Number(expected)
    case 'lte':
      return Number(actual) <= Number(expected)
    case 'contains':
      return String(actual).includes(String(expected))
    case 'notContains':
      return !String(actual).includes(String(expected))
    case 'matches':
      return new RegExp(String(expected)).test(String(actual))
    default:
      return false
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}
