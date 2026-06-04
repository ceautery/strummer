import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import { harEntriesToFacts, validateCapturedTraffic } from './har-capture.js'

// A REAL Playwright-emitted HAR (.zip, content:'attach') captured offline against
// an in-process app — see the generator in the commit message. It holds: GET /
// (text/html), GET /styles.css (text/css), GET /api/v1/widgets (200 JSON, valid),
// GET /api/v1/widgets/1 (200 JSON whose `id` is a string — a schema violation).
const HAR = readFileSync(
  fileURLToPath(new URL('../test/fixtures/widgets-capture.har.zip', import.meta.url)),
)

// A REAL Playwright content:'attach' HAR of a browser issuing a GraphQL POST to
// /graphql (`query Widgets { widgets { id name } }`, operationName "Widgets") with
// the response { data: { widgets: [{id,name}, ...] } }. Generated offline against
// an in-process GraphQL endpoint (see the gen-graphql-har.mjs generator in the
// commit message). NOTE: attach-mode puts the request postData in a `_file` entry,
// so this fixture exercises the attached request-body resolution path.
const GQL_HAR = readFileSync(
  fileURLToPath(new URL('../test/fixtures/graphql-capture.har.zip', import.meta.url)),
)
// The schema the captured `{ widgets { id name } }` operation conforms to.
const GQL_SDL = `
  type Query { widgets: [Widget!]! }
  type Widget { id: ID!, name: String }
`
const GQL_REAL = { endpointPath: '/graphql', sdl: GQL_SDL }
// Same schema with `name` removed — the captured query now drifts.
const GQL_SDL_DRIFT = `
  type Query { widgets: [Widget!]! }
  type Widget { id: ID! }
`

// A tiny OpenAPI doc with a /api/v1 server base path. `/unused` is documented but
// never exercised by the capture; `/widgets/{id}` requires an integer `id`.
const SPEC = {
  openapi: '3.1.0',
  servers: [{ url: '/api/v1' }],
  paths: {
    '/widgets': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['widgets'],
                  properties: { widgets: { type: 'array' } },
                },
              },
            },
          },
        },
      },
    },
    '/widgets/{id}': {
      get: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'integer' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/unused': { get: { responses: { '200': {} } } },
  },
}

describe('harEntriesToFacts — slice 2 (attach/zip body resolution)', () => {
  it('resolves the JSON API entry to method + pathname + parsed body', () => {
    const facts = harEntriesToFacts(HAR)
    const widgets = facts.find((f) => f.req.path === '/api/v1/widgets')
    expect(widgets).toBeDefined()
    expect(widgets?.req.method).toBe('GET')
    expect(widgets?.res.status).toBe(200)
    expect(widgets?.mimeType).toBe('application/json')
    // body is JSON-PARSED, not a raw string — the validator consumes a parsed body.
    expect(widgets?.res.body).toEqual({ widgets: [{ id: 1, name: 'alpha' }] })
    expect(widgets?.unresolvedBody).toBeUndefined()
  })

  it('reduces the URL to pathname + a separate origin (no host in the path)', () => {
    const facts = harEntriesToFacts(HAR)
    const widgets = facts.find((f) => f.req.path === '/api/v1/widgets')
    expect(widgets?.req.path).not.toContain('http')
    expect(widgets?.req.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('keeps non-API entries (html/css) but does not JSON-parse them', () => {
    const facts = harEntriesToFacts(HAR)
    expect(facts.some((f) => f.mimeType === 'text/html')).toBe(true)
    expect(facts.some((f) => f.mimeType === 'text/css')).toBe(true)
  })

  it('an attached body missing from the archive is a hard unresolvedBody, not an empty pass', () => {
    // Hand-author a minimal HAR zip whose entry references a _file that is absent.
    const har = {
      log: {
        entries: [
          {
            request: { method: 'GET', url: 'http://x/api/v1/widgets' },
            response: {
              status: 200,
              content: { mimeType: 'application/json', _file: 'gone.json' },
            },
          },
        ],
      },
    }
    // zip it with fflate the same way Playwright would name the .har entry
    const zip = Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
    const facts = harEntriesToFacts(zip)
    expect(facts[0]?.unresolvedBody).toBeDefined()
    expect(facts[0]?.res.body).toBeUndefined()
  })

  it('resolves an inline request postData (text) into a parsed req.body', () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'http://x/graphql',
              postData: {
                mimeType: 'application/json',
                text: JSON.stringify({ query: '{ widget { id } }' }),
              },
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
          },
        ],
      },
    }
    const zip = Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
    const facts = harEntriesToFacts(zip)
    expect(facts[0]?.req.body).toEqual({ query: '{ widget { id } }' })
  })

  it('resolves an attached (_file) request postData into a parsed req.body', () => {
    const reqFile = 'req0.json'
    const har = {
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'http://x/graphql',
              postData: { mimeType: 'application/json', _file: reqFile },
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
          },
        ],
      },
    }
    const zip = Buffer.from(
      zipSync({
        'har.har': strToU8(JSON.stringify(har)),
        [reqFile]: strToU8(JSON.stringify({ query: '{ widget { id } }', operationName: 'W' })),
      }),
    )
    const facts = harEntriesToFacts(zip)
    expect(facts[0]?.req.body).toEqual({ query: '{ widget { id } }', operationName: 'W' })
  })
})

