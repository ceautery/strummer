import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadCollection } from './collection.js'
import { runRequest } from './runner.js'

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

  it('runs a .bru request and evaluates its sidecar assertions', async () => {
    const collection = loadCollection(FIXTURE)
    const result = await runRequest(collection, 'get-health', { vars: { baseUrl } })

    expect(result.status).toBe(200)
    expect(result.assertions).toHaveLength(3)
    expect(result.assertions.every((a) => a.pass)).toBe(true)
    // Body is returned by handle, never inlined.
    expect(result.bodyHandle).toMatch(/^strummer:\/\/run\/.+\/body$/)
  })

  it('parses the request and its sidecar captures from disk', () => {
    const collection = loadCollection(FIXTURE)
    const entry = collection.requests.get('get-health')
    expect(entry?.request.method).toBe('GET')
    expect(entry?.request.url).toContain('{{baseUrl}}')
    expect(entry?.captures).toHaveLength(1)
  })
})
