/**
 * Pillar-agnostic declarative assertion operators — the comparison layer shared
 * by every Sackville pillar (the API engine and the browser engine), so there is
 * **one assertion operator vocabulary** across the toolkit. Each pillar resolves
 * its own `actual` value (an HTTP response field, a live DOM element's text, …)
 * and then calls `applyOp` to compare it with the `expected` value.
 */
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

/** Compare `actual` against `expected` under `op`. Pure; unknown ops are false. */
export function applyOp(op: AssertionOp, actual: unknown, expected: unknown): boolean {
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