// A hand-authored GraphQL HAR (.zip) shaped like Playwright's content:'attach' output:
// a POST to a GraphQL endpoint with an inline JSON request body ({query, operationName?})
// and an attached JSON response body ({data} or {errors}). (No real-capture: the request
// postData shape is HAR-spec-stable; see the commit message.)
function graphqlHar(opts: {
  query: string
  operationName?: string
  variables?: unknown
  response: unknown
  endpoint?: string
  origin?: string
}): Buffer {
  const endpoint = opts.endpoint ?? '/graphql'
  const origin = opts.origin ?? 'http://127.0.0.1:5099'
  const resFile = 'gqlres0.json'
  const har = {
    log: {
      creator: { name: 'Playwright', version: '1.60.0' },
      entries: [
        {
          request: {
            method: 'POST',
            url: `${origin}${endpoint}`,
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({
                query: opts.query,
                ...(opts.operationName ? { operationName: opts.operationName } : {}),
                ...(opts.variables !== undefined ? { variables: opts.variables } : {}),
              }),
            },
          },
          response: {
            status: 200,
            content: { mimeType: 'application/json', _file: resFile },
          },
        },
      ],
    },
  }
  return Buffer.from(
    zipSync({
      'har.har': strToU8(JSON.stringify(har)),
      [resFile]: strToU8(JSON.stringify(opts.response)),
    }),
  )
}

