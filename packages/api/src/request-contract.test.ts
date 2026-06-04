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

// --- slice 4: NON-SCALAR query array params, form/explode=true ONLY (ADR 0014 tail).
// explode=false comma-arrays + path/header/spaceDelimited/pipeDelimited are STAGED.
const arrspec = {
  openapi: '3.1.0',
  paths: {
    '/tags': {
      get: {
        parameters: [
          { name: 't', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/ids': {
      get: {
        parameters: [
          { name: 'id', in: 'query', schema: { type: 'array', items: { type: 'integer' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/min2': {
      get: {
        parameters: [
          {
            name: 'id',
            in: 'query',
            schema: { type: 'array', items: { type: 'integer' }, minItems: 2 },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/max1': {
      get: {
        parameters: [
          {
            name: 'id',
            in: 'query',
            schema: { type: 'array', items: { type: 'integer' }, maxItems: 1 },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/uniq': {
      get: {
        parameters: [
          {
            name: 'u',
            in: 'query',
            schema: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/objitems': {
      get: {
        parameters: [
          { name: 'o', in: 'query', schema: { type: 'array', items: { type: 'object' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/tuple': {
      get: {
        parameters: [
          {
            name: 'p',
            in: 'query',
            schema: { type: 'array', prefixItems: [{ type: 'integer' }, { type: 'string' }] },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/req': {
      get: {
        parameters: [
          {
            name: 'r',
            in: 'query',
            required: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    // a SCALAR query param — used for the repeated-key wiring regression.
    '/scalar': {
      get: {
        parameters: [{ name: 's', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}

describe('validateOpenApiRequest — slice 4: query array params (form/explode=true)', () => {
  it('≥2 occurrences of a string-array param ⇒ valid (the values ARE the array)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/tags', query: { t: ['a', 'b'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBeUndefined()
  })

  it('≥2 occurrences of an integer-array param ⇒ each element coerced + validated', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/ids', query: { id: ['1', '2'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('bad element in an integer array ⇒ param-schema echoing the RAW element', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/ids', query: { id: ['1', 'x'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    const f = r.findings.find((x) => x.kind === 'param-schema')
    expect(f?.path).toBe('id')
    expect(f?.message).toContain('x')
  })

  it('single occurrence, no comma, no cardinality ⇒ wrapped [v] and validated', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/tags', query: { t: 'a' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBeUndefined()
  })

  it('single occurrence containing a comma ⇒ unverified (explode-disagreement ambiguity)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/tags', query: { t: 'a,b' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('single occurrence + cardinality constraint ⇒ unverified (can not prove count from 1 occ)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/min2', query: { id: '5' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('≥2 occurrences satisfying minItems ⇒ valid (true count is known)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/min2', query: { id: ['1', '2'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('≥2 occurrences violating maxItems ⇒ param-schema (count is known and sound)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/max1', query: { id: ['1', '2'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('≥2 occurrences violating uniqueItems ⇒ param-schema', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/uniq', query: { u: ['a', 'a'] } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('non-scalar array items ⇒ unverified (no element splitter)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/objitems', query: { o: ['a', 'b'] } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('prefixItems (tuple) array ⇒ unverified (heterogeneous, staged)', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/tuple', query: { p: ['1', 'a'] } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('required array param absent + authoritative ⇒ missing-required-param', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/req', query: {} },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    const f = r.findings.find((x) => x.kind === 'missing-required-param')
    expect(f?.path).toBe('r')
  })

  it('required array param absent + NOT authoritative ⇒ unverified', () => {
    const r = validateOpenApiRequest(arrspec, { method: 'GET', path: '/req', query: {} })
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('WIRING: a SCALAR query param with a repeated key ⇒ unverified, no false finding', () => {
    const r = validateOpenApiRequest(
      arrspec,
      { method: 'GET', path: '/scalar', query: { s: ['x', 'y'] } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })
})

// --- slice 5: undocumented-param suppression around OBJECT query params.
// Object-param VALIDATION stays staged (unverified); the suppression must land now
// so exploded-object/deepObject property keys never false-fire undocumented-param.
const objspec = {
  openapi: '3.1.0',
  components: {
    parameters: {
      ExtRef: { $ref: 'external.yaml#/components/parameters/X' },
    },
  },
  paths: {
    '/obj': {
      get: {
        parameters: [
          {
            name: 'color',
            in: 'query',
            style: 'form',
            explode: true,
            schema: {
              type: 'object',
              properties: { R: { type: 'integer' }, G: { type: 'integer' } },
              additionalProperties: false,
            },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/deep': {
      get: {
        parameters: [
          {
            name: 'color',
            in: 'query',
            style: 'deepObject',
            schema: { type: 'object', properties: { R: { type: 'integer' } } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/scalar': {
      get: {
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/extref': {
      get: {
        parameters: [{ $ref: 'external.yaml#/components/parameters/X' }],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}

describe('validateOpenApiRequest — slice 5: object-param undocumented suppression', () => {
  it('form/explode=true object ⇒ unverified, and its property keys are NOT undocumented', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/obj', query: { R: '100', G: '200' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('form/explode=true object present ⇒ ENTIRE undoc pass suppressed (shared namespace)', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/obj', query: { R: '100', G: '200', surprise: '1' } },
      { paramsAuthoritative: true },
    )
    // `surprise` cannot be told apart from an object property ⇒ NOT flagged.
    expect(r.findings.map((f) => f.kind)).not.toContain('undocumented-param')
    expect(r.unverified).toBe(true)
  })

  it('deepObject ⇒ unverified, and name[prop] bracket keys are NOT undocumented', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/deep', query: { 'color[R]': '100' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings.map((f) => f.kind)).not.toContain('undocumented-param')
    expect(r.unverified).toBe(true)
  })

  it('deepObject + a plain extra key ⇒ the plain key IS flagged, bracket keys are not', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/deep', query: { 'color[R]': '100', surprise: '1' } },
      { paramsAuthoritative: true },
    )
    const f = r.findings.find((x) => x.kind === 'undocumented-param')
    expect(f?.path).toBe('surprise')
    expect(r.unverified).toBe(true)
  })

  it('REGRESSION: scalar param + an undeclared key still flags exactly the undeclared key', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/scalar', query: { q: 'x', surprise: '1' } },
      { paramsAuthoritative: true },
    )
    const f = r.findings.find((x) => x.kind === 'undocumented-param')
    expect(f?.path).toBe('surprise')
    expect(r.unverified).toBeUndefined()
  })

  it('unresolved non-local $ref query param ⇒ undoc pass suppressed (could be an object)', () => {
    const r = validateOpenApiRequest(
      objspec,
      { method: 'GET', path: '/extref', query: { anything: '1' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings.map((f) => f.kind)).not.toContain('undocumented-param')
    expect(r.unverified).toBe(true)
  })
})

// --- slice 6: DELIMITED array serializations (ADR 0016). A single delimited string is
// split; CHECK only when items are NON-STRING scalars (integer/number/boolean) — the
// delimiter provably can't occur inside such an element, so the split is exact and both
// element + cardinality validation are sound. String/typeless items, empty segments,
// and label/matrix styles stay `unverified`.
const dspec = {
  openapi: '3.1.0',
  paths: {
    '/q-form-false': {
      get: {
        parameters: [
          {
            name: 'ids',
            in: 'query',
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { type: 'integer' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/q-form-false-str': {
      get: {
        parameters: [
          {
            name: 'tags',
            in: 'query',
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/q-form-false-max2': {
      get: {
        parameters: [
          {
            name: 'ids',
            in: 'query',
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { type: 'integer' }, maxItems: 2 },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/q-space': {
      get: {
        parameters: [
          {
            name: 'ids',
            in: 'query',
            style: 'spaceDelimited',
            explode: false,
            schema: { type: 'array', items: { type: 'integer' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/q-pipe': {
      get: {
        parameters: [
          {
            name: 'ns',
            in: 'query',
            style: 'pipeDelimited',
            explode: false,
            schema: { type: 'array', items: { type: 'number' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/p-simple/{ids}': {
      get: {
        parameters: [
          {
            name: 'ids',
            in: 'path',
            required: true,
            schema: { type: 'array', items: { type: 'integer' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/p-label/{ids}': {
      get: {
        parameters: [
          {
            name: 'ids',
            in: 'path',
            required: true,
            style: 'label',
            schema: { type: 'array', items: { type: 'integer' } },
          },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/h-simple': {
      get: {
        parameters: [
          { name: 'X-Ids', in: 'header', schema: { type: 'array', items: { type: 'integer' } } },
        ],
        responses: { '200': { description: 'ok' } },
      },
    },
  },
}

describe('validateOpenApiRequest — slice 6: delimited array params (non-string-scalar)', () => {
  it('query form/explode=false integer array ⇒ split on comma + validated', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-form-false', query: { ids: '1,2,3' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBeUndefined()
  })

  it('a single-element explode=false value (no delimiter) ⇒ [v] + validated', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-form-false', query: { ids: '5' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('bad element in a delimited integer array ⇒ param-schema echoing the raw element', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-form-false', query: { ids: '1,x' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    const f = r.findings.find((x) => x.kind === 'param-schema')
    expect(f?.path).toBe('ids')
    expect(f?.message).toContain('x')
  })

  it('STRING-item delimited array ⇒ unverified (embedded-delimiter is unsound)', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-form-false-str', query: { tags: 'a,b' } },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })

  it('an empty segment (trailing/internal comma) ⇒ unverified (ambiguous)', () => {
    expect(
      validateOpenApiRequest(
        dspec,
        { method: 'GET', path: '/q-form-false', query: { ids: '1,,3' } },
        { paramsAuthoritative: true },
      ).unverified,
    ).toBe(true)
    expect(
      validateOpenApiRequest(
        dspec,
        { method: 'GET', path: '/q-form-false', query: { ids: '1,' } },
        { paramsAuthoritative: true },
      ).unverified,
    ).toBe(true)
  })

  it('explode=false cardinality is sound (maxItems:2 with 3 elements ⇒ param-schema)', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-form-false-max2', query: { ids: '1,2,3' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('spaceDelimited integer array ⇒ split on space', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-space', query: { ids: '1 2 3' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('pipeDelimited number array ⇒ split on pipe', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/q-pipe', query: { ns: '1.5|2.5' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('path simple integer array ⇒ split the segment on comma', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/p-simple/1,2,3' },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('path simple bad element ⇒ param-schema', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/p-simple/1,x' },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(false)
    expect(r.findings.map((f) => f.kind)).toContain('param-schema')
  })

  it('header simple integer array ⇒ split on comma, trimming whitespace', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/h-simple', headers: { 'x-ids': '1, 2, 3' } },
      { paramsAuthoritative: true },
    )
    expect(r.valid).toBe(true)
    expect(r.findings).toHaveLength(0)
  })

  it('path LABEL array ⇒ unverified (staged style, never a false fail)', () => {
    const r = validateOpenApiRequest(
      dspec,
      { method: 'GET', path: '/p-label/.1.2.3' },
      { paramsAuthoritative: true },
    )
    expect(r.findings).toHaveLength(0)
    expect(r.unverified).toBe(true)
  })
})
