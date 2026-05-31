import { describe, expect, it } from 'vitest'
import { evaluateAssertions, extractCaptures, type ResponseContext } from './assert.js'

const ctx: ResponseContext = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  bodyText: '{"id":7,"items":[1,2,3]}',
  json: { id: 7, items: [1, 2, 3] },
  latencyMs: 12,
}

describe('evaluateAssertions', () => {
  it('evaluates status, header, jsonpath, and responseTime sources', () => {
    const results = evaluateAssertions(
      [
        { source: 'status', op: 'equals', value: 200 },
        { source: 'header', name: 'content-type', op: 'contains', value: 'json' },
        { source: 'jsonpath', path: '$.id', op: 'equals', value: 7 },
        { source: 'jsonpath', path: '$.missing', op: 'notExists' },
        { source: 'responseTime', op: 'lt', value: 1000 },
      ],
      ctx,
    )
    expect(results.every((r) => r.pass)).toBe(true)
  })

  it('reports a failure with the actual value', () => {
    const [r] = evaluateAssertions([{ source: 'status', op: 'equals', value: 404 }], ctx)
    expect(r?.pass).toBe(false)
    expect(r?.actual).toBe(200)
  })
})

describe('extractCaptures', () => {
  it('captures by jsonpath, status, and header', () => {
    const captured = extractCaptures(
      [
        { var: 'id', source: 'jsonpath', path: '$.id' },
        { var: 'code', source: 'status' },
        { var: 'ctype', source: 'header', name: 'content-type' },
      ],
      ctx,
    )
    expect(captured).toEqual({ id: 7, code: 200, ctype: 'application/json' })
  })
})