describe('validateCapturedTraffic — GraphQL drift over a REAL capture (ADR 0013 §5)', () => {
  it('resolves the attached (_file) GraphQL request body into the query', () => {
    // The real attach-mode capture stores postData in a `_file` entry.
    const facts = harEntriesToFacts(GQL_HAR)
    const gql = facts.find((f) => f.req.path === '/graphql')
    expect(gql?.req.method).toBe('POST')
    expect(gql?.req.body).toEqual({
      query: 'query Widgets { widgets { id name } }',
      operationName: 'Widgets',
    })
  })

  it('validates the captured operation against a conformant SDL (clean=true)', () => {
    const v = validateCapturedTraffic(GQL_HAR, { graphql: GQL_REAL })
    expect(v.entriesValidated).toBe(1) // only the /graphql JSON entry (GET / is html)
    expect(v.clean).toBe(true)
    expect(v.results.every((r) => r.valid)).toBe(true)
  })

  it('flags query-vs-schema drift when the SDL drops a queried field', () => {
    const v = validateCapturedTraffic(GQL_HAR, {
      graphql: { endpointPath: '/graphql', sdl: GQL_SDL_DRIFT },
    })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['graphql-validation']).toBeGreaterThanOrEqual(1)
    expect(v.firstFailing?.kind).toBe('graphql-validation')
  })

  it('folds a captured GraphQL variable that cannot be verified into noSignal (never a pass)', () => {
    // A custom scalar the SDL cannot validate → unverified → noSignal → clean:false.
    const sdl = `
      scalar DateTime
      type Query { events(at: DateTime!): Event }
      type Event { id: ID! }
    `
    const har = graphqlHar({
      query: 'query E($at: DateTime!) { events(at: $at) { id } }',
      variables: { at: { anything: true } },
      response: { data: { events: { id: '1' } } },
    })
    const v = validateCapturedTraffic(har, { graphql: { endpointPath: '/graphql', sdl } })
    expect(v.clean).toBe(false)
    expect(v.noSignal).toBeGreaterThanOrEqual(1)
    expect(v.findingsByKind['graphql-variable-unverified']).toBeGreaterThanOrEqual(1)
  })

  it('flags a captured GraphQL variable whose present value is the wrong type', () => {
    const sdl = `
      type Query { thing(id: Int!): Thing }
      type Thing { id: Int! }
    `
    const har = graphqlHar({
      query: 'query T($id: Int!) { thing(id: $id) { id } }',
      variables: { id: 'not-an-int' },
      response: { data: { thing: { id: 1 } } },
    })
    const v = validateCapturedTraffic(har, { graphql: { endpointPath: '/graphql', sdl } })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['graphql-variable-invalid']).toBeGreaterThanOrEqual(1)
  })

  it('a captured GraphQL request with conformant variables stays clean', () => {
    const sdl = `
      type Query { thing(id: Int!): Thing }
      type Thing { id: Int! }
    `
    const har = graphqlHar({
      query: 'query T($id: Int!) { thing(id: $id) { id } }',
      variables: { id: 7 },
      response: { data: { thing: { id: 7 } } },
    })
    const v = validateCapturedTraffic(har, { graphql: { endpointPath: '/graphql', sdl } })
    expect(v.clean).toBe(true)
    expect(v.noSignal).toBe(0)
  })

  it('detects GraphQL by the {query} request shape even without endpointPath', () => {
    // No endpointPath given, but the request body shape is GraphQL → still routed.
    const v = validateCapturedTraffic(GQL_HAR, { graphql: { endpointPath: '/nope', sdl: GQL_SDL } })
    expect(v.clean).toBe(true)
    expect(v.findingsByKind['graphql-sdl-not-supplied']).toBeUndefined()
  })

  it('a captured GraphQL entry with NO graphql contract is no-signal, never an OpenAPI fall-through', () => {
    // openapi-only contract: the graphql POST must NOT flood missing-operation.
    const v = validateCapturedTraffic(GQL_HAR, { openapi: SPEC })
    expect(v.findingsByKind['graphql-sdl-not-supplied']).toBe(1)
    expect(v.findingsByKind['missing-operation']).toBeUndefined()
    expect(v.clean).toBe(false)
  })

  it('routes GraphQL finding messages through the operator Redactor', () => {
    const redact = vi.fn((s: string) => s.replace(/name/gi, '‹redacted›'))
    const v = validateCapturedTraffic(
      GQL_HAR,
      { graphql: { endpointPath: '/graphql', sdl: GQL_SDL_DRIFT } },
      { redact },
    )
    expect(redact).toHaveBeenCalled()
    for (const r of v.results) for (const f of r.findings) expect(f.message).not.toContain('name')
  })

  it('validates REST entries via OpenAPI without flagging GraphQL (no cross-contamination)', () => {
    // The real REST HAR has no graphql entries: no graphql-sdl-not-supplied appears.
    const v = validateCapturedTraffic(HAR, { openapi: SPEC })
    expect(v.findingsByKind['graphql-sdl-not-supplied']).toBeUndefined()
    expect(v.exercisedOperations).toContain('GET /widgets')
  })
})

