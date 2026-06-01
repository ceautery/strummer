import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateOpenApiResponse } from './contract.js'

const here = dirname(fileURLToPath(import.meta.url))
const OPENAPI_DIR = resolve(here, '../test/fixtures/openapi')

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

describe('validateOpenApiResponse — OpenAPI 3.0 nullable shim', () => {
  const spec30 = {
    openapi: '3.0.3',
    paths: {
      '/u': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string', nullable: true },
                      age: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  it('honors nullable:true so an explicit null passes (3.1 would need type:[..,null])', () => {
    const r = validateOpenApiResponse(
      spec30,
      { method: 'GET', path: '/u' },
      {
        status: 200,
        body: { name: null },
      },
    )
    expect(r.valid).toBe(true)
  })

  it('still flags a real type mismatch after the shim', () => {
    const r = validateOpenApiResponse(
      spec30,
      { method: 'GET', path: '/u' },
      {
        status: 200,
        body: { name: 123 },
      },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('response-schema')
  })

  it('does NOT loosen a 3.1 doc (nullable is not a 3.1 keyword)', () => {
    const r = validateOpenApiResponse(
      spec,
      { method: 'GET', path: '/users/42' },
      {
        status: 200,
        body: { id: 42, name: 'Ada' },
      },
    )
    expect(r.valid).toBe(true)
  })
})

describe('validateOpenApiResponse — external local-file $ref deref', () => {
  const jsonSpec = {
    openapi: '3.1.0',
    paths: {
      '/users/{id}': {
        get: {
          responses: {
            '200': {
              content: { 'application/json': { schema: { $ref: './user.schema.json#/User' } } },
            },
          },
        },
      },
    },
  }

  it('resolves an external JSON $ref, including the file’s own internal $ref', () => {
    const ok = validateOpenApiResponse(
      jsonSpec,
      { method: 'GET', path: '/users/1' },
      {
        status: 200,
        body: { id: 1, pet: { name: 'Rex' } },
      },
      { baseDir: OPENAPI_DIR },
    )
    expect(ok.valid).toBe(true)

    // `pet.name` is required by the file-internal Pet schema — omit it ⇒ drift.
    const bad = validateOpenApiResponse(
      jsonSpec,
      { method: 'GET', path: '/users/1' },
      {
        status: 200,
        body: { id: 1, pet: {} },
      },
      { baseDir: OPENAPI_DIR },
    )
    expect(bad.valid).toBe(false)
    expect(bad.findings.map((f) => f.kind)).toContain('response-schema')
  })

  it('flags a top-level type mismatch through an external ref', () => {
    const bad = validateOpenApiResponse(
      jsonSpec,
      { method: 'GET', path: '/users/1' },
      {
        status: 200,
        body: { id: 'not-an-int' },
      },
      { baseDir: OPENAPI_DIR },
    )
    expect(bad.valid).toBe(false)
  })

  it('resolves an external YAML $ref', () => {
    const yamlSpec = {
      openapi: '3.1.0',
      paths: {
        '/tags': {
          get: {
            responses: {
              '200': {
                content: { 'application/json': { schema: { $ref: './common.schema.yaml#/Tag' } } },
              },
            },
          },
        },
      },
    }
    const ok = validateOpenApiResponse(
      yamlSpec,
      { method: 'GET', path: '/tags' },
      {
        status: 200,
        body: { label: 'urgent' },
      },
      { baseDir: OPENAPI_DIR },
    )
    expect(ok.valid).toBe(true)

    const bad = validateOpenApiResponse(
      yamlSpec,
      { method: 'GET', path: '/tags' },
      {
        status: 200,
        body: {},
      },
      { baseDir: OPENAPI_DIR },
    )
    expect(bad.valid).toBe(false)
  })
})
