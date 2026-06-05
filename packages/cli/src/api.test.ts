import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from './index.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../../../fixtures/golden.sqlite')

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

// A real Bruno collection on disk + a real in-process HTTP target.
let server: Server
let baseUrl: string
let dir: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.split('?')[0] === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else if (req.url === '/things' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: true }))
    } else if (req.url === '/graphql' && req.method === 'POST') {
      // Drain the body, then return a clean GraphQL data payload (no errors).
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: { thing: { id: 1 } } }))
      })
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/health' })
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  dir = mkdtempSync(join(tmpdir(), 'sackville-cli-api-'))
  writeFileSync(
    join(dir, 'bruno.json'),
    JSON.stringify({ version: '1', name: 't', type: 'collection' }),
  )

  writeFileSync(
    join(dir, 'get-health.bru'),
    `meta {
  name: get-health
}
get {
  url: {{baseUrl}}/health
}
`,
  )
  writeFileSync(
    join(dir, 'get-health.sackville.yml'),
    `assertions:
  - source: status
    op: equals
    value: 200
`,
  )

  writeFileSync(
    join(dir, 'create-thing.bru'),
    `meta {
  name: create-thing
}
post {
  url: {{baseUrl}}/things
}
`,
  )

  writeFileSync(
    join(dir, 'follow-redirect.bru'),
    `meta {
  name: follow-redirect
}
get {
  url: {{baseUrl}}/redirect
}
`,
  )

  writeFileSync(
    join(dir, 'follow-redirect.sackville.yml'),
    `assertions:
  - source: status
    op: equals
    value: 200
`,
  )

  writeFileSync(
    join(dir, 'secret-req.bru'),
    `meta {
  name: secret-req
}
get {
  url: {{baseUrl}}/health
}
headers {
  Authorization: Bearer {{secret:API_TOKEN}}
}
`,
  )

  // GraphQL drift-check fixtures (offline).
  writeFileSync(
    join(dir, 'schema.graphql'),
    `type Query { user(id: ID!): User }
type User { id: ID! name: String! }
`,
  )
  writeFileSync(join(dir, 'good.graphql'), `{ user(id: "1") { id name } }`)
  writeFileSync(join(dir, 'bad.graphql'), `{ user(id: "1") { id bogusField } }`)

  // GraphQL request-variable validation fixtures (ADR 0015).
  writeFileSync(
    join(dir, 'thing-schema.graphql'),
    `type Query { thing(id: Int!): Thing }
type Thing { id: Int! }
`,
  )
  writeFileSync(join(dir, 'thing-query.graphql'), `query Q($id: Int!) { thing(id: $id) { id } }`)
  // A GraphQL run whose variable is the wrong type (string for Int!).
  writeFileSync(
    join(dir, 'gql-bad.bru'),
    `meta {
  name: gql-bad
}
post {
  url: {{baseUrl}}/graphql
  body: graphql
}
body:graphql {
  query Q($id: Int!) { thing(id: $id) { id } }
}
body:graphql:vars {
  {
    "id": "not-an-int"
  }
}
`,
  )
  // A GraphQL run with a conformant integer variable.
  writeFileSync(
    join(dir, 'gql-ok.bru'),
    `meta {
  name: gql-ok
}
post {
  url: {{baseUrl}}/graphql
  body: graphql
}
body:graphql {
  query Q($id: Int!) { thing(id: $id) { id } }
}
body:graphql:vars {
  {
    "id": 5
  }
}
`,
  )
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('cli api', () => {
  it('list shows request names', async () => {
    const c = capture()
    expect(await run(['api', 'list', dir], c.io)).toBe(0)
    expect(c.out()).toContain('get-health')
    expect(c.out()).toContain('create-thing')
  })

  it('list --json emits structured output', async () => {
    const c = capture()
    expect(await run(['api', 'list', dir, '--json'], c.io)).toBe(0)
    const parsed = JSON.parse(c.out())
    const names = parsed.requests.map((r: { name: string }) => r.name)
    expect(names).toContain('get-health')
  })

  it('get lists required secret NAMES (never values)', async () => {
    const c = capture()
    expect(await run(['api', 'get', dir, 'secret-req'], c.io)).toBe(0)
    expect(c.out()).toContain('API_TOKEN')
    expect(c.out()).not.toContain('Bearer {{secret')
    expect(c.out().toLowerCase()).toContain('required secrets')
  })

  it('get errors on an unknown request name', async () => {
    const c = capture()
    expect(await run(['api', 'get', dir, 'nope'], c.io)).toBe(1)
  })

  it('run sends a GET and reports a passing assertion', async () => {
    const c = capture()
    expect(await run(['api', 'run', dir, 'get-health', '--var', `baseUrl=${baseUrl}`], c.io)).toBe(
      0,
    )
    expect(c.out()).toContain('200')
    expect(c.out()).toContain('PASS')
  })

  it('run --json shows sent:true', async () => {
    const c = capture()
    expect(
      await run(['api', 'run', dir, 'get-health', '--var', `baseUrl=${baseUrl}`, '--json'], c.io),
    ).toBe(0)
    const parsed = JSON.parse(c.out())
    expect(parsed.sent).toBe(true)
    expect(parsed.response.status).toBe(200)
  })

  it('SAFETY: a mutating request is dry-run by default (not sent), return 1', async () => {
    const c = capture()
    expect(
      await run(['api', 'run', dir, 'create-thing', '--var', `baseUrl=${baseUrl}`], c.io),
    ).toBe(1)
    expect(c.out().toLowerCase()).toContain('dry')
  })

  it('SAFETY: --unsafe --allow-host sends the mutating request', async () => {
    const c = capture()
    expect(
      await run(
        [
          'api',
          'run',
          dir,
          'create-thing',
          '--var',
          `baseUrl=${baseUrl}`,
          '--unsafe',
          '--allow-host',
          '127.0.0.1',
        ],
        c.io,
      ),
    ).toBe(0)
    expect(c.out()).toContain('201')
  })

  it('run --keyring resolves a secret (keyring chain falls back to env in CI)', async () => {
    process.env.SACKVILLE_SECRET_API_TOKEN = 'env-token-xyz'
    try {
      const c = capture()
      const code = await run(
        ['api', 'run', dir, 'secret-req', '--var', `baseUrl=${baseUrl}`, '--keyring'],
        c.io,
      )
      expect(code).toBe(0)
      expect(c.out()).toContain('200')
    } finally {
      delete process.env.SACKVILLE_SECRET_API_TOKEN
    }
  })

  it('import converts a Postman collection into a runnable .bru collection', async () => {
    const src = join(dir, 'postman.json')
    writeFileSync(
      src,
      JSON.stringify({
        info: { name: 'PM' },
        item: [{ name: 'ping', request: { method: 'GET', url: '{{baseUrl}}/health' } }],
      }),
    )
    const out = mkdtempSync(join(tmpdir(), 'sackville-cli-import-'))
    const c = capture()
    expect(await run(['api', 'import', 'postman', src, out], c.io)).toBe(0)
    expect(c.out()).toContain('imported 1')

    // The imported collection is immediately listable.
    const c2 = capture()
    expect(await run(['api', 'list', out], c2.io)).toBe(0)
    expect(c2.out()).toContain('ping')
  })

  it('import rejects an unknown format', async () => {
    const c = capture()
    expect(await run(['api', 'import', 'bogus', 'x', 'y'], c.io)).toBe(1)
    expect(c.err().toLowerCase()).toContain('unknown import format')
  })

  it('run --max-redirects follows a redirect to a passing final response', async () => {
    const c = capture()
    const code = await run(
      ['api', 'run', dir, 'follow-redirect', '--var', `baseUrl=${baseUrl}`, '--max-redirects', '3'],
      c.io,
    )
    expect(code).toBe(0)
    expect(c.out()).toContain('200')
    expect(c.out()).toContain('PASS')
  })

  it('run --block-private refuses a loopback target (SSRF hardened)', async () => {
    const c = capture()
    const code = await run(
      ['api', 'run', dir, 'get-health', '--var', `baseUrl=${baseUrl}`, '--block-private'],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out().toLowerCase()).toContain('block')
  })

  it('run --openapi validates the live response against a spec', async () => {
    const spec = join(dir, 'openapi.json')
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } } },
      }),
    )
    const c = capture()
    expect(
      await run(
        ['api', 'run', dir, 'get-health', '--var', `baseUrl=${baseUrl}`, '--openapi', spec],
        c.io,
      ),
    ).toBe(0)
    expect(c.out().toLowerCase()).toContain('contract')
  })

  it('run --openapi flags a request body that violates the contract (exit 1)', async () => {
    writeFileSync(
      join(dir, 'create-json.bru'),
      `meta {
  name: create-json
}
post {
  url: {{baseUrl}}/things
  body: json
}
body:json {
  {
    "name": "{{thingName}}"
  }
}
`,
    )
    const spec = join(dir, 'openapi-req.json')
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/things': {
            post: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { name: { type: 'integer' } },
                      required: ['name'],
                    },
                  },
                },
              },
              responses: { '201': { description: 'created' } },
            },
          },
        },
      }),
    )
    const c = capture()
    // --unsafe --allow-host actually sends it (response is a valid 201), so the
    // ONLY failure is the request body — name is a string, the schema wants integer.
    const code = await run(
      [
        'api',
        'run',
        dir,
        'create-json',
        '--var',
        `baseUrl=${baseUrl}`,
        '--var',
        'thingName=Widget',
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--openapi',
        spec,
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('request-body-schema')
    expect(c.out().toLowerCase()).toContain('request contract: invalid')
  })

  it('run --openapi: a conformant request validates clean (exit 0)', async () => {
    const spec = join(dir, 'openapi-req-ok.json')
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/things': {
            post: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { name: { type: 'string' } },
                      required: ['name'],
                    },
                  },
                },
              },
              responses: { '201': { description: 'created' } },
            },
          },
        },
      }),
    )
    const c = capture()
    const code = await run(
      [
        'api',
        'run',
        dir,
        'create-json',
        '--var',
        `baseUrl=${baseUrl}`,
        '--var',
        'thingName=Widget',
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--openapi',
        spec,
      ],
      c.io,
    )
    expect(code).toBe(0)
    expect(c.out().toLowerCase()).toContain('request contract: valid')
  })

  it('run --openapi validates a FORM-URLENCODED request body (ADR 0016 add.4, exit 1)', async () => {
    writeFileSync(
      join(dir, 'create-form.bru'),
      `meta {
  name: create-form
}
post {
  url: {{baseUrl}}/things
  body: formUrlEncoded
}
body:form-urlencoded {
  age: {{age}}
}
`,
    )
    const spec = join(dir, 'openapi-form.json')
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/things': {
            post: {
              requestBody: {
                required: true,
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      properties: { age: { type: 'integer' } },
                      required: ['age'],
                      additionalProperties: false,
                    },
                  },
                },
              },
              responses: { '201': { description: 'created' } },
            },
          },
        },
      }),
    )
    const c = capture()
    // The form field `age` is "abc" — not a valid integer; the only failure is the body.
    const code = await run(
      [
        'api',
        'run',
        dir,
        'create-form',
        '--var',
        `baseUrl=${baseUrl}`,
        '--var',
        'age=abc',
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--openapi',
        spec,
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('request-body-schema')
    expect(c.out().toLowerCase()).toContain('request contract: invalid')
  })

  it('run --openapi redacts a secret echoed in a request finding', async () => {
    const secret = 'super-secret-token-zzz'
    process.env.SACKVILLE_SECRET_API_TOKEN = secret
    writeFileSync(
      join(dir, 'search-secret.bru'),
      `meta {
  name: search-secret
}
get {
  url: {{baseUrl}}/health?token={{secret:API_TOKEN}}
}
`,
    )
    const spec = join(dir, 'openapi-secret.json')
    writeFileSync(
      spec,
      JSON.stringify({
        openapi: '3.1.0',
        paths: {
          '/health': {
            get: {
              parameters: [{ name: 'token', in: 'query', schema: { type: 'integer' } }],
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      }),
    )
    try {
      const c = capture()
      // The secret is not an integer → a param-schema finding that would echo the raw
      // value; it MUST be redacted before it reaches the agent-facing output.
      const code = await run(
        ['api', 'run', dir, 'search-secret', '--var', `baseUrl=${baseUrl}`, '--openapi', spec],
        c.io,
      )
      expect(code).toBe(1)
      expect(c.out()).toContain('param-schema')
      expect(c.out()).not.toContain(secret)
      expect(c.out()).toContain('[redacted:API_TOKEN]')
    } finally {
      delete process.env.SACKVILLE_SECRET_API_TOKEN
    }
  })

  it('run-collection summarizes each step', async () => {
    const c = capture()
    expect(
      await run(['api', 'run-collection', dir, 'get-health', '--var', `baseUrl=${baseUrl}`], c.io),
    ).toBe(0)
    expect(c.out()).toContain('get-health')
    expect(c.out()).toContain('PASS')
  })

  it('validate --graphql: unknown field is drift (return 1)', async () => {
    const c = capture()
    expect(
      await run(
        [
          'api',
          'validate',
          '--graphql',
          join(dir, 'schema.graphql'),
          '--query',
          join(dir, 'bad.graphql'),
        ],
        c.io,
      ),
    ).toBe(1)
    expect(c.out().toLowerCase()).toContain('bogusfield')
  })

  it('validate --graphql: a conformant query is valid (return 0)', async () => {
    const c = capture()
    expect(
      await run(
        [
          'api',
          'validate',
          '--graphql',
          join(dir, 'schema.graphql'),
          '--query',
          join(dir, 'good.graphql'),
        ],
        c.io,
      ),
    ).toBe(0)
  })

  it('validate --graphql --variables flags a wrong-typed variable (exit 1)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'validate',
        '--graphql',
        join(dir, 'thing-schema.graphql'),
        '--query',
        join(dir, 'thing-query.graphql'),
        '--variables',
        '{"id":"hello"}',
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('graphql-variable-invalid')
    expect(c.out()).not.toContain('hello') // value never echoed
  })

  it('validate --graphql --variables passes a conformant variable (exit 0)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'validate',
        '--graphql',
        join(dir, 'thing-schema.graphql'),
        '--query',
        join(dir, 'thing-query.graphql'),
        '--variables',
        '{"id":5}',
      ],
      c.io,
    )
    expect(code).toBe(0)
  })

  it('validate --graphql --coercers validates a custom-scalar variable (exit 1, value-free)', async () => {
    writeFileSync(
      join(dir, 'events-schema.graphql'),
      'scalar DateTime\ntype Query { events(at: DateTime!): Int }',
    )
    writeFileSync(join(dir, 'events-query.graphql'), 'query Q($at: DateTime!) { events(at: $at) }')
    writeFileSync(
      join(dir, 'coercers.mjs'),
      "export default { DateTime: (v) => { if (!/^\\d{4}-/.test(String(v))) throw new Error('bad DateTime') } }\n",
    )
    const c = capture()
    const code = await run(
      [
        'api',
        'validate',
        '--graphql',
        join(dir, 'events-schema.graphql'),
        '--query',
        join(dir, 'events-query.graphql'),
        '--variables',
        '{"at":"not-a-date"}',
        '--coercers',
        join(dir, 'coercers.mjs'),
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('graphql-variable-invalid')
    expect(c.out()).not.toContain('not-a-date') // value never echoed
  })

  it('validate --graphql WITHOUT --coercers leaves the custom-scalar variable unverified (exit 0)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'validate',
        '--graphql',
        join(dir, 'events-schema.graphql'),
        '--query',
        join(dir, 'events-query.graphql'),
        '--variables',
        '{"at":"not-a-date"}',
        '--json',
      ],
      c.io,
    )
    expect(code).toBe(0) // unverified is not a finding → valid
    expect(JSON.parse(c.out()).unverified).toBe(true)
  })

  it('validate --graphql --coercers FAILS LOUDLY on a missing module (non-zero, no silent pass)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'validate',
        '--graphql',
        join(dir, 'events-schema.graphql'),
        '--query',
        join(dir, 'events-query.graphql'),
        '--variables',
        '{"at":"not-a-date"}',
        '--coercers',
        join(dir, 'does-not-exist.mjs'),
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.err()).toContain('failed to load --coercers module')
  })

  it('run --graphql --coercers rejects a live custom-scalar request variable (exit 1, value-free)', async () => {
    writeFileSync(
      join(dir, 'events-schema.graphql'),
      'scalar DateTime\ntype Query { events(at: DateTime!): Int }',
    )
    writeFileSync(
      join(dir, 'coercers.mjs'),
      "export default { DateTime: (v) => { if (!/^\\d{4}-/.test(String(v))) throw new Error('bad DateTime') } }\n",
    )
    writeFileSync(
      join(dir, 'gql-dt.bru'),
      'meta {\n  name: gql-dt\n}\npost {\n  url: {{baseUrl}}/graphql\n  body: graphql\n}\nbody:graphql {\n  query Q($at: DateTime!) { events(at: $at) }\n}\nbody:graphql:vars {\n  {\n    "at": "not-a-date"\n  }\n}\n',
    )
    const c = capture()
    const code = await run(
      [
        'api',
        'run',
        dir,
        'gql-dt',
        '--var',
        `baseUrl=${baseUrl}`,
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--graphql',
        join(dir, 'events-schema.graphql'),
        '--coercers',
        join(dir, 'coercers.mjs'),
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('graphql-variable-invalid')
    expect(c.out()).not.toContain('not-a-date') // value never echoed
  })

  it('run --graphql flags a wrong-typed request variable (exit 1, response still clean)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'run',
        dir,
        'gql-bad',
        '--var',
        `baseUrl=${baseUrl}`,
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--graphql',
        join(dir, 'thing-schema.graphql'),
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out().toLowerCase()).toContain('graphql contract: invalid')
    expect(c.out()).toContain('graphql-variable-invalid')
  })

  it('run --graphql passes a conformant request variable (exit 0)', async () => {
    const c = capture()
    const code = await run(
      [
        'api',
        'run',
        dir,
        'gql-ok',
        '--var',
        `baseUrl=${baseUrl}`,
        '--unsafe',
        '--allow-host',
        '127.0.0.1',
        '--graphql',
        join(dir, 'thing-schema.graphql'),
      ],
      c.io,
    )
    expect(code).toBe(0)
    expect(c.out().toLowerCase()).toContain('graphql contract: valid')
  })

  it('unknown api subcommand returns non-zero', async () => {
    const c = capture()
    expect(await run(['api', 'frobnicate'], c.io)).toBe(1)
  })
})