// Edge cases a single clean real capture can't express, over a hand-authored HAR
// shaped like the real one (POST + JSON request/response).
describe('validateCapturedTraffic — GraphQL edge cases (hand-authored HAR)', () => {
  const SDL = `
    type Query { widget(id: ID!): Widget }
    type Widget { id: ID!, name: String }
  `
  const GQL = { endpointPath: '/graphql', sdl: SDL }

  it('flags a response with a top-level errors[] as graphql-errors', () => {
    const har = graphqlHar({
      query: '{ widget(id: "1") { id name } }',
      response: { errors: [{ message: 'boom' }] },
    })
    const v = validateCapturedTraffic(har, { graphql: GQL })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['graphql-errors']).toBeGreaterThanOrEqual(1)
  })

  it('passes operationName through to the validator (named operation that exists)', () => {
    const har = graphqlHar({
      query: 'query W { widget(id: "1") { id name } }',
      operationName: 'W',
      response: { data: { widget: { id: '1', name: 'a' } } },
    })
    const v = validateCapturedTraffic(har, { graphql: GQL })
    expect(v.clean).toBe(true)
  })

  it('a request matching the GraphQL endpoint but carrying no query is a hard finding', () => {
    // A JSON POST to /graphql with no `query` field: matched by endpointPath, but
    // nothing to validate → graphql-no-query, never an empty pass.
    const har = {
      log: {
        entries: [
          {
            request: {
              method: 'POST',
              url: 'http://x/graphql',
              postData: { mimeType: 'application/json', text: JSON.stringify({ notAQuery: 1 }) },
            },
            response: { status: 200, content: { mimeType: 'application/json', text: '{}' } },
          },
        ],
      },
    }
    const zip = Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
    const v = validateCapturedTraffic(zip, { graphql: GQL })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['graphql-no-query']).toBe(1)
  })
})

describe('validateCapturedTraffic — slices 3/4/5 (filter, base-path, drive + drift)', () => {
  it('validates only JSON API entries (html/css filtered out)', () => {
    const v = validateCapturedTraffic(HAR, { openapi: SPEC })
    // Two JSON entries; html + css skipped.
    expect(v.entriesValidated).toBe(2)
  })

  it('reconciles the /api/v1 server base path so /api/v1/widgets matches /widgets', () => {
    const v = validateCapturedTraffic(HAR, { openapi: SPEC })
    // /widgets is valid; no missing-operation for it.
    expect(v.exercisedOperations).toContain('GET /widgets')
    expect(v.exercisedOperations).toContain('GET /widgets/{id}')
  })

  it('surfaces a real response-schema drift on the violating body, and a first-failing headline', () => {
    const v = validateCapturedTraffic(HAR, { openapi: SPEC })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['response-schema']).toBeGreaterThanOrEqual(1)
    expect(v.firstFailing?.path).toBe('/widgets/{id}')
    expect(v.firstFailing?.kind).toBe('response-schema')
  })

  it('computes the exercised/unexercised drift walk over spec.paths × methods', () => {
    const v = validateCapturedTraffic(HAR, { openapi: SPEC })
    expect(v.unexercisedOperations).toEqual(['GET /unused'])
  })

  it('routes every finding message through the operator Redactor', () => {
    const redact = vi.fn((s: string) => s.replace(/widgets/gi, '‹redacted›'))
    const v = validateCapturedTraffic(HAR, { openapi: SPEC }, { redact })
    expect(redact).toHaveBeenCalled()
    for (const r of v.results) {
      for (const f of r.findings) expect(f.message).not.toContain('widgets')
    }
  })

  it('an empty/zero-entry capture is never clean (absence is never a pass)', () => {
    const empty = Buffer.from(
      zipSync({ 'har.har': strToU8(JSON.stringify({ log: { entries: [] } })) }),
    )
    const v = validateCapturedTraffic(empty, { openapi: SPEC })
    expect(v.entriesValidated).toBe(0)
    expect(v.clean).toBe(false)
  })
})

