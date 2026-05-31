import { JSONPath } from 'jsonpath-plus'
import type { AssertionOp, AssertionResult, AssertionSpec } from './model.js'

export interface ResponseContext {
  status: number
  statusText: string
  headers: Record<string, string>
  bodyText: string
  json: unknown
  latencyMs: number
}

/** Evaluate declarative assertions against a response. */
export function evaluateAssertions(
  specs: AssertionSpec[],
  ctx: ResponseContext,
): AssertionResult[] {
  return specs.map((spec) => {
    const actual = resolveSource(spec, ctx)
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

function resolveSource(spec: AssertionSpec, ctx: ResponseContext): unknown {
  switch (spec.source) {
    case 'status':
      return ctx.status
    case 'statusText':
      return ctx.statusText
    case 'responseTime':
      return ctx.latencyMs
    case 'body':
      return ctx.bodyText
    case 'header':
      return spec.name ? ctx.headers[spec.name.toLowerCase()] : undefined
    case 'jsonpath':
      // eval disabled: no script (`()`/`?()`) expressions — jsonpath-plus has a
      // history of eval CVEs; we only allow plain path navigation.
      return JSONPath({
        path: spec.path ?? '$',
        json: ctx.json as object,
        wrap: false,
        eval: false,
      })
    default:
      return undefined
  }
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
