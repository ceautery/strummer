import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Redactor } from '@sackville/safety'
import { type Browser, type BrowserContext, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PageDriver } from './driver.js'
import { type BrowserFlow, runFlow } from './flow.js'
import { BrowserGate } from './gate.js'

vi.setConfig({ testTimeout: 30_000 })

// A tiny form: type a name, click Greet → the heading shows "Hello <name>".
const FIXTURE = `<!doctype html><html lang="en"><head><title>Flow</title></head><body>
  <label>Name <input type="text"></label>
  <button id="go">Greet</button>
  <h1 role="heading"></h1>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.querySelector('h1').textContent =
        'Hello ' + document.querySelector('input').value
    })
  </script>
</body></html>`

describe('runFlow — execute a persisted flow (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let context: BrowserContext

  beforeAll(async () => {
    server = createServer((_req, res) => {
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

  /** A driver whose gate executes mutations on 127.0.0.1, with WHO=World secret. */
  async function setup() {
    const page = await context.newPage()
    const redactor = new Redactor()
    redactor.register('WHO', 'World')
    const gate = new BrowserGate({ allowUnsafe: true, allowedHosts: ['127.0.0.1'] })
    const driver = new PageDriver(page, { gate, redact: (v) => redactor.redact(v) })
    return { page, driver }
  }

  it('runs navigate→fill(secret)→click→assert; passes, redacts the secret everywhere', async () => {
    const { driver } = await setup()
    const flow: BrowserFlow = {
      name: 'Greet',
      steps: [
        { action: 'navigate', url: '{{baseUrl}}' },
        { action: 'fill', target: { role: 'textbox', name: 'Name' }, value: '{{secret:WHO}}' },
        { action: 'click', target: { role: 'button', name: 'Greet' } },
        {
          action: 'assert',
          assertions: [{ source: 'text', role: 'heading', op: 'contains', value: 'Hello' }],
        },
      ],
    }
    const result = await runFlow(driver, flow, {
      vars: { baseUrl },
      resolveSecret: (n) => (n === 'WHO' ? 'World' : undefined),
    })

    expect(result.passed).toBe(true)
    expect(result.steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'click', 'assert'])
    expect(result.steps.every((s) => s.ok)).toBe(true)
    // assertion passed on the TRUE value ("Hello World" contains "Hello")…
    const assertStep = result.steps.find((s) => s.action === 'assert')
    expect(assertStep?.assertions?.[0]?.pass).toBe(true)
    // …but the secret is redacted everywhere it surfaces (actual = "Hello [redacted:WHO]")
    expect(JSON.stringify(result)).not.toContain('World')
    expect(JSON.stringify(result)).toContain('[redacted:WHO]')
  })

  it('fails the flow (passed:false) when an assertion does not hold', async () => {
    const { driver } = await setup()
    const flow: BrowserFlow = {
      name: 'Bad assert',
      steps: [
        { action: 'navigate', url: baseUrl },
        {
          action: 'assert',
          assertions: [
            { source: 'title', op: 'equals', value: 'Flow' },
            { source: 'title', op: 'equals', value: 'Nope', timeout: 500 },
          ],
        },
      ],
    }
    const result = await runFlow(driver, flow)
    expect(result.passed).toBe(false)
    const assertStep = result.steps.find((s) => s.action === 'assert')
    expect(assertStep?.assertions?.map((a) => a.pass)).toEqual([true, false])
  })

  it('stops + reports the step error when a step throws (e.g. off-allowlist navigate)', async () => {
    const { driver } = await setup()
    const flow: BrowserFlow = {
      name: 'Denied nav',
      steps: [
        { action: 'navigate', url: 'https://evil.test/' }, // host not allowlisted
        { action: 'assert', assertions: [{ source: 'title', op: 'exists' }] },
      ],
    }
    const result = await runFlow(driver, flow)
    expect(result.passed).toBe(false)
    expect(result.steps).toHaveLength(1) // stopped after the failing step
    expect(result.steps[0]?.ok).toBe(false)
    expect(result.steps[0]?.error).toMatch(/denied|allowlist/i)
  })

  it('dry-runs a mutation when the gate is not unlocked (no execution, surfaced)', async () => {
    const page = await context.newPage()
    const gate = new BrowserGate({ allowUnsafe: false, allowedHosts: ['127.0.0.1'] })
    const driver = new PageDriver(page, { gate })
    const flow: BrowserFlow = {
      name: 'Locked',
      steps: [
        { action: 'navigate', url: baseUrl },
        { action: 'click', target: { role: 'button', name: 'Greet' } },
      ],
    }
    const result = await runFlow(driver, flow)
    const clickStep = result.steps.find((s) => s.action === 'click')
    expect(clickStep?.dryRun).toBe(true)
    expect(clickStep?.ok).toBe(true) // dry-run is not an error
  })
})
