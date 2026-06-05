import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PageDriver } from './driver.js'
import { type BrowserEngine, browserTypeFor, engineLauncher } from './engine.js'
import { BrowserManager } from './manager.js'

// Real Firefox/WebKit launches are slower than Vitest's 5s default.
vi.setConfig({ testTimeout: 60_000 })

const FIXTURE = `<!doctype html><html lang="en"><head><title>Multi-engine</title></head><body>
  <h1>Multi-engine</h1>
  <button id="add">Add</button>
  <ul id="list"></ul>
  <script>
    document.getElementById('add').addEventListener('click', () => {
      const li = document.createElement('li')
      li.textContent = 'added-item'
      document.getElementById('list').appendChild(li)
    })
  </script>
</body></html>`

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(FIXTURE)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function refFor(driver: PageDriver, role: string, name: string): string {
  const hit = [...driver.refs.entries()].find(([, d]) => d.role === role && d.name === name)
  if (!hit) throw new Error(`no ref for ${role} "${name}"`)
  return hit[0]
}

// Run for firefox + webkit, but only where the engine binary is actually
// installed (the dev image + CI provision all three; a chromium-only env skips
// gracefully so the green gate stays 100%). Chromium is covered by the rest of
// the suite. This proves the SAME Sackville stack (engineLauncher → BrowserManager
// → PageDriver: navigate → ARIA snapshot → ref click → re-snapshot) drives a real
// Firefox and WebKit, not just Chromium.
for (const engine of ['firefox', 'webkit'] as BrowserEngine[]) {
  const installed = existsSync(browserTypeFor(engine).executablePath())
  describe.skipIf(!installed)(`multi-engine: ${engine}`, () => {
    it('drives navigate → snapshot → click → re-snapshot end to end', async () => {
      const manager = new BrowserManager({ launch: engineLauncher(engine, { headless: true }) })
      try {
        const context = await manager.createSession('s')
        const page = await context.newPage()
        // No gate → ungated raw layer, so the click executes (the MCP surface
        // always supplies a gate; here we're proving the engine drives).
        const driver = new PageDriver(page)
        await driver.navigate(baseUrl)
        expect(driver.snapshotText).toContain('button "Add"')

        await driver.click(refFor(driver, 'button', 'Add'))
        // The re-captured snapshot reflects the DOM mutation the click caused.
        expect(driver.snapshotText).toContain('added-item')
      } finally {
        await manager.shutdown()
      }
    })
  })
}
