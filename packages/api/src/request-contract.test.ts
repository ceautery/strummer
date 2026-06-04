import { describe, expect, it } from 'vitest'
import { validateOpenApiRequest } from './request-contract.js'

// A minimal 3.1 spec exercising required / optional / no-requestBody operations.
const spec = {
  openapi: '3.1.0',
  paths: {
    '/widgets': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/optional': {
      post: {
        // requestBody declared but NOT required → an absent body is fine.
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'ok' } },
      },
    },
    '/nobody': {
      // declares NO requestBody at all.
      post: { responses: { '200': { description: 'ok' } } },
    },
  },
}

describe('validateOpenApiRequest — slice 1: requestBody required + schema + presence authority', () => {
  it('unknown operation ⇒ missing-operation (error)', () => {
    const r = validateOpenApiRequest(spec, { method: 'POST', path: '/nope' })
    expect(r.valid).toBe(false)
    expect(r.findings[0]?.kind).toBe('missing-operation')
  })

  it('required body absent + bodyPresenceAuthoritative ⇒ missing-required-body (error)', () => {
    const r = validateOpenApiRequest(
      spec,
      { method: 'POST', path: '/widgets' },
      { bodyPresenceAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('missing-required-body')
    expect(r.unverified).toBeUndefined()
  })

  it('required body absent + NOT authoritative ⇒ no finding, unverified (absence is never a pass)', () => {
    const r = validateOpenApiRequest(spec, { method: 'POST', path: '/widgets' })
    expect(r.findings).toHaveLength(0)
    expect(r.valid).toBe(true) // valid has no ERROR, but unverified blocks a clean pass downstream
    expect(r.unverified).toBe(true)
  })

  it('optional body absent ⇒ valid, no finding, NOT unverified', () => {
    const r = validateOpenApiRequest(
      spec,
      { method: 'POST', path: '/optional' },
      { bodyPresenceAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBeUndefined()
  })

  it('body present but violates schema ⇒ request-body-schema (error)', () => {
    const r = validateOpenApiRequest(
      spec,
      { method: 'POST', path: '/widgets', body: { wrong: 1 } },
      { bodyPresenceAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('request-body-schema')
  })

  it('body present and valid ⇒ valid, no findings', () => {
    const r = validateOpenApiRequest(spec, {
      method: 'POST',
      path: '/widgets',
      body: { name: 'gizmo' },
    })
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBeUndefined()
  })

  it('body present where no requestBody is declared ⇒ undocumented-body (warning) + unverified', () => {
    const r = validateOpenApiRequest(spec, { method: 'POST', path: '/nobody', body: { x: 1 } })
    expect(r.valid).toBe(true) // warning, not error
    expect(r.findings.map((f) => f.kind)).toContain('undocumented-body')
    expect(r.findings[0]?.severity).toBe('warning')
    expect(r.unverified).toBe(true)
  })
})

const pspec = {
  openapi: '3.1.0',
  paths: {
    '/users/{id}': {
      get: {
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/search': {
      get: {
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/files/{name}.{ext}': {
      get: {
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'ext', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}

describe('validateOpenApiRequest — slice 2: parameters (scalars + coercion + path positional)', () => {
  it('required query param absent + paramsAuthoritative ⇒ missing-required-param', () => {
    const r = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/search', query: {} },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('missing-required-param')
    expect(r.findings[0]?.path).toBe('q')
  })

  it('required query param absent + NOT authoritative ⇒ no finding, unverified', () => {
    const r = validateOpenApiRequest(pspec, { method: 'GET', path: '/search', query: {} })
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('path scalar param extracted positionally and validated (good)', () => {
    const r = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/users/42' },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('path scalar param failing coercion ⇒ param-schema (integer id = abc)', () => {
    const r = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/users/abc' },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    const f = r.findings.find((x) => x.kind === 'param-schema')
    expect(f?.path).toBe('id')
    expect(f?.message).toContain('abc') // raw substring, never a coerced value
  })

  it('strict numeric coercion: "42" passes, "42abc" fails (param-schema)', () => {
    expect(
      validateOpenApiRequest(
        pspec,
        { method: 'GET', path: '/search', query: { q: 'x', limit: '42' } },
        { paramsAuthoritative: true },
      ).valid,
    ).toBe(true)
    const bad = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/search', query: { q: 'x', limit: '42abc' } },
      { paramsAuthoritative: true },
    )
    expect(bad.valid).toBe(false)
    expect(bad.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('boolean coercion: "true" passes, "TRUE" fails', () => {
    expect(
      validateOpenApiRequest(
        pspec,
        { method: 'GET', path: '/users/42', query: { verbose: 'true' } },
        { paramsAuthoritative: true },
      ).valid,
    ).toBe(true)
    expect(
      validateOpenApiRequest(
        pspec,
        { method: 'GET', path: '/users/42', query: { verbose: 'TRUE' } },
        { paramsAuthoritative: true },
      ).valid,
    ).toBe(false)
  })

  it('schema constraint past coercion is enforced (limit minimum:1, "0" fails)', () => {
    const r = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/search', query: { q: 'x', limit: '0' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('multi-param-per-segment path ⇒ inconclusive-skip (unverified, never false-fail)', () => {
    const r = validateOpenApiRequest(
      pspec,
      { method: 'GET', path: '/files/report.csv' },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })
})

describe('validateOpenApiRequest — slice 3: noise rules, media-type, $ref deref, 3.0 nullable params', () => {
  const nspec = {
    openapi: '3.1.0',
    components: {
      requestBodies: {
        WidgetBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
      parameters: {
        Limit: { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
      },
    },
    paths: {
      '/declared': {
        get: {
          parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/reffed': {
        // requestBody + a param via local $ref.
        post: {
          parameters: [{ $ref: '#/components/parameters/Limit' }],
          requestBody: { $ref: '#/components/requestBodies/WidgetBody' },
          responses: { '201': { description: 'created' } },
        },
      },
      '/nonlocal': {
        post: {
          requestBody: { $ref: 'external.yaml#/components/requestBodies/X' },
          responses: { '201': { description: 'created' } },
        },
      },
      '/typed': {
        post: {
          // declares only application/xml (non-JSON).
          requestBody: { content: { 'application/xml': { schema: { type: 'object' } } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  }

  it('undocumented query param ⇒ warning (query only)', () => {
    const r = validateOpenApiRequest(
      nspec,
      { method: 'GET', path: '/declared', query: { q: 'x', surprise: '1' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    const f = r.findings.find((x) => x.kind === 'undocumented-param')
    expect(f?.path).toBe('surprise')
  })

  it('undocumented HEADER ⇒ no finding (headers excluded)', () => {
    const r = validateOpenApiRequest(
      nspec,
      { method: 'GET', path: '/declared', query: { q: 'x' }, headers: { 'x-trace-id': 'abc' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
  })

  it('local $ref requestBody + $ref param are deref’d and validated', () => {
    const good = validateOpenApiRequest(
      nspec,
      { method: 'POST', path: '/reffed', body: { name: 'g' }, query: { limit: '5' } },
      { bodyPresenceAuthoritative: true, paramsAuthoritative: true },
    )
    expect(good.valid).toBe(true)
    const bad = validateOpenApiRequest(
      nspec,
      { method: 'POST', path: '/reffed', body: { wrong: 1 }, query: { limit: 'NaN' } },
      { bodyPresenceAuthoritative: true, paramsAuthoritative: true },
    )
    expect(bad.valid).toBe(false)
    expect(bad.findings.map((f) => f.kind).sort()).toEqual(['param-schema', 'request-body-schema'])
  })

  it('non-local $ref requestBody ⇒ inconclusive-skip + unverified, NEVER undocumented-body', () => {
    const r = validateOpenApiRequest(
      nspec,
      { method: 'POST', path: '/nonlocal', body: { anything: 1 } },
      { bodyPresenceAuthoritative: true },
    )
    expect(r.findings.map((f) => f.kind)).not.toContain('undocumented-body')
    expect(r.unverified).toBe(true)
  })

  it('Content-Type present but matches no declared media type ⇒ unsupported-media-type (warning) + unverified', () => {
    const r = validateOpenApiRequest(
      nspec,
      {
        method: 'POST',
        path: '/typed',
        body: { a: 1 },
        headers: { 'content-type': 'application/json' },
      },
      { bodyPresenceAuthoritative: true },
    )
    expect(r.findings.map((f) => f.kind)).toContain('unsupported-media-type')
    expect(r.findings[0]?.severity).toBe('warning')
    expect(r.unverified).toBe(true)
  })

  it('Content-Type ABSENT (capture path) + no JSON content key ⇒ unverified, NEVER unsupported-media-type', () => {
    const r = validateOpenApiRequest(nspec, { method: 'POST', path: '/typed', body: { a: 1 } })
    expect(r.findings.map((f) => f.kind)).not.toContain('unsupported-media-type')
    expect(r.unverified).toBe(true)
  })

  it('a 3.0 nullable:true query param accepts an empty value (shim applies to params)', () => {
    const spec30 = {
      openapi: '3.0.3',
      paths: {
        '/x': {
          get: {
            parameters: [{ name: 'n', in: 'query', schema: { type: 'integer', nullable: true } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const r = validateOpenApiRequest(
      spec30,
      { method: 'GET', path: '/x', query: { n: '' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })
})
