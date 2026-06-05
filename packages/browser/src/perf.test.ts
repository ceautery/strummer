import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { auditPerf } from './perf.js'

// Lighthouse drives a full page load + audit (~5-6s) — well past the 5s default.
vi.setConfig({ testTimeout: 60_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>Perf</title></head><body>
  <h1>Perf</h1><p>hello world</p>
</body></html>`

describe('auditPerf — real Lighthouse perf audit', () => {
  let server: Server
  let baseUrl: string

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

  it('returns a shape-checked perf summary + full LHR/HTML by handle', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'sackville-perf-')))
    const result = await auditPerf(baseUrl, {
      runId: 'perfrun',
      store,
      chromePath: chromium.executablePath(),
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
    })

    // Assert SHAPE/thresholds, never an exact score (per ADR 0006 — scores vary).
    const { summary } = result
    expect(summary.lighthouseVersion).toBe('13.3.0')
    expect(typeof summary.performanceScore).toBe('number')
    expect(summary.performanceScore as number).toBeGreaterThanOrEqual(0)
    expect(summary.performanceScore as number).toBeLessThanOrEqual(1)

    // the six core metrics are present, each with a numeric value
    const ids = summary.metrics.map((m) => m.id)
    for (const id of [
      'first-contentful-paint',
      'largest-contentful-paint',
      'total-blocking-time',
      'cumulative-layout-shift',
      'speed-index',
      'interactive',
    ]) {
      expect(ids).toContain(id)
    }
    expect(summary.metrics.every((m) => typeof m.numericValue === 'number')).toBe(true)

    // full reports are stored by handle (never inlined)
    expect(result.reportHandle).toBe('sackville://browser/run/perfrun/perf')
    expect(result.htmlHandle).toBe('sackville://browser/run/perfrun/perf-html')
    const lhr = JSON.parse(store.get(result.reportHandle)?.body.toString('utf8') ?? '{}')
    expect(lhr.categories.performance).toBeDefined()
    expect(store.get(result.htmlHandle)?.body.toString('utf8').startsWith('<!')).toBe(true)
  })

  it('applies the redactor to the stored reports', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'sackville-perf-')))
    const result = await auditPerf(baseUrl, {
      runId: 'perfrun2',
      store,
      chromePath: chromium.executablePath(),
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
      // the audited URL is always present in the LHR — redact it as a stand-in secret
      redact: (v) => v.replaceAll(baseUrl, '[redacted-url]'),
    })
    const json = store.get(result.reportHandle)?.body.toString('utf8') ?? ''
    expect(json).not.toContain(baseUrl)
    expect(json).toContain('[redacted-url]')
  })
})
