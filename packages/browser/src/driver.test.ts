import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from './artifacts.js'
import { PageDriver } from './driver.js'
import { BrowserGate } from './gate.js'

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
  <button id="del">Delete</button>
  <a id="dl" href="/download.bin" download="report.txt">Get file</a>
  <input type="file" aria-label="Attach">
  <script>
    const $ = (id) => document.getElementById(id)
    $('add').addEventListener('click', () => {
      const li = document.createElement('li')
      li.textContent = $('name').value || 'item'
      $('list').appendChild(li)
    })
    $('del').addEventListener('click', () => {
      const ok = confirm('Delete everything?')
      const li = document.createElement('li')
      li.textContent = ok ? 'deleted' : 'kept'
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
    server = createServer((req, res) => {
      if (req.url?.startsWith('/download.bin')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.txt"',
        })
        res.end('downloaded-bytes')
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

  async function gatedDriver(gate: BrowserGate): Promise<PageDriver> {
    const page = await context.newPage()
    const driver = new PageDriver(page, { gate })
    await driver.navigate(baseUrl)
    return driver
  }

  it('dismisses a confirm dialog by default and records the event', async () => {
    // allowUnsafe so the click executes (not dry-run); allowDialogs stays off
    const gate = new BrowserGate({ allowUnsafe: true, allowedHosts: ['127.0.0.1'] })
    const driver = await gatedDriver(gate)
    const result = await driver.click(refFor(driver, 'button', 'Delete'))
    expect(result.dialogs).toEqual([
      { type: 'confirm', message: 'Delete everything?', accepted: false },
    ])
    // dismissed → confirm() returned false → 'kept'
    expect(result.snapshot).toContain('kept')
    expect(result.snapshot).not.toContain('deleted')
  })

  it('accepts a confirm dialog when the operator unlocked dialogs', async () => {
    const gate = new BrowserGate({
      allowUnsafe: true,
      allowedHosts: ['127.0.0.1'],
      allowDialogs: true,
    })
    const driver = await gatedDriver(gate)
    const result = await driver.click(refFor(driver, 'button', 'Delete'))
    expect(result.dialogs?.[0]).toEqual({
      type: 'confirm',
      message: 'Delete everything?',
      accepted: true,
    })
    expect(result.snapshot).toContain('deleted')
  })

  it('redacts a dialog message before it surfaces', async () => {
    const page = await context.newPage()
    const driver = new PageDriver(page, {
      gate: new BrowserGate({ allowUnsafe: true, allowedHosts: ['127.0.0.1'], allowDialogs: true }),
      redact: (v) => v.replace('everything', '[redacted]'),
    })
    await driver.navigate(baseUrl)
    const result = await driver.click(refFor(driver, 'button', 'Delete'))
    expect(result.dialogs?.[0]?.message).toBe('Delete [redacted]?')
  })

  it('omits the dialogs field on a step that triggered none', async () => {
    const driver = await freshDriver()
    const result = await driver.snapshot()
    expect(result.dialogs).toBeUndefined()
  })

  it('saves a download to the operator quarantine dir and records it (sanitized, indexed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'strummer-dl-'))
    const dlContext = await browser.newContext({ acceptDownloads: true })
    try {
      const page = await dlContext.newPage()
      const driver = new PageDriver(page, {
        gate: new BrowserGate({ allowUnsafe: true, allowedHosts: ['127.0.0.1'] }),
        downloadDir: dir,
      })
      await driver.navigate(baseUrl)
      // sync on the download event so collectDownloads is deterministic
      await Promise.all([
        page.waitForEvent('download'),
        driver.click(refFor(driver, 'link', 'Get file')),
      ])
      const downloads = await driver.collectDownloads()
      expect(downloads).toHaveLength(1)
      expect(downloads[0]?.accepted).toBe(true)
      expect(downloads[0]?.suggestedFilename).toBe('report.txt')
      expect(downloads[0]?.byteSize).toBe('downloaded-bytes'.length)
      // saved under the quarantine dir with an indexed, sanitized name
      expect(downloads[0]?.savedAs?.startsWith(dir)).toBe(true)
      expect(downloads[0]?.savedAs).toContain('1-report.txt')
      expect(existsSync(downloads[0]?.savedAs as string)).toBe(true)
      // draining is idempotent — a second collect returns nothing new
      expect(await driver.collectDownloads()).toEqual([])
    } finally {
      await dlContext.close()
    }
  })

  it('uploads a file from the operator allowlist dir; rejects paths outside it', async () => {
    const upDir = mkdtempSync(join(tmpdir(), 'strummer-up-'))
    writeFileSync(join(upDir, 'ok.txt'), 'hello')
    const page = await context.newPage()
    const driver = new PageDriver(page, {
      gate: new BrowserGate({ allowedHosts: ['127.0.0.1'] }),
      uploadDir: upDir,
    })
    await driver.navigate(baseUrl)

    // accepts a file inside the allowlist dir (relative to it)
    const result = await driver.uploadFiles(refFor(driver, 'button', 'Attach'), ['ok.txt'])
    expect(result.action).toBe('upload')
    // the file input now reports the chosen file (browsers expose a fakepath value)
    expect(await driver.getValue(refFor(driver, 'button', 'Attach'))).toMatch(/ok\.txt$/)

    // traversal + absolute paths outside the dir are denied (no setInputFiles)
    await expect(
      driver.uploadFiles(refFor(driver, 'button', 'Attach'), ['../../etc/passwd']),
    ).rejects.toThrow(/allowlist/i)
    await expect(
      driver.uploadFiles(refFor(driver, 'button', 'Attach'), ['/etc/passwd']),
    ).rejects.toThrow(/allowlist/i)
  })

  it('denies uploads entirely when no operator upload dir is configured', async () => {
    const driver = await gatedDriver(new BrowserGate({ allowedHosts: ['127.0.0.1'] }))
    await expect(driver.uploadFiles(refFor(driver, 'button', 'Attach'), ['x'])).rejects.toThrow(
      /not enabled/i,
    )
  })

  it('assert: page-level + element sources via ref/role pass when the page matches', async () => {
    const driver = await freshDriver()
    await driver.fill(refFor(driver, 'textbox', 'Name'), 'Hello')
    const results = await driver.assert([
      { source: 'url', op: 'contains', value: '127.0.0.1' },
      { source: 'title', op: 'equals', value: 'Steps' },
      { source: 'value', ref: refFor(driver, 'textbox', 'Name'), op: 'equals', value: 'Hello' },
      { source: 'visible', role: 'button', name: 'Add', op: 'equals', value: true },
      { source: 'text', role: 'heading', name: 'Steps', op: 'contains', value: 'Steps' },
      { source: 'count', role: 'button', op: 'gte', value: 3 },
      { source: 'ariaSnapshot', op: 'contains', value: 'button "Add"' },
    ])
    expect(results.map((r) => r.pass)).toEqual([true, true, true, true, true, true, true])
  })

  it('assert: auto-waits for a late element to satisfy the condition', async () => {
    const driver = await freshDriver()
    await driver.click(refFor(driver, 'button', 'Later')) // adds role=status "Done" after 150ms
    // assert immediately — the poll must wait for the element to appear
    const [r] = await driver.assert([
      { source: 'text', role: 'status', op: 'contains', value: 'Done', timeout: 5000 },
    ])
    expect(r?.pass).toBe(true)
  })

  it('assert: a failing assertion reports the (redacted) actual after the timeout', async () => {
    const page = await context.newPage()
    const driver = new PageDriver(page, { redact: (v) => v.replace('Steps', '[X]') })
    await driver.navigate(baseUrl)
    const [r] = await driver.assert([
      { source: 'title', op: 'equals', value: 'Nope', timeout: 400 },
    ])
    expect(r?.pass).toBe(false)
    expect(r?.actual).toBe('[X]') // 'Steps' redacted; expected stays as given
    expect(r?.expected).toBe('Nope')
  })

  it('assert: a missing element yields a non-throwing false (not a hang)', async () => {
    const driver = await freshDriver()
    const [r] = await driver.assert([
      {
        source: 'visible',
        role: 'button',
        name: 'Nonexistent',
        op: 'equals',
        value: true,
        timeout: 400,
      },
    ])
    expect(r?.pass).toBe(false)
    expect(r?.actual).toBe(false)
  })
})
