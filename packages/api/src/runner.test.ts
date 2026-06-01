import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { loadCollection } from './collection.js'
import { runRequest } from './runner.js'
import { StaticSecretStore } from './secrets.js'
import { runSequence } from './sequence.js'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(here, '../test/fixtures/sample')

describe('runRequest (offline, in-process server)', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } else if (req.url === '/echo') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ headers: req.headers }))
      } else if (req.url === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'tok-123' }))
      } else if (req.url === '/things' && req.method === 'POST') {
        let received = ''
        req.on('data', (c) => {
          received += c
        })
        req.on('end', () => {
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ received, contentType: req.headers['content-type'] ?? null }))
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('runs a GET .bru request and evaluates its sidecar assertions', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'get-health', { vars: { baseUrl } })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(200)
    expect(result.response?.assertions).toHaveLength(3)
    expect(result.response?.assertions.every((a) => a.pass)).toBe(true)
    expect(result.response?.bodyHandle).toMatch(/^strummer:\/\/run\/.+\/body$/)
  })

  it('resolves {{secret:NAME}} and redacts it from request, body, and headers', async () => {
    const token = 's3cr3t-token-xyz'
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'echo-auth', {
      vars: { baseUrl },
      secrets: new StaticSecretStore({ API_TOKEN: token }),
      artifacts,
    })
    expect(result.sent).toBe(true)
    // The agent-facing request shows the secret redacted, never the value.
    expect(result.request.headers.Authorization).toBe('Bearer [redacted:API_TOKEN]')
    // The server echoed the real header; the stored body is redacted.
    const body = artifacts.get(result.response?.bodyHandle ?? '')?.body ?? ''
    expect(body).toContain('[redacted:API_TOKEN]')
    expect(body).not.toContain(token)
  })

  it('fails closed when a referenced secret is missing', async () => {
    await expect(
      runRequest(loadCollection(FIXTURE), 'echo-auth', {
        vars: { baseUrl },
        secrets: new StaticSecretStore({}),
      }),
    ).rejects.toThrow(/missing secret/i)
  })

  it('dry-runs a mutating request by default (not sent)', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing', { vars: { baseUrl } })
    expect(result.dryRun).toBe(true)
    expect(result.sent).toBe(false)
    expect(result.response).toBeUndefined()
    expect(result.request.method).toBe('POST')
    expect(result.reason).toMatch(/mutating/i)
  })

  it('sends a mutating request only when unlocked and allowlisted', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing', {
      vars: { baseUrl },
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)
  })

  it('captures a value from a response', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'get-token', { vars: { baseUrl } })
    expect(result.response?.captured).toEqual({ token: 'tok-123' })
  })

  it('chains a captured value into a later request', async () => {
    const artifacts = new ArtifactStore()
    const seq = await runSequence(loadCollection(FIXTURE), ['get-token', 'use-token'], {
      vars: { baseUrl },
      artifacts,
    })
    expect(seq.captured).toEqual({ token: 'tok-123' })
    expect(seq.steps).toHaveLength(2)

    // use-token sent `Authorization: Bearer {{token}}` with the captured token.
    const echo = seq.steps[1]?.result.response?.bodyHandle ?? ''
    const body = artifacts.get(echo)?.body ?? ''
    expect(body).toContain('Bearer tok-123')
  })

  it('loads environments and lets runtime vars override them', async () => {
    const collection = loadCollection(FIXTURE)
    expect(collection.environments.get('Local')).toEqual({
      apiVersion: 'v2',
      baseUrl: 'http://example.invalid',
    })
    // env baseUrl is a dead host; the runtime var must win and hit the real server.
    const result = await runRequest(collection, 'get-health', {
      env: 'Local',
      vars: { baseUrl },
    })
    expect(result.response?.status).toBe(200)
  })

  it('sends a JSON body with interpolation and a default content-type', async () => {
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing-json', {
      vars: { baseUrl, thingName: 'widget' },
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      artifacts,
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)
    expect(result.request.body).toContain('"name": "widget"')

    // The server echoed the received body + content-type.
    const echoed = artifacts.get(result.response?.bodyHandle ?? '')?.body ?? ''
    expect(echoed).toContain('widget')
    expect(echoed).toContain('application/json')
  })

  it('sends a form-urlencoded body (camelCase discriminator) with interpolation + redaction', async () => {
    const token = 'form-secret-456'
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing-form', {
      vars: { baseUrl, thingName: 'widget' },
      secrets: new StaticSecretStore({ API_TOKEN: token }),
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      artifacts,
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)

    // Agent-facing request: urlencoded params, secret redacted, real value absent.
    expect(result.request.body).toContain('name=widget')
    expect(result.request.body).toContain('token=[redacted:API_TOKEN]')
    expect(result.request.body).not.toContain(token)

    const echoed = JSON.parse(artifacts.get(result.response?.bodyHandle ?? '')?.body ?? '{}')
    expect(echoed.contentType).toContain('application/x-www-form-urlencoded')
    expect(echoed.received).toContain('name=widget')
  })

  it('sends a multipart-form body (text + file parts) with file resolved against the collection dir', async () => {
    const token = 'multipart-secret-321'
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing-multipart', {
      vars: { baseUrl, thingName: 'widget' },
      secrets: new StaticSecretStore({ API_TOKEN: token }),
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      artifacts,
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)

    // Preview summarizes parts: text values (secret redacted), file by name/size —
    // never the file bytes inlined, never the raw secret.
    expect(result.request.body).toContain('name (text): widget')
    expect(result.request.body).toContain('token (text): [redacted:API_TOKEN]')
    expect(result.request.body).toContain('attachment (file): upload.txt')
    expect(result.request.body).not.toContain('hello multipart body')
    expect(result.request.body).not.toContain(token)

    // Server received a real multipart/form-data body with a boundary undici minted.
    const echoed = JSON.parse(artifacts.get(result.response?.bodyHandle ?? '')?.body ?? '{}')
    expect(echoed.contentType).toContain('multipart/form-data')
    expect(echoed.contentType).toContain('boundary=')
    expect(echoed.received).toContain('name="name"')
    expect(echoed.received).toContain('widget')
    expect(echoed.received).toContain('filename="upload.txt"')
    expect(echoed.received).toContain('hello multipart body')
    // The secret is on the wire but redacted in the stored artifact.
    expect(echoed.received).toContain('[redacted:API_TOKEN]')
    expect(echoed.received).not.toContain(token)
  })

  it('sends a raw file body (bytes from disk) with the declared content-type', async () => {
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing-file', {
      vars: { baseUrl },
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      artifacts,
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)

    // Preview names the file + size + content-type, never inlining the bytes.
    expect(result.request.body).toContain('payload.bin')
    expect(result.request.body).toContain('application/octet-stream')
    expect(result.request.body).toContain('bytes')
    expect(result.request.body).not.toContain('RAW-FILE-BODY-CONTENT')

    // The server received the raw file bytes under the declared content-type.
    const echoed = JSON.parse(artifacts.get(result.response?.bodyHandle ?? '')?.body ?? '{}')
    expect(echoed.contentType).toContain('application/octet-stream')
    expect(echoed.received).toContain('RAW-FILE-BODY-CONTENT')
  })

  it('sends a graphql body as {query, variables} JSON with secrets resolved + redacted', async () => {
    const token = 'gql-secret-789'
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'create-thing-graphql', {
      vars: { baseUrl, thingName: 'widget', tag: 'blue' },
      secrets: new StaticSecretStore({ API_TOKEN: token }),
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      artifacts,
    })
    expect(result.sent).toBe(true)
    expect(result.response?.status).toBe(201)

    // The agent-facing request shows the query + variables, with the secret redacted.
    expect(result.request.body).toContain('addThing(name: \\"widget\\")')
    expect(result.request.body).toContain('"tag":"blue"')
    expect(result.request.body).toContain('[redacted:API_TOKEN]')
    expect(result.request.body).not.toContain(token)

    // The server echoed a JSON envelope: {"query": "...", "variables": {...}} as
    // application/json, with the real secret on the wire but redacted in the artifact.
    const echoed = JSON.parse(artifacts.get(result.response?.bodyHandle ?? '')?.body ?? '{}')
    expect(echoed.contentType).toContain('application/json')
    const sent = JSON.parse(echoed.received)
    expect(sent.query).toContain('addThing(name: "widget")')
    expect(sent.variables).toEqual({ token: '[redacted:API_TOKEN]', tag: 'blue' })
  })

  it('blocks an SSRF target (metadata IP) before sending — even a safe GET', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'get-health', {
      vars: { baseUrl: 'http://169.254.169.254' },
    })
    expect(result.sent).toBe(false)
    expect(result.dryRun).toBe(false)
    expect(result.reason).toMatch(/block/i)
    expect(result.response).toBeUndefined()
  })

  it('blocks loopback when allowPrivate is false (hardened posture)', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'get-health', {
      vars: { baseUrl },
      allowPrivate: false,
    })
    expect(result.sent).toBe(false)
    expect(result.reason).toMatch(/block/i)
  })

  it('runs a post-response script: tests + programmatic capture', async () => {
    const result = await runRequest(loadCollection(FIXTURE), 'script-demo', { vars: { baseUrl } })
    expect(result.response?.scriptTests).toEqual([
      { name: 'token present', pass: true, error: undefined },
      { name: 'intentional fail', pass: false, error: expect.stringContaining('to be') },
    ])
    expect(result.response?.captured.capturedToken).toBe('tok-123')
  })

  it('runs a pre-request script that sets a variable used in the request', async () => {
    const artifacts = new ArtifactStore()
    const result = await runRequest(loadCollection(FIXTURE), 'pre-demo', {
      vars: { baseUrl },
      artifacts,
    })
    expect(result.sent).toBe(true)
    // pre-script set `mode` = turbo, interpolated into the X-Mode header the server echoed.
    const echoed = artifacts.get(result.response?.bodyHandle ?? '')?.body ?? ''
    expect(echoed).toContain('"x-mode":"turbo"')
  })
})
