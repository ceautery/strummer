import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DnsLookup } from '@strummer/safety'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSsrfProxy } from './proxy.js'

vi.setConfig({ testTimeout: 30_000 })

/** Issue `GET <absoluteUrl>` through an HTTP proxy and resolve {status, body}. */
function getThroughProxy(
  proxyUrl: string,
  absoluteUrl: string,
  hostHeader: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: 'GET',
        path: absoluteUrl,
        headers: { Host: hostHeader },
      },
      (res) => {
        let body = ''
        res.on('data', (c) => {
          body += c
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('createSsrfProxy (direct HTTP client through the proxy)', () => {
  let target: Server
  let targetPort: number

  beforeAll(async () => {
    target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello-from-target')
    })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    targetPort = (target.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((r) => target.close(() => r()))
  })

  const lookup =
    (map: Record<string, string>): DnsLookup =>
    async (host) => {
      const address = map[host]
      if (!address) throw new Error(`no mapping for ${host}`)
      return { address, family: 4 }
    }

  it('pins a hostname to its resolved IP and forwards (allowPrivate → loopback target)', async () => {
    const proxy = await createSsrfProxy({
      lookup: lookup({ 'app.test': '127.0.0.1' }),
      allowPrivate: true,
    })
    try {
      const res = await getThroughProxy(
        proxy.url,
        `http://app.test:${targetPort}/`,
        `app.test:${targetPort}`,
      )
      expect(res.status).toBe(200)
      expect(res.body).toBe('hello-from-target')
    } finally {
      await proxy.close()
    }
  })

  it('refuses a host that resolves to the metadata IP, even with allowPrivate (rebinding)', async () => {
    const proxy = await createSsrfProxy({
      lookup: lookup({ 'rebind.test': '169.254.169.254' }),
      allowPrivate: true,
    })
    try {
      const res = await getThroughProxy(proxy.url, 'http://rebind.test/', 'rebind.test')
      expect(res.status).toBe(502) // blocked before any upstream connection
      expect(res.body).toMatch(/block/i)
    } finally {
      await proxy.close()
    }
  })

  it('refuses an RFC1918 target by default (allowPrivate off)', async () => {
    const proxy = await createSsrfProxy({ lookup: lookup({ 'internal.test': '10.0.0.5' }) })
    try {
      const res = await getThroughProxy(proxy.url, 'http://internal.test/', 'internal.test')
      expect(res.status).toBe(502)
    } finally {
      await proxy.close()
    }
  })
})

describe('createSsrfProxy (real chromium through the proxy)', () => {
  let target: Server
  let targetPort: number

  beforeAll(async () => {
    target = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Proxied</title><h1>ok</h1>')
    })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    targetPort = (target.address() as AddressInfo).port
  }, 60_000)
  afterAll(async () => {
    await new Promise<void>((r) => target.close(() => r()))
  })

  it('routes Chromium through the proxy: allowed host loads, rebinding host fails', async () => {
    const proxy = await createSsrfProxy({
      lookup: async (host) => {
        if (host === 'app.test') return { address: '127.0.0.1', family: 4 }
        if (host === 'rebind.test') return { address: '169.254.169.254', family: 4 }
        throw new Error(`no mapping for ${host}`)
      },
      allowPrivate: true,
    })
    // Launch Chromium WITH the proxy (launch-level, so it takes effect on
    // Chromium). Using hostnames (not loopback literals) means Chromium hands
    // them to the proxy to resolve, instead of bypassing for localhost.
    const browser: Browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
      proxy: { server: proxy.url },
    })
    try {
      const page = await (await browser.newContext()).newPage()
      await page.goto(`http://app.test:${targetPort}/`)
      expect(await page.title()).toBe('Proxied')

      // The proxy refuses the rebinding host with a 502 (it never forwards).
      const blocked = await page.goto('http://rebind.test/')
      expect(blocked?.status()).toBe(502)
    } finally {
      await browser.close()
      await proxy.close()
    }
  })
})
