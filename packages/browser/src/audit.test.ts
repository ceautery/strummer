import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { auditA11y } from './audit.js'

// A page with one rock-stable axe violation: an <img> with no alt text
// (the `image-alt` rule, impact: critical). Deterministic and offline.
const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><title>Fixture</title></head>
<body><h1>Hello</h1><img src="logo.png"></body></html>`

describe('auditA11y (offline, in-process server + headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let context: BrowserContext
  let page: Page

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE_HTML)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // `--no-sandbox` here is the test-harness posture (root-in-container CI);
    // production sandbox gating is a separate operator concern (ADR 0006 §7).
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    // axe-core/playwright requires an explicit context (mirrors the design:
    // one isolated context per session). A bare browser.newPage() breaks it.
    context = await browser.newContext()
    page = await context.newPage()
    await page.goto(baseUrl)
  }, 60_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('summarizes the image-alt violation and stores the full report by handle', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'strummer-browser-')))
    const { summary, resultsHandle } = await auditA11y(page, { runId: 'run-1', store })

    expect(summary.violationCount).toBeGreaterThanOrEqual(1)
    const imageAlt = summary.top.find((v) => v.id === 'image-alt')
    expect(imageAlt).toBeDefined()
    expect(imageAlt?.impact).toBe('critical')
    // bucketed by impact — the critical bucket holds at least the image-alt finding
    expect(summary.byImpact.critical).toBeGreaterThanOrEqual(1)

    // full report is addressable by a strummer://browser/run/<id>/a11y handle,
    // never inlined into the summary
    expect(resultsHandle).toBe('strummer://browser/run/run-1/a11y')
    const stored = store.get(resultsHandle)
    expect(stored).toBeDefined()
    expect(stored?.contentType).toBe('application/json')
    const parsed = JSON.parse(stored?.body.toString('utf8') ?? '{}')
    expect(parsed.violations.some((v: { id: string }) => v.id === 'image-alt')).toBe(true)
  }, 60_000)
})
