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
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } else if (req.url === '/things' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ created: true }))
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

  dir = mkdtempSync(join(tmpdir(), 'strummer-cli-api-'))
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
    join(dir, 'get-health.strummer.yml'),
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
    join(dir, 'follow-redirect.strummer.yml'),
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
    process.env.STRUMMER_SECRET_API_TOKEN = 'env-token-xyz'
    try {
      const c = capture()
      const code = await run(
        ['api', 'run', dir, 'secret-req', '--var', `baseUrl=${baseUrl}`, '--keyring'],
        c.io,
      )
      expect(code).toBe(0)
      expect(c.out()).toContain('200')
    } finally {
      delete process.env.STRUMMER_SECRET_API_TOKEN
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
    const out = mkdtempSync(join(tmpdir(), 'strummer-cli-import-'))
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
    const specPath = join(mkdtempSync(join(tmpdir(), 'strummer-cap-')), 'openapi.json')
    writeFileSync(specPath, JSON.stringify(spec))

    const c = capture()
    const code = await run(['api', 'validate-capture', harFixture, '--openapi', specPath], c.io)
    expect(code).toBe(1) // /widgets/1 violates the integer-id schema
    expect(c.out()).toContain('NOT CLEAN')
    expect(c.out()).toContain('response-schema')
  })

  it('needs both a HAR path and --openapi', async () => {
    const c = capture()
    expect(await run(['api', 'validate-capture'], c.io)).toBe(1)
    expect(c.err()).toContain('validate-capture')
  })
})
