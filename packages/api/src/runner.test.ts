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
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 1 }))
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
})
