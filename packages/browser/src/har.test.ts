import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Redactor } from '@strummer/safety'
import { unzipSync } from 'fflate'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { finalizeHar, harPathFor } from './har.js'

vi.setConfig({ testTimeout: 30_000 })

// The page fetches a URL carrying a secret in its query string; the API responds
// with the secret echoed in the body — so the secret lands in the HAR's request
// query AND a response body (content:'attach' ⇒ bodies persisted in the zip).
const FIXTURE = `<!doctype html><html lang="en"><head><title>HAR</title></head><body>
  <h1>HAR</h1>
  <script>fetch('/api/data?token=s3cr3t-value').catch(() => {})</script>
</body></html>`

describe('finalizeHar — recorded HAR capture (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let baseDir: string
  let harDir: string
  let store: ArtifactStore
  let redactor: Redactor

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/api/data')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"token":"s3cr3t-value"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  }, 60_000)

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'strummer-har-store-'))
    harDir = mkdtempSync(join(tmpdir(), 'strummer-har-out-'))
    store = new ArtifactStore(baseDir)
    redactor = new Redactor()
    redactor.register('token', 's3cr3t-value')
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
    if (baseDir) rmSync(baseDir, { recursive: true, force: true })
    if (harDir) rmSync(harDir, { recursive: true, force: true })
  })

  async function recordHar(sessionId: string): Promise<string> {
    const harPath = harPathFor(harDir, sessionId)
    const context = await browser.newContext({
      recordHar: { path: harPath, content: 'attach', mode: 'full' },
    })
    const page = await context.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await context.close() // flushes the HAR zip to disk
    return harPath
  }

  it('stores the HAR by handle with a compact summary, redacting text entries before write', async () => {
    const harPath = await recordHar('s1')
    expect(existsSync(harPath)).toBe(true)

    const summary = await finalizeHar({
      harPath,
      runId: 'run-har',
      store,
      redact: (v) => redactor.redact(v),
    })

    expect(summary).toBeDefined()
    expect(summary?.handle).toBe('strummer://browser/run/run-har/har')
    expect(summary?.byteSize).toBeGreaterThan(0)
    // the document load + the /api/data XHR
    expect(summary?.entryCount).toBeGreaterThanOrEqual(2)
    expect(summary?.byStatus['200']).toBeGreaterThanOrEqual(2)
    expect(summary?.byMethod.GET).toBeGreaterThanOrEqual(2)

    // the temp HAR is consumed (we own the canonical copy in the store now)
    expect(existsSync(harPath)).toBe(false)

    // stored as a binary zip artifact, by handle
    const stored = store.get(summary?.handle ?? '')
    expect(stored?.contentType).toBe('application/zip')
    expect(stored?.body.subarray(0, 2).toString('latin1')).toBe('PK') // zip magic

    // every text entry (the .har JSON + persisted text bodies) is scrubbed of the
    // raw secret, and the secret WAS present (so we know redaction actually ran)
    const entries = unzipSync(new Uint8Array(stored?.body as Buffer))
    const harName = Object.keys(entries).find((n) => n.endsWith('.har'))
    expect(harName).toBeDefined()
    const allText = Object.values(entries)
      .map((b) => Buffer.from(b).toString('latin1'))
      .join('\n')
    expect(allText).not.toContain('s3cr3t-value')
    expect(allText).toContain('[redacted:token]')
  })

  it('passes the zip through unchanged when no redactor is supplied', async () => {
    const harPath = await recordHar('s2')
    const summary = await finalizeHar({ harPath, runId: 'run-raw', store })
    expect(summary?.entryCount).toBeGreaterThanOrEqual(2)
    const stored = store.get(summary?.handle ?? '')
    const allText = Object.values(unzipSync(new Uint8Array(stored?.body as Buffer)))
      .map((b) => Buffer.from(b).toString('latin1'))
      .join('\n')
    // with no redactor the raw value survives (proves redaction is what removed it above)
    expect(allText).toContain('s3cr3t-value')
  })

  it('returns undefined when no HAR file was written (recording disabled / no path)', async () => {
    const summary = await finalizeHar({
      harPath: join(harDir, 'does-not-exist.zip'),
      runId: 'run-none',
      store,
    })
    expect(summary).toBeUndefined()
  })
})