// ─── slices 4a/4b — request-side contract validation over the capture bridge ───
const SPEC_REQ = {
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
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/search': {
      get: {
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
        responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/log': {
      // declares NO requestBody.
      post: {
        responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/keys': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['apikey'],
                properties: { apikey: { type: 'string' } },
              },
            },
          },
        },
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
}

function restHar(opts: {
  method: string
  url: string
  reqHeaders?: Record<string, string>
  reqBody?: unknown
  status: number
  resBody: unknown
}): Buffer {
  const har = {
    log: {
      entries: [
        {
          request: {
            method: opts.method,
            url: opts.url,
            headers: Object.entries(opts.reqHeaders ?? {}).map(([name, value]) => ({
              name,
              value,
            })),
            ...(opts.reqBody !== undefined
              ? { postData: { mimeType: 'application/json', text: JSON.stringify(opts.reqBody) } }
              : {}),
          },
          response: {
            status: opts.status,
            content: { mimeType: 'application/json', text: JSON.stringify(opts.resBody) },
          },
        },
      ],
    },
  }
  return Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
}

describe('harEntriesToFacts — slice 4a (capture query + headers)', () => {
  it('populates req.query (repeated keys → array) and lower-cased req.headers', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/widgets?debug=1&tag=a&tag=b',
      reqHeaders: { 'Content-Type': 'application/json', 'X-Trace': 't' },
      reqBody: { name: 'g' },
      status: 201,
      resBody: {},
    })
    const [e] = harEntriesToFacts(har)
    expect(e?.req.query).toEqual({ debug: '1', tag: ['a', 'b'] })
    expect(e?.req.headers?.['content-type']).toBe('application/json')
    expect(e?.req.headers?.['x-trace']).toBe('t')
  })
})

describe('validateCapturedTraffic — slice 4b (request validation folded into the verdict)', () => {
  const json = { 'content-type': 'application/json' }

  it('a request body violating the spec ⇒ clean:false + request-body-schema', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/widgets',
      reqHeaders: json,
      reqBody: { wrong: 1 },
      status: 201,
      resBody: {},
    })
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ })
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['request-body-schema']).toBeGreaterThanOrEqual(1)
    expect(v.firstFailing?.kind).toBe('request-body-schema')
  })

  it('a valid request body keeps the capture clean (no spurious missing-required-body)', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/widgets',
      reqHeaders: json,
      reqBody: { name: 'g' },
      status: 201,
      resBody: {},
    })
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ })
    expect(v.clean).toBe(true)
    expect(v.findingsByKind['missing-required-body']).toBeUndefined()
  })

  it('an op with a required query param the capture lacks ⇒ noSignal, never a clean pass', () => {
    const har = restHar({
      method: 'GET',
      url: 'https://api.test/search',
      status: 200,
      resBody: {},
    })
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ })
    expect(v.noSignal).toBeGreaterThanOrEqual(1)
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['request-unverified']).toBeGreaterThanOrEqual(1)
    // NOT a hard finding — the capture isn't authoritative about params.
    expect(v.findingsByKind['missing-required-param']).toBeUndefined()
  })

  it('a present-but-uncheckable body (undocumented-body) ⇒ noSignal, never a clean pass', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/log',
      reqHeaders: json,
      reqBody: { x: 1 },
      status: 200,
      resBody: {},
    })
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ })
    expect(v.findingsByKind['undocumented-body']).toBeGreaterThanOrEqual(1)
    expect(v.noSignal).toBeGreaterThanOrEqual(1)
    expect(v.clean).toBe(false)
  })

  it('does not double-count missing-operation across request + response validation', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/ghost',
      reqHeaders: json,
      reqBody: { x: 1 },
      status: 200,
      resBody: {},
    })
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ })
    expect(v.findingsByKind['missing-operation']).toBe(1)
    expect(v.clean).toBe(false)
  })

  it('redacts a secret-bearing finding path AND message at the single chokepoint', () => {
    const har = restHar({
      method: 'POST',
      url: 'https://api.test/keys',
      reqHeaders: json,
      reqBody: { apikey: 12345 }, // number where a string is required → /apikey error
      status: 201,
      resBody: {},
    })
    const redact = (s: string) => s.split('apikey').join('‹redacted›')
    const v = validateCapturedTraffic(har, { openapi: SPEC_REQ }, { redact })
    const f = v.results.flatMap((r) => r.findings).find((x) => x.kind === 'request-body-schema')
    expect(f).toBeDefined()
    expect(f?.message).not.toContain('apikey')
    expect(f?.path ?? '').not.toContain('apikey') // fork-1: path is redacted too
  })
})