describe('docs commands still work', () => {
  it('versions still lists indexed versions', async () => {
    const c = capture()
    expect(await run(['versions', 'react', '--index', FIXTURE], c.io)).toBe(0)
    expect(c.out()).toContain('19.0')
  })
})

// Guards the shipped sample (and the CLI quickstart) against .bru-format drift.
// Offline only: `list`/`get` never make a network request.
describe('bundled example collection', () => {
  const example = resolve(here, '../../../examples/api/jsonplaceholder')

  it('list shows the documented requests', async () => {
    const c = capture()
    expect(await run(['api', 'list', example], c.io)).toBe(0)
    for (const name of ['get-user', 'list-posts', 'create-post']) {
      expect(c.out()).toContain(name)
    }
  })

  it('get reports a request with no required secrets', async () => {
    const c = capture()
    expect(await run(['api', 'get', example, 'get-user'], c.io)).toBe(0)
    expect(c.out()).toContain('/users/1')
    expect(c.out()).toContain('required secrets')
  })
})

// The capture→contract bridge over the human CLI (ADR 0013). Reads a local HAR
// file directly (the human is the operator — no surface capture gate).
describe('cli api validate-capture', () => {
  const harFixture = resolve(here, '../../api/test/fixtures/widgets-capture.har.zip')

  it('validates a captured HAR against an OpenAPI spec and exits 1 on drift', async () => {
    const spec = {
      openapi: '3.1.0',
      servers: [{ url: '/api/v1' }],
      paths: {
        '/widgets': { get: { responses: { '200': {} } } },
        '/widgets/{id}': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id'],
                      properties: { id: { type: 'integer' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const specPath = join(mkdtempSync(join(tmpdir(), 'sackville-cap-')), 'openapi.json')
    writeFileSync(specPath, JSON.stringify(spec))

    const c = capture()
    const code = await run(['api', 'validate-capture', harFixture, '--openapi', specPath], c.io)
    expect(code).toBe(1) // /widgets/1 violates the integer-id schema
    expect(c.out()).toContain('NOT CLEAN')
    expect(c.out()).toContain('response-schema')
  })

  it('needs a HAR path and at least one contract', async () => {
    const c = capture()
    expect(await run(['api', 'validate-capture'], c.io)).toBe(1)
    expect(c.err()).toContain('validate-capture')
  })

  it('validates captured GraphQL traffic against an SDL and exits 1 on drift', async () => {
    // The REAL Playwright GraphQL HAR fixture; the captured query (`widgets { id name }`)
    // drifts from this SDL (no `name` on Widget).
    const gqlHar = resolve(here, '../../api/test/fixtures/graphql-capture.har.zip')
    const dir = mkdtempSync(join(tmpdir(), 'sackville-gqlcap-'))
    const sdlPath = join(dir, 'schema.graphql')
    writeFileSync(sdlPath, 'type Query { widgets: [Widget!]! } type Widget { id: ID! }')

    const c = capture()
    const code = await run(
      ['api', 'validate-capture', gqlHar, '--graphql', sdlPath, '--graphql-endpoint', '/graphql'],
      c.io,
    )
    expect(code).toBe(1) // `name` is not on Widget in this SDL — graphql drift
    expect(c.out()).toContain('NOT CLEAN')
    expect(c.out()).toContain('graphql-validation')
  })
})

describe('cli api validate-request', () => {
  const SPEC = {
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
      '/search': {
        get: {
          parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/form': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  required: ['age'],
                  properties: { age: { type: 'integer' } },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { '201': { description: 'created' } },
        },
      },
    },
  }

  function specFile(): string {
    const d = mkdtempSync(join(tmpdir(), 'sackville-vreq-'))
    const specPath = join(d, 'openapi.json')
    writeFileSync(specPath, JSON.stringify(SPEC))
    return specPath
  }

  it('exits 0 on a valid request body', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sackville-vreq-'))
    const specPath = join(d, 'openapi.json')
    writeFileSync(specPath, JSON.stringify(SPEC))
    const bodyPath = join(d, 'body.json')
    writeFileSync(bodyPath, JSON.stringify({ name: 'gizmo' }))
    const c = capture()
    const code = await run(
      [
        'api',
        'validate-request',
        '--openapi',
        specPath,
        '--method',
        'POST',
        '--path',
        '/widgets',
        '--body',
        bodyPath,
      ],
      c.io,
    )
    expect(code).toBe(0)
    expect(c.out()).toContain('valid: true')
  })

  it('exits 1 on a request-body schema violation', async () => {
    const d = mkdtempSync(join(tmpdir(), 'sackville-vreq-'))
    const specPath = join(d, 'openapi.json')
    writeFileSync(specPath, JSON.stringify(SPEC))
    const bodyPath = join(d, 'body.json')
    writeFileSync(bodyPath, JSON.stringify({ wrong: 1 }))
    const c = capture()
    const code = await run(
      [
        'api',
        'validate-request',
        '--openapi',
        specPath,
        '--method',
        'POST',
        '--path',
        '/widgets',
        '--body',
        bodyPath,
      ],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toContain('request-body-schema')
  })

  it('validates query params (missing required q ⇒ exit 1, present ⇒ exit 0)', async () => {
    const specPath = specFile()
    const miss = capture()
    expect(
      await run(
        ['api', 'validate-request', '--openapi', specPath, '--method', 'GET', '--path', '/search'],
        miss.io,
      ),
    ).toBe(1)
    expect(miss.out()).toContain('missing-required-param')

    const ok = capture()
    expect(
      await run(
        [
          'api',
          'validate-request',
          '--openapi',
          specPath,
          '--method',
          'GET',
          '--path',
          '/search',
          '--query',
          'q=hello',
        ],
        ok.io,
      ),
    ).toBe(0)
  })

  it('validates a form-urlencoded body via --form (bad ⇒ exit 1, good ⇒ exit 0)', async () => {
    const specPath = specFile()
    const bad = capture()
    expect(
      await run(
        [
          'api',
          'validate-request',
          '--openapi',
          specPath,
          '--method',
          'POST',
          '--path',
          '/form',
          '--header',
          'content-type:application/x-www-form-urlencoded',
          '--form',
          'age=abc',
        ],
        bad.io,
      ),
    ).toBe(1)
    expect(bad.out()).toContain('request-body-schema')

    const ok = capture()
    expect(
      await run(
        [
          'api',
          'validate-request',
          '--openapi',
          specPath,
          '--method',
          'POST',
          '--path',
          '/form',
          '--header',
          'content-type:application/x-www-form-urlencoded',
          '--form',
          'age=5',
        ],
        ok.io,
      ),
    ).toBe(0)
    expect(ok.out()).toContain('valid: true')
  })

  it('needs --openapi/--method/--path', async () => {
    const c = capture()
    expect(await run(['api', 'validate-request'], c.io)).toBe(1)
    expect(c.err()).toContain('validate-request')
  })
})
