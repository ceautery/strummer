import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redactor } from '@sackville-mcp/safety'
import { type Browser, type BrowserContext, chromium } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { RunRecorder } from './recorder.js'

vi.setConfig({ testTimeout: 30_000 })

// Logs a secret to the console, fetches a URL carrying the same secret in its
// query string, then throws (→ a pageerror). Exercises every capture channel.
const FIXTURE = `<!doctype html><html lang="en"><head><title>Recorder</title></head><body>
  <h1>Recorder</h1>
  <script>
    console.log('hello s3cr3t-value')
    fetch('/api/data?token=s3cr3t-value').catch(() => {})
    throw new Error('kaboom')
  </script>
</body></html>`

describe('RunRecorder — artifact capture (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let context: BrowserContext
  let baseDir: string
  let store: ArtifactStore
  let redactor: Redactor

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/data')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
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

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sackville-rec-'))
    store = new ArtifactStore(baseDir)
    redactor = new Redactor()
    redactor.register('token', 's3cr3t-value')
  })

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
    if (baseDir) rmSync(baseDir, { recursive: true, force: true })
  })

  it('captures trace/console/network by handle, redacting text artifacts before write', async () => {
    const page = await context.newPage()
    const recorder = await RunRecorder.start(page, {
      runId: 'run-1',
      store,
      redact: (v) => redactor.redact(v),
    })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const artifacts = await recorder.stop()
    await page.close()

    // --- trace (binary, by handle) ---
    expect(artifacts.trace?.handle).toBe('sackville://browser/run/run-1/trace')
    expect(artifacts.trace?.byteSize).toBeGreaterThan(0)
    const trace = store.get(artifacts.trace?.handle ?? '')
    expect(trace?.contentType).toBe('application/zip')
    expect(trace?.body.subarray(0, 2).toString('latin1')).toBe('PK') // zip magic

    // --- console (text, redacted) ---
    expect(artifacts.console?.count).toBeGreaterThanOrEqual(2)
    expect(artifacts.console?.byType.log).toBeGreaterThanOrEqual(1)
    expect(artifacts.console?.byType.pageerror).toBeGreaterThanOrEqual(1)
    const consoleBody = store.get(artifacts.console?.handle ?? '')?.body.toString('utf8') ?? ''
    expect(consoleBody).toContain('hello [redacted:token]')
    expect(consoleBody).not.toContain('s3cr3t-value')

    // --- network (text, redacted) ---
    expect(artifacts.network?.count).toBeGreaterThanOrEqual(1)
    const netBody = store.get(artifacts.network?.handle ?? '')?.body.toString('utf8') ?? ''
    expect(netBody).not.toContain('s3cr3t-value')
    const entries = JSON.parse(netBody) as { url: string; status?: number }[]
    const apiHit = entries.find((e) => e.url.includes('/api/data'))
    expect(apiHit?.status).toBe(200)
    expect(apiHit?.url).toContain('token=[redacted:token]')
    expect(artifacts.network?.byStatus['200']).toBeGreaterThanOrEqual(1)
  })

  it('redacts secrets from the trace.zip metadata before write', async () => {
    const page = await context.newPage()
    const recorder = await RunRecorder.start(page, {
      runId: 'run-trace',
      store,
      redact: (v) => redactor.redact(v),
      trace: true,
      console: false,
      network: false,
    })
    // the fixture fetches /api/data?token=s3cr3t-value → the URL lands in the
    // trace's network metadata; redaction must scrub it before the zip is stored
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const artifacts = await recorder.stop()
    await page.close()

    const zip = store.get(artifacts.trace?.handle ?? '')?.body
    expect(zip).toBeDefined()
    const { unzipSync } = await import('fflate')
    const entries = unzipSync(new Uint8Array(zip as Buffer))
    const allText = Object.values(entries)
      .map((b) => Buffer.from(b).toString('latin1'))
      .join('\n')
    expect(allText).not.toContain('s3cr3t-value') // the raw secret is gone from every entry
    expect(allText).toContain('[redacted:token]') // …and was actually present + redacted
  })

  it('omits disabled capture channels', async () => {
    const page = await context.newPage()
    const recorder = await RunRecorder.start(page, {
      runId: 'run-2',
      store,
      trace: false,
      console: false,
    })
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    const artifacts = await recorder.stop()
    await page.close()

    expect(artifacts.trace).toBeUndefined()
    expect(artifacts.console).toBeUndefined()
    expect(artifacts.network?.count).toBeGreaterThanOrEqual(1)
  })
})
