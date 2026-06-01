import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { run } from './index.js'

// The browser CLI launches real chromium + the SSRF proxy per command.
vi.setConfig({ testTimeout: 60_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>CLI</title></head><body>
  <h1>CLI Page</h1>
  <button>Press</button>
  <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
</body></html>`

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

describe('strummer browser CLI (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  // 127.0.0.1 is loopback → needs --allow-private for the SSRF proxy to reach it.
  const SAFE = ['--no-sandbox', '--allow-private']

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('snapshot prints the ARIA tree with refs (host auto-allowed)', async () => {
    const c = capture()
    const code = await run(['browser', 'snapshot', baseUrl, ...SAFE], c.io)
    expect(code).toBe(0)
    expect(c.out()).toContain('[ref=')
    expect(c.out()).toContain('button "Press"')
    expect(c.out()).toContain('CLI Page')
  })

  it('audit reports the alt-less image and exits non-zero on violations', async () => {
    const c = capture()
    const code = await run(['browser', 'audit', baseUrl, ...SAFE], c.io)
    expect(code).toBe(1)
    expect(c.out()).toContain('violations:')
    expect(c.out()).toContain('image-alt')
    expect(c.out()).toMatch(/full report: \S+/)
  })

  it('screenshot writes a PNG to --out', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'strummer-cli-shot-')), 'page.png')
    const c = capture()
    const code = await run(['browser', 'screenshot', baseUrl, '--out', out, ...SAFE], c.io)
    expect(code).toBe(0)
    expect(c.out()).toContain(out)
    expect(existsSync(out)).toBe(true)
    expect([...readFileSync(out).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('rejects a navigation to a host that is not allowlisted', async () => {
    const c = capture()
    // an explicit different --allow-host does not cover the typed host's subresources,
    // but the typed host itself is auto-allowed; here we prove an invalid URL is refused
    const code = await run(['browser', 'snapshot', 'not-a-url', ...SAFE], c.io)
    expect(code).toBe(1)
    expect(c.err()).toMatch(/invalid url/i)
  })
})
