import { describe, expect, it } from 'vitest'
import { applyOp } from './op.js'

describe('applyOp — pillar-agnostic assertion operators', () => {
  it('equals/notEquals compare deeply (primitives and structures)', () => {
    expect(applyOp('equals', 200, 200)).toBe(true)
    expect(applyOp('equals', { a: 1 }, { a: 1 })).toBe(true)
    expect(applyOp('equals', [1, 2], [1, 2])).toBe(true)
    expect(applyOp('equals', 'x', 'y')).toBe(false)
    expect(applyOp('notEquals', 'x', 'y')).toBe(true)
    expect(applyOp('notEquals', 1, 1)).toBe(false)
  })

  it('exists/notExists treat null and undefined as absent', () => {
    expect(applyOp('exists', 0, undefined)).toBe(true)
    expect(applyOp('exists', '', undefined)).toBe(true)
    expect(applyOp('exists', null, undefined)).toBe(false)
    expect(applyOp('exists', undefined, undefined)).toBe(false)
    expect(applyOp('notExists', null, undefined)).toBe(true)
    expect(applyOp('notExists', 5, undefined)).toBe(false)
  })

  it('numeric comparisons coerce both sides', () => {
    expect(applyOp('gt', 5, 3)).toBe(true)
    expect(applyOp('gt', '5', 3)).toBe(true)
    expect(applyOp('gte', 3, 3)).toBe(true)
    expect(applyOp('lt', 2, 3)).toBe(true)
    expect(applyOp('lte', 3, 3)).toBe(true)
    expect(applyOp('lt', 5, 3)).toBe(false)
  })

  it('string contains/notContains/matches', () => {
    expect(applyOp('contains', 'hello world', 'world')).toBe(true)
    expect(applyOp('notContains', 'hello', 'world')).toBe(true)
    expect(applyOp('matches', 'abc123', '\\d+')).toBe(true)
    expect(applyOp('matches', 'abc', '\\d+')).toBe(false)
  })

  it('returns false for an unknown op', () => {
    expect(applyOp('bogus' as never, 1, 1)).toBe(false)
  })
})
