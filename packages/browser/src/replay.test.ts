import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PageDriver } from './driver.js'
import { harPathFor } from './har.js'

vi.setConfig({ testTimeout: 30_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>Replayed</title></head>
  <body><h1>Served from HAR</h1></body></html>`

describe('PageDriver.replayFromHar — offline determinism (real headless chromium)', () => {
  let server: Server | undefined
  let baseUrl: string
  let browser: Browser
  let replayDir: string

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => (server as Server).listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${((server as Server).address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    replayDir = mkdtempSync(join(tmpdir(), 'sackville-replay-'))

    // Record a HAR against the live server, then SHUT THE SERVER DOWN so the only
    // way the page can load afterward is by replaying from the recorded HAR.
    const recCtx = await browser.newContext({
      recordHar: { path: harPathFor(replayDir, 'rec'), content: 'attach', mode: 'full' },
    })
    const recPage = await recCtx.newPage()
    await recPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await recCtx.close() // flushes rec.zip into replayDir
    await new Promise<void>((r) => (server as Server).close(() => r()))
    server = undefined
  }, 60_000)

  afterAll(async () => {
    if (server) await new Promise<void>((r) => (server as Server).close(() => r()))
    await browser?.close()
    if (replayDir) rmSync(replayDir, { recursive: true, force: true })
  })

  it('serves navigation from a recorded HAR with the network down (notFound:abort)', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const driver = new PageDriver(page, { replayDir })
      const res = await driver.replayFromHar('rec.zip')
      expect(res.har).toBe('rec.zip')

      // the origin server is gone — without replay this navigation would fail
      await driver.navigate(baseUrl)
      expect(await page.title()).toBe('Replayed')
      expect(await page.content()).toContain('Served from HAR')
    } finally {
      await context.close()
    }
  })

  it('is deny-by-default: refuses replay when no operator replayDir is configured', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const driver = new PageDriver(page, {}) // no replayDir
      await expect(driver.replayFromHar('rec.zip')).rejects.toThrow(/not enabled/i)
    } finally {
      await context.close()
    }
  })

  it('confines the HAR to the operator replay dir (no traversal escape)', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const driver = new PageDriver(page, { replayDir })
      await expect(driver.replayFromHar('../../../etc/hosts')).rejects.toThrow(/replay/i)
    } finally {
      await context.close()
    }
  })
})
