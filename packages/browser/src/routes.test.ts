import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type BrowserContext, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserGate } from './gate.js'
import { BrowserManager } from './manager.js'
import { installSafetyRoutes } from './routes.js'

vi.setConfig({ testTimeout: 30_000 })

describe('installSafetyRoutes — Tier-1 network allowlist (real chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Routes</title><h1>ok</h1>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function probe(context: BrowserContext) {
    const page = await context.newPage()
    await page.goto(baseUrl)
    return page.evaluate(async () => {
      const tryFetch = async (u: string) => {
        try {
          await fetch(u, { mode: 'no-cors' })
          return 'ok'
        } catch {
          return 'blocked'
        }
      }
      return {
        self: await tryFetch('/again'), // same allowlisted origin
        metadata: await tryFetch('http://169.254.169.254/latest/meta-data/'),
        external: await tryFetch('http://example.com/'),
      }
    })
  }

  it('allows allowlisted hosts and blocks metadata literals + non-allowlisted hosts', async () => {
    const context = await browser.newContext()
    await installSafetyRoutes(context, new BrowserGate({ allowedHosts: ['127.0.0.1'] }))
    const r = await probe(context)
    expect(r.self).toBe('ok')
    expect(r.metadata).toBe('blocked') // link-local metadata IP, blocked unconditionally
    expect(r.external).toBe('blocked') // not on the allowlist
    await context.close()
  })

  it('is installed automatically by BrowserManager when a gate is configured', async () => {
    const manager = new BrowserManager({
      launch: async () => browser,
      gate: new BrowserGate({ allowedHosts: ['127.0.0.1'] }),
    })
    const context = await manager.createSession('s1')
    const r = await probe(context)
    expect(r.self).toBe('ok')
    expect(r.metadata).toBe('blocked')
    await manager.closeSession('s1') // closes the context, not the shared browser
  })
})
