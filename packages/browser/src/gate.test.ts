import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Browser, type BrowserContext, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PageDriver } from './driver.js'
import { BrowserGate, GateError } from './gate.js'

vi.setConfig({ testTimeout: 30_000 })

describe('BrowserGate policy (pure, operator-set)', () => {
  it('matches the host allowlist case-insensitively; empty list allows nothing', () => {
    const gate = new BrowserGate({ allowedHosts: ['Example.com', '127.0.0.1'] })
    expect(gate.isHostAllowed('https://example.com/x')).toBe(true)
    expect(gate.isHostAllowed('http://127.0.0.1:8080/y')).toBe(true)
    expect(gate.isHostAllowed('https://evil.test/z')).toBe(false)
    expect(new BrowserGate().isHostAllowed('https://example.com')).toBe(false)
  })

  it('checkNavigation denies non-allowlisted hosts and allows listed ones', () => {
    const gate = new BrowserGate({ allowedHosts: ['example.com'] })
    expect(() => gate.checkNavigation('https://example.com/a')).not.toThrow()
    expect(() => gate.checkNavigation('https://evil.test/a')).toThrow(GateError)
  })

  it('decideMutation: dry-run by default, execute only with allowUnsafe + allowlisted host', () => {
    expect(
      new BrowserGate({ allowedHosts: ['example.com'] }).decideMutation('https://example.com'),
    ).toBe('dry-run')
    expect(
      new BrowserGate({ allowUnsafe: true, allowedHosts: ['example.com'] }).decideMutation(
        'https://example.com',
      ),
    ).toBe('execute')
    // allowUnsafe but host not allowed → hard deny
    expect(() =>
      new BrowserGate({ allowUnsafe: true, allowedHosts: ['example.com'] }).decideMutation(
        'https://evil.test',
      ),
    ).toThrow(GateError)
  })
})

describe('BrowserGate × PageDriver (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let context: BrowserContext
  let posts: string[]

  const FIXTURE = `<!doctype html><html lang="en"><head><title>Gate</title></head><body>
    <button id="go">Submit</button>
    <script>
      document.getElementById('go').addEventListener('click', () =>
        fetch('/submit', { method: 'POST', body: 'payload=1' }).catch(() => {}))
    </script>
  </body></html>`

  beforeAll(async () => {
    posts = []
    server = createServer((req, res) => {
      if (req.url === '/submit' && req.method === 'POST') {
        posts.push(req.url)
        res.writeHead(200)
        res.end('ok')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    context = await browser.newContext()
  }, 60_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  function submitRef(driver: PageDriver): string {
    const hit = [...driver.refs.entries()].find(
      ([, d]) => d.role === 'button' && d.name === 'Submit',
    )
    if (!hit) throw new Error('no Submit button ref')
    return hit[0]
  }

  it('allows navigation only to allowlisted hosts', async () => {
    const okPage = await context.newPage()
    const ok = new PageDriver(okPage, { gate: new BrowserGate({ allowedHosts: ['127.0.0.1'] }) })
    await expect(ok.navigate(baseUrl)).resolves.toBeDefined()

    const denyPage = await context.newPage()
    const deny = new PageDriver(denyPage, {
      gate: new BrowserGate({ allowedHosts: ['example.com'] }),
    })
    await expect(deny.navigate(baseUrl)).rejects.toThrow(GateError)
  })

  it('dry-runs a mutation: captures the would-be request and blocks it from sending', async () => {
    posts.length = 0
    const page = await context.newPage()
    const driver = new PageDriver(page, {
      gate: new BrowserGate({ allowUnsafe: false, allowedHosts: ['127.0.0.1'] }),
    })
    await driver.navigate(baseUrl)
    const result = await driver.click(submitRef(driver))
    expect(result.dryRun).toBe(true)
    expect(result.wouldRequest?.method).toBe('POST')
    expect(result.wouldRequest?.url).toContain('/submit')
    expect(posts).toHaveLength(0) // the POST never reached the server
  })

  it('executes a mutation with allowUnsafe on an allowlisted host', async () => {
    posts.length = 0
    const page = await context.newPage()
    const driver = new PageDriver(page, {
      gate: new BrowserGate({ allowUnsafe: true, allowedHosts: ['127.0.0.1'] }),
    })
    await driver.navigate(baseUrl)
    const result = await driver.click(submitRef(driver))
    expect(result.dryRun).toBeFalsy()
    await new Promise((r) => setTimeout(r, 300)) // let the fetch land
    expect(posts).toHaveLength(1)
  })
})