// ─── ADR 0016 addendum 4 follow-up — FORM bodies over the capture bridge ───
const SPEC_FORM = {
  openapi: '3.1.0',
  paths: {
    '/form': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['name', 'age'],
                properties: {
                  name: { type: 'string' },
                  age: { type: 'integer' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/upload': {
      post: {
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string' },
                  avatar: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/secret-form': {
      post: {
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['apikey'],
                properties: { apikey: { type: 'integer' } },
              },
            },
          },
        },
        responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
  },
}

/** A HAR with a single form-body request entry + a JSON response (so it is routed). */
function formHar(opts: {
  url: string
  contentType: string
  params?: { name: string; value?: string; fileName?: string }[]
  text?: string
}): Buffer {
  const postData: Record<string, unknown> = { mimeType: opts.contentType }
  if (opts.params) postData.params = opts.params
  if (opts.text !== undefined) postData.text = opts.text
  const har = {
    log: {
      entries: [
        {
          request: {
            method: 'POST',
            url: opts.url,
            headers: [{ name: 'Content-Type', value: opts.contentType }],
            postData,
          },
          response: {
            status: 201,
            content: { mimeType: 'application/json', text: '{}' },
          },
        },
      ],
    },
  }
  return Buffer.from(zipSync({ 'har.har': strToU8(JSON.stringify(har)) }))
}

describe('harEntriesToFacts — form-body resolution (ADR 0016 add.4 capture path)', () => {
  it('resolves form-urlencoded postData.params[] into req.form (repeated keys → array)', () => {
    const [e] = harEntriesToFacts(
      formHar({
        url: 'https://api.test/form',
        contentType: 'application/x-www-form-urlencoded',
        params: [
          { name: 'name', value: 'gizmo' },
          { name: 'tags', value: 'a' },
          { name: 'tags', value: 'b' },
        ],
      }),
    )
    expect(e?.req.form).toEqual({ name: 'gizmo', tags: ['a', 'b'] })
    expect(e?.req.formFileFields).toBeUndefined()
  })

  it('falls back to parsing urlencoded postData.text when params[] is absent', () => {
    const [e] = harEntriesToFacts(
      formHar({
        url: 'https://api.test/form',
        contentType: 'application/x-www-form-urlencoded',
        text: 'name=gizmo&tags=a&tags=b',
      }),
    )
    expect(e?.req.form).toEqual({ name: 'gizmo', tags: ['a', 'b'] })
  })

  it('resolves multipart params: text parts → form, FILE parts (fileName) → formFileFields', () => {
    const [e] = harEntriesToFacts(
      formHar({
        url: 'https://api.test/upload',
        contentType: 'multipart/form-data; boundary=----x',
        params: [
          { name: 'title', value: 'hi' },
          { name: 'avatar', fileName: 'a.png' },
        ],
      }),
    )
    expect(e?.req.form).toEqual({ title: 'hi' })
    expect(e?.req.formFileFields).toEqual(['avatar'])
  })

  it('a multipart body with no params (raw _file/text only) leaves form unset (no unsound parse)', () => {
    const [e] = harEntriesToFacts(
      formHar({
        url: 'https://api.test/upload',
        contentType: 'multipart/form-data; boundary=----x',
        text: '------x\r\nContent-Disposition: form-data; name="title"\r\n\r\nhi\r\n------x--',
      }),
    )
    expect(e?.req.form).toBeUndefined()
  })
})

