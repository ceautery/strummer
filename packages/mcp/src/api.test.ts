import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ApiToolsOptions, createApiServer } from './api.js'

/** Build a temp Bruno collection with the requests the tests exercise. */
function makeCollection(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strummer-api-'))
  writeFileSync(join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: 'test' }))
  writeFileSync(
    join(dir, 'get-health.bru'),
    'meta {\n  name: get-health\n}\nget {\n  url: {{baseUrl}}/health\n}\n',
  )
  writeFileSync(
    join(dir, 'get-health.strummer.yml'),
    'assertions:\n  - source: status\n    op: equals\n    value: 200\n',
  )
  writeFileSync(
    join(dir, 'create-thing.bru'),
    'meta {\n  name: create-thing\n}\npost {\n  url: {{baseUrl}}/things\n}\n',
  )
  writeFileSync(
    join(dir, 'secret-req.bru'),
    'meta {\n  name: secret-req\n}\nget {\n  url: {{baseUrl}}/health\n}\nheaders {\n  Authorization: Bearer {{secret:API_TOKEN}}\n}\n',
  )
  return dir
}

describe('strummer API MCP tools', () => {
  let server: Server
  let baseUrl: string
  let dir: string
  let client: Client

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (req.url === '/things' && req.method === 'POST') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ created: true }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = makeCollection()

    const api = createApiServer()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([api.connect(serverTransport), client.connect(clientTransport)])
  })

  afterAll(async () => {
    await client?.close()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('exposes the api tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('list_requests')
    expect(names).toContain('get_request')
    expect(names).toContain('run_request')
    expect(names).toContain('run_collection')
    expect(names).toContain('validate_response')
  })

  it('list_requests returns request names with method+url', async () => {
    const res = await client.callTool({ name: 'list_requests', arguments: { dir } })
    const sc = res.structuredContent as {
      requests: { name: string; method: string; url: string }[]
    }
    const health = sc.requests.find((r) => r.name === 'get-health')
    expect(health).toMatchObject({ method: 'GET', url: '{{baseUrl}}/health' })
    const create = sc.requests.find((r) => r.name === 'create-thing')
    expect(create?.method).toBe('POST')
  })

  it('get_request reports requiredSecrets by NAME only', async () => {
    const res = await client.callTool({
      name: 'get_request',
      arguments: { dir, name: 'secret-req' },
    })
    const sc = res.structuredContent as {
      method: string
      url: string
      requiredSecrets: string[]
    }
    expect(sc.requiredSecrets).toEqual(['API_TOKEN'])
    expect(sc.method).toBe('GET')
    // requiredSecrets reports NAMES only — no resolved secret value is fetched/leaked.
    expect(sc.requiredSecrets).not.toContain('Bearer')
  })

  it('get_request reports no secrets for get-health', async () => {
    const res = await client.callTool({
      name: 'get_request',
      arguments: { dir, name: 'get-health' },
    })
    const sc = res.structuredContent as { requiredSecrets: string[]; assertionCount: number }
    expect(sc.requiredSecrets).toEqual([])
  })

  it('get_request throws for an unknown name', async () => {
    const res = await client.callTool({
      name: 'get_request',
      arguments: { dir, name: 'nope' },
    })
    expect(res.isError).toBe(true)
  })

  it('run_request sends a GET and evaluates assertions', async () => {
    const res = await client.callTool({
      name: 'run_request',
      arguments: { dir, name: 'get-health', vars: { baseUrl } },
    })
    const sc = res.structuredContent as {
      sent: boolean
      response?: { status: number; assertions: { pass: boolean }[]; bodyHandle: string }
    }
    expect(sc.sent).toBe(true)
    expect(sc.response?.status).toBe(200)
    expect(sc.response?.assertions.every((a) => a.pass)).toBe(true)
    expect(sc.response?.bodyHandle).toMatch(/^strummer:\/\/run\/.+\/body$/)
  })

  it('serves the run body via the resource', async () => {
    const run = await client.callTool({
      name: 'run_request',
      arguments: { dir, name: 'get-health', vars: { baseUrl } },
    })
    const handle = (run.structuredContent as { response: { bodyHandle: string } }).response
      .bodyHandle
    const res = await client.readResource({ uri: handle })
    const first = res.contents[0] as { text: string }
    expect(first.text).toContain('"ok":true')
  })

  it('dry-runs a mutating request when allowUnsafe is off (operator-controlled)', async () => {
    const res = await client.callTool({
      name: 'run_request',
      arguments: { dir, name: 'create-thing', vars: { baseUrl } },
    })
    const sc = res.structuredContent as { sent: boolean; dryRun: boolean }
    expect(sc.dryRun).toBe(true)
    expect(sc.sent).toBe(false)
  })

  it('sends a mutating request only when the operator unlocks it', async () => {
    const api = createApiServer({ allowUnsafe: true, allowedHosts: ['127.0.0.1'] })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([api.connect(st), c.connect(ct)])
    const res = await c.callTool({
      name: 'run_request',
      arguments: { dir, name: 'create-thing', vars: { baseUrl } },
    })
    const sc = res.structuredContent as { sent: boolean; response?: { status: number } }
    expect(sc.sent).toBe(true)
    expect(sc.response?.status).toBe(201)
    await c.close()
  })

  it('run_collection returns a compact per-step summary', async () => {
    const res = await client.callTool({
      name: 'run_collection',
      arguments: { dir, names: ['get-health'], vars: { baseUrl } },
    })
    const sc = res.structuredContent as {
      steps: {
        name: string
        status: number | null
        sent: boolean
        assertionsPassed: boolean
        bodyHandle?: string
      }[]
    }
    expect(sc.steps).toHaveLength(1)
    expect(sc.steps[0]).toMatchObject({ name: 'get-health', sent: true, assertionsPassed: true })
    expect(sc.steps[0]?.bodyHandle).toMatch(/^strummer:\/\/run\/.+\/body$/)
  })

  it('validate_response validates against an inline OpenAPI spec', async () => {
    const spec = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: {
        '/health': {
          get: {
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    }
    const res = await client.callTool({
      name: 'validate_response',
      arguments: { openapiSpec: spec, method: 'GET', path: '/health', status: 200, body: {} },
    })
    const sc = res.structuredContent as { valid: boolean }
    expect(sc.valid).toBe(true)
  })

  it('validate_response flags an unknown GraphQL field', async () => {
    const sdl = 'type Query { hello: String }'
    const res = await client.callTool({
      name: 'validate_response',
      arguments: { graphqlSchema: sdl, query: '{ nope }' },
    })
    const sc = res.structuredContent as { valid: boolean }
    expect(sc.valid).toBe(false)
  })

  it('validate_response throws without a contract', async () => {
    const res = await client.callTool({ name: 'validate_response', arguments: {} })
    expect(res.isError).toBe(true)
  })
})

describe('validate_capture — the capture→contract bridge (ADR 0013 slice 6)', () => {
  // The real Playwright HAR fixture lives in the api package.
  const HAR = readFileSync(
    fileURLToPath(new URL('../../api/test/fixtures/widgets-capture.har.zip', import.meta.url)),
  )
  const SPEC = {
    openapi: '3.1.0',
    servers: [{ url: '/api/v1' }],
    paths: {
      '/widgets': {
        get: {
          responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } },
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

  async function connect(opts: ApiToolsOptions): Promise<Client> {
    const api = createApiServer(opts)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const c = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([api.connect(st), c.connect(ct)])
    return c
  }

  it('is NOT registered when no HAR resolver is wired (deny-by-default)', async () => {
    const c = await connect({})
    const tools = await c.listTools()
    expect(tools.tools.map((t) => t.name)).not.toContain('validate_capture')
  })

  it('refuses to resolve a HAR without the operator capture gate', async () => {
    const c = await connect({ allowCapture: false, resolveHar: () => HAR })
    const res = await c.callTool({
      name: 'validate_capture',
      arguments: { harHandle: 'strummer://browser/run/x/har', openapiSpec: SPEC },
    })
    expect(res.isError).toBe(true)
  })

  it('validates captured JSON traffic and reports drift when gated on', async () => {
    const c = await connect({ allowCapture: true, resolveHar: () => HAR })
    const res = await c.callTool({
      name: 'validate_capture',
      arguments: { harHandle: 'strummer://browser/run/x/har', openapiSpec: SPEC },
    })
    const sc = res.structuredContent as {
      clean: boolean
      entriesValidated: number
      exercisedOperations: string[]
    }
    expect(sc.entriesValidated).toBe(2)
    expect(sc.clean).toBe(false) // /widgets/1 violates the integer-id schema
    expect(sc.exercisedOperations).toContain('GET /widgets/{id}')
  })

  it('redacts finding messages + stored detail; no sentinel leaks into inline or bytes', async () => {
    let storedBody = ''
    const c = await connect({
      allowCapture: true,
      resolveHar: () => HAR,
      verifyRedact: (s) => s.replace(/widgets/gi, '‹redacted›'),
      storeVerifyDetail: (_id, _kind, body) => {
        storedBody = body
        return 'strummer://verify/test/capture-verdict'
      },
    })
    // Force missing-operation findings (which echo the path) by validating against
    // a spec that documents neither path — every finding message carries the path.
    const res = await c.callTool({
      name: 'validate_capture',
      arguments: {
        harHandle: 'strummer://browser/run/x/har',
        openapiSpec: { openapi: '3.1.0', paths: {} },
      },
    })
    const inline = JSON.stringify(res.structuredContent)
    expect(inline).not.toContain('widgets')
    expect(storedBody.length).toBeGreaterThan(0)
    expect(storedBody).not.toContain('widgets')
    expect(res.structuredContent).toHaveProperty('detailHandle')
  })

  // The REAL Playwright GraphQL HAR fixture (a POST of `{ widgets { id name } }`).
  const GQL_HAR = readFileSync(
    fileURLToPath(new URL('../../api/test/fixtures/graphql-capture.har.zip', import.meta.url)),
  )
  // The captured query drops `name` from this SDL → graphql-validation drift.
  const GQL_SDL_DRIFT = 'type Query { widgets: [Widget!]! } type Widget { id: ID! }'

  it('validates captured GraphQL traffic against a supplied SDL (drift caught)', async () => {
    const c = await connect({ allowCapture: true, resolveHar: () => GQL_HAR })
    const res = await c.callTool({
      name: 'validate_capture',
      arguments: {
        harHandle: 'strummer://browser/run/x/har',
        graphqlSchema: GQL_SDL_DRIFT,
        graphqlEndpoint: '/graphql',
      },
    })
    const sc = res.structuredContent as { clean: boolean; findingsByKind: Record<string, number> }
    expect(sc.clean).toBe(false) // `name` is not on Widget in the drift SDL
    expect(sc.findingsByKind['graphql-validation']).toBeGreaterThanOrEqual(1)
  })

  it('requires at least one of openapiSpec / graphqlSchema', async () => {
    const c = await connect({ allowCapture: true, resolveHar: () => GQL_HAR })
    const res = await c.callTool({
      name: 'validate_capture',
      arguments: { harHandle: 'strummer://browser/run/x/har' },
    })
    expect(res.isError).toBe(true)
  })
})
