import { readFileSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { queryTrace } from './trace.js'

vi.setConfig({ testTimeout: 30_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>Trace</title></head><body>
  <h1>Trace</h1>
  <input aria-label="Name">
  <button id="go" onclick="console.log('clicked');console.error('boom')">Go</button>
</body></html>`

describe('queryTrace — parse a real Playwright trace.zip', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let traceZip: Buffer

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

    const ctx = await browser.newContext()
    await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true })
    const page = await ctx.newPage()
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.getByRole('textbox', { name: 'Name' }).fill('Alice')
    await page.getByRole('button', { name: 'Go' }).click()
    await page.waitForTimeout(200)
    const tmp = join(tmpdir(), 'strummer-trace-test.zip')
    await ctx.tracing.stop({ path: tmp })
    await ctx.close()
    traceZip = readFileSync(tmp)
    unlinkSync(tmp)
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('extracts the action timeline (api, timing) and context metadata', () => {
    const result = queryTrace(traceZip)
    expect(result.browserName).toBe('chromium')
    expect(result.playwrightVersion).toBe('1.60.0')
    // the run navigated, filled, and clicked — those actions are in the timeline
    expect(result.actions.some((a) => /goto/i.test(a.api))).toBe(true)
    expect(result.actions.some((a) => /fill/i.test(a.api))).toBe(true)
    expect(result.actions.some((a) => /click/i.test(a.api))).toBe(true)
    // actions are time-ordered and carry a duration
    const durations = result.actions.map((a) => a.durationMs).filter((d) => d !== undefined)
    expect(durations.length).toBeGreaterThan(0)
    expect(result.summary.actionCount).toBe(result.actions.length)
  })

  it('surfaces console output captured in the trace', () => {
    const result = queryTrace(traceZip)
    expect(result.console.some((c) => c.text === 'clicked')).toBe(true)
    expect(result.console.some((c) => c.type === 'error' && c.text === 'boom')).toBe(true)
    expect(result.errors).toContain('boom')
  })

  it('apiFilter narrows to matching actions (case-insensitive)', () => {
    const result = queryTrace(traceZip, { apiFilter: 'click' })
    expect(result.actions.length).toBeGreaterThan(0)
    expect(result.actions.every((a) => /click/i.test(a.api))).toBe(true)
  })

  it('omits params unless includeParams is set; includeParams surfaces them', () => {
    expect(queryTrace(traceZip).actions.every((a) => a.params === undefined)).toBe(true)
    const withParams = queryTrace(traceZip, { includeParams: true, apiFilter: 'goto' })
    expect(withParams.actions[0]?.params).toBeDefined()
  })

  it('limit caps the number of returned actions', () => {
    const result = queryTrace(traceZip, { limit: 2 })
    expect(result.actions.length).toBe(2)
    // the summary still reflects the true total
    expect(result.summary.actionCount).toBeGreaterThanOrEqual(2)
  })
})
