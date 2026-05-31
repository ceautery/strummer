import { describe, expect, it } from 'vitest'
import { validateOpenApiResponse } from './contract.js'

// A small OpenAPI 3.1 document: a templated path, a $ref into components, and
// two documented statuses.
const spec = {
  openapi: '3.1.0',
  info: { title: 'Users', version: '1.0.0' },
  paths: {
    '/users/{id}': {
      get: {
        responses: {
          '200': {
            description: 'a user',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
          },
          '404': { description: 'not found' },
        },
      },
    },
  },
  components: {
    schemas: {
      User: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          manager: { $ref: '#/components/schemas/User' },
        },
      },
    },
  },
}

describe('validateOpenApiResponse', () => {
  it('passes a conformant response and reports the matched operation', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42' },
      { status: 200, body: { id: 42, name: 'Ada' } },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toEqual([])
    expect(r.operation).toEqual({ method: 'get', path: '/users/{id}' })
  })

  it('flags a response body that violates the schema, located by instance path', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42' },
      { status: 200, body: { id: 'not-an-int' } },
    )
    expect(r.valid).toBe(false)
    const kinds = r.findings.map((f) => f.kind)
    expect(kinds).toContain('response-schema')
    expect(JSON.stringify(r.findings)).toContain('/id')
    // 'name' is required and missing.
    expect(JSON.stringify(r.findings)).toContain('name')
  })

  it('resolves recursive $refs (manager is a User)', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42' },
      { status: 200, body: { id: 1, name: 'A', manager: { id: 2, name: 'B' } } },
    )
    expect(r.valid).toBe(true)
  })

  it('flags an undocumented status code as drift', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42' },
      { status: 500, body: { error: 'boom' } },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('undocumented-status')
  })

  it('flags a request to an operation absent from the spec', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'DELETE', path: '/users/42' },
      { status: 204, body: undefined },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('missing-operation')
    expect(r.operation).toBeUndefined()
  })

  it('passes a documented status that declares no body schema (e.g. 404)', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/99' },
      { status: 404, body: { message: 'nope' } },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toEqual([])
  })

  it('honors a lowercase 2xx range key (specs use both cases)', () => {
    const rangeSpec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            responses: {
              '2xx': { content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      },
    }
    const r = validateOpenApiResponse(
      rangeSpec,
      { method: 'GET', path: '/x' },
      { status: 200, body: {} },
    )
    expect(r.valid).toBe(true)
  })

  it("preserves a response schema's own $defs alongside component schemas", () => {
    const defsSpec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      $defs: { Local: { type: 'integer' } },
                      type: 'object',
                      required: ['v'],
                      properties: { v: { $ref: '#/$defs/Local' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Foo: { type: 'string' } } },
    }
    const ok = validateOpenApiResponse(
      defsSpec,
      { method: 'GET', path: '/x' },
      { status: 200, body: { v: 3 } },
    )
    expect(ok.valid).toBe(true)
    const bad = validateOpenApiResponse(
      defsSpec,
      { method: 'GET', path: '/x' },
      { status: 200, body: { v: 'x' } },
    )
    expect(bad.valid).toBe(false)
  })

  it('ignores a query string when matching the path', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42?expand=manager' },
      { status: 200, body: { id: 42, name: 'Ada' } },
    )
    expect(r.valid).toBe(true)
  })
})
