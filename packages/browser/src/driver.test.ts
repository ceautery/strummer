import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { PageDriver } from './driver.js'

// Real-browser step sequences (navigate → act → re-snapshot, several times) run
// longer than Vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>Steps</title></head><body>
  <h1>Steps</h1>
  <label>Name <input id="name" type="text"></label>
  <label>Color <select id="color"><option>Red</option><option>Green</option><option>Blue</option></select></label>
  <button id="add">Add</button>
  <ul id="list"></ul>
  <button id="later">Later</button>
  <script>
    const $ = (id) => document.getElementById(id)
    $('add').addEventListener('click', () => {
      const li = document.createElement('li')
      li.textContent = $('name').value || 'item'
      $('list').appendChild(li)
    })
    $('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add').click() })
    $('later').addEventListener('click', () => setTimeout(() => {
      const p = document.createElement('p'); p.setAttribute('role','status'); p.textContent = 'Done'
      document.body.appendChild(p)
    }, 150))
  </script>
</body></html>`

describe('PageDriver — ref resolution guard (no browser)', () => {
  it('throws a clear error when acting before any snapshot exists', async () => {
    const driver = new PageDriver({} as unknown as Page)
    await expect(driver.click('e1')).rejects.toThrow(/snapshot/i)
  })

  it('distinguishes "no snapshot yet" from a stale ref', async () => {
    const driver = new PageDriver({} as unknown as Page)
    // before any capture, the error is specifically the no-snapshot guidance,
    // NOT the stale-ref ("unknown ref") message used after a re-capture
    await expect(driver.click('e1')).rejects.toThrow(/no snapshot yet/i)
    await expect(driver.click('e1')).rejects.not.toThrow(/unknown ref/i)
  })
})

describe('PageDriver — step tools (real headless chromium)', () => {
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

  async function freshDriver(): Promise<PageDriver> {
    const page = await context.newPage()
    const driver = new PageDriver(page)
    await driver.navigate(baseUrl)
    return driver
  }

  function refFor(driver: PageDriver, role: string, name?: string): string {
    const hit = [...driver.refs.entries()].find(([, d]) => d.role === role && d.name === name)
    if (!hit) throw new Error(`no ref for ${role} "${name}"`)
    return hit[0]
  }

  it('navigate captures a snapshot exposing the controls as refs', async () => {
    const driver = await freshDriver()
    expect(driver.snapshotText).toContain('[ref=')
    expect(driver.snapshotText).toContain('button "Add"')
    expect(() => refFor(driver, 'textbox', 'Name')).not.toThrow()
    expect(() => refFor(driver, 'combobox', 'Color')).not.toThrow()
  })

  it('fill sets a value that get_value reads back', async () => {
    const driver = await freshDriver()
    await driver.fill(refFor(driver, 'textbox', 'Name'), 'Hello')
    expect(await driver.getValue(refFor(driver, 'textbox', 'Name'))).toBe('Hello')
  })

  it('click mutates the DOM and the step result carries a scoped diff', async () => {
    const driver = await freshDriver()
    await driver.fill(refFor(driver, 'textbox', 'Name'), 'Hello')
    const result = await driver.click(refFor(driver, 'button', 'Add'))
    expect(result.action).toBe('click')
    expect(result.diff).not.toBe('')
    expect(result.snapshot).toContain('Hello')
  })

  it('selectOption picks an option and get_value reflects it', async () => {
    const driver = await freshDriver()
    await driver.selectOption(refFor(driver, 'combobox', 'Color'), 'Blue')
    expect(await driver.getValue(refFor(driver, 'combobox', 'Color'))).toBe('Blue')
  })

  it('press Enter in the field triggers the keydown handler', async () => {
    const driver = await freshDriver()
    await driver.fill(refFor(driver, 'textbox', 'Name'), 'ViaEnter')
    // fill re-snapshots → refs are re-minted; re-fetch from the current snapshot
    const result = await driver.press(refFor(driver, 'textbox', 'Name'), 'Enter')
    expect(result.snapshot).toContain('ViaEnter')
  })

  it('wait_for resolves once a late element appears', async () => {
    const driver = await freshDriver()
    await driver.click(refFor(driver, 'button', 'Later'))
    const result = await driver.waitFor({ role: 'status', timeout: 5000 })
    expect(result.snapshot).toContain('Done')
  })

  it('a ref from a stale snapshot fails to resolve after a re-navigation', async () => {
    const driver = await freshDriver()
    const staleRef = refFor(driver, 'button', 'Add')
    await driver.navigate(baseUrl) // new snapshot generation → old refs invalid
    expect(driver.refs.has(staleRef)).toBe(false)
    await expect(driver.click(staleRef)).rejects.toThrow(/snapshot/i)
  })

  it('get_text reads an element’s text content', async () => {
    const driver = await freshDriver()
    expect(await driver.getText(refFor(driver, 'heading', 'Steps'))).toContain('Steps')
  })

  it('screenshot captures a PNG by indexed handle and preserves refs', async () => {
    const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'strummer-shot-')))
    const page = await context.newPage()
    const driver = new PageDriver(page, { runId: 'shotrun', store })
    await driver.navigate(baseUrl)
    const nameRef = refFor(driver, 'textbox', 'Name')

    const result = await driver.screenshot()
    expect(result.action).toBe('screenshot')
    expect(result.contentType).toBe('image/png')
    expect(result.fullPage).toBe(false)
    expect(result.byteSize).toBeGreaterThan(0)
    expect(result.handle).toBe('strummer://browser/run/shotrun/screenshot-s1')

    // the stored bytes are a real PNG (magic signature)
    const stored = store.get(result.handle as string)
    expect(stored?.contentType).toBe('image/png')
    expect([...(stored?.body.subarray(0, 8) ?? [])]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])

    // a screenshot is NOT a re-snapshot: the ref still resolves
    expect(driver.refs.has(nameRef)).toBe(true)

    // a second screenshot gets a fresh, non-overwriting handle
    const second = await driver.screenshot({ fullPage: true })
    expect(second.handle).toBe('strummer://browser/run/shotrun/screenshot-s2')
    expect(second.fullPage).toBe(true)
  })

  it('screenshot without a store returns a summary but no handle', async () => {
    const driver = await freshDriver()
    const result = await driver.screenshot()
    expect(result.handle).toBeUndefined()
    expect(result.byteSize).toBeGreaterThan(0)
    expect(result.contentType).toBe('image/png')
  })
})