describe('validateCapturedTraffic — form bodies (non-authoritative capture path)', () => {
  it('a form-urlencoded field violating the schema ⇒ clean:false + request-body-schema', () => {
    const v = validateCapturedTraffic(
      formHar({
        url: 'https://api.test/form',
        contentType: 'application/x-www-form-urlencoded',
        params: [
          { name: 'name', value: 'gizmo' },
          { name: 'age', value: 'abc' }, // not an integer — a TRUE finding (the wire sent it)
        ],
      }),
      { openapi: SPEC_FORM },
    )
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['request-body-schema']).toBeGreaterThanOrEqual(1)
  })

  it('a conformant form-urlencoded body keeps the capture clean', () => {
    const v = validateCapturedTraffic(
      formHar({
        url: 'https://api.test/form',
        contentType: 'application/x-www-form-urlencoded',
        params: [
          { name: 'name', value: 'gizmo' },
          { name: 'age', value: '5' },
          { name: 'tags', value: 'a' },
          { name: 'tags', value: 'b' },
        ],
      }),
      { openapi: SPEC_FORM },
    )
    expect(v.clean).toBe(true)
    expect(v.findingsByKind['request-body-schema']).toBeUndefined()
  })

  it('an absent REQUIRED form field (non-authoritative) ⇒ noSignal, never a false finding', () => {
    const v = validateCapturedTraffic(
      formHar({
        url: 'https://api.test/form',
        contentType: 'application/x-www-form-urlencoded',
        params: [{ name: 'name', value: 'gizmo' }], // `age` absent — capture isn't authoritative
      }),
      { openapi: SPEC_FORM },
    )
    expect(v.noSignal).toBeGreaterThanOrEqual(1)
    expect(v.clean).toBe(false)
    expect(v.findingsByKind['request-unverified']).toBeGreaterThanOrEqual(1)
    expect(v.findingsByKind['request-body-schema']).toBeUndefined()
  })

  it('a declared prop satisfied by a multipart FILE part ⇒ unverified (noSignal), never a pass', () => {
    const v = validateCapturedTraffic(
      formHar({
        url: 'https://api.test/upload',
        contentType: 'multipart/form-data; boundary=----x',
        params: [
          { name: 'title', value: 'hi' },
          { name: 'avatar', fileName: 'a.png' }, // declared `avatar` is file-backed
        ],
      }),
      { openapi: SPEC_FORM },
    )
    expect(v.noSignal).toBeGreaterThanOrEqual(1)
    expect(v.clean).toBe(false)
  })

  it('redacts a secret form field value echoed in a coercion finding', () => {
    const secret = 'sk-live-abc123'
    const v = validateCapturedTraffic(
      formHar({
        url: 'https://api.test/secret-form',
        contentType: 'application/x-www-form-urlencoded',
        params: [{ name: 'apikey', value: secret }], // not an integer ⇒ finding echoing the value
      }),
      { openapi: SPEC_FORM },
      { redact: (s) => s.split(secret).join('‹redacted›') },
    )
    const f = v.results.flatMap((r) => r.findings).find((x) => x.kind === 'request-body-schema')
    expect(f).toBeDefined()
    expect(f?.message).not.toContain(secret)
  })
})
