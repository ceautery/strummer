import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { run } from './index.js'

vi.setConfig({ testTimeout: 60_000 })

// A tiny form: fill a name, click Greet → the heading shows "Hello <name>".
const FIXTURE = `<!doctype html><html lang="en"><head><title>Flow CLI</title></head><body>
  <label>Name <input type="text"></label>
  <button id="go">Greet</button>
  <h1 role="heading"></h1>
  <script>
    document.getElementById('go').addEventListener('click', () => {
      document.querySelector('h1').textContent = 'Hello ' + document.querySelector('input').value
    })
  </script>
</body></html>`

const BRU = 'meta {\n  name: Greet\n  type: http\n}\n'

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

describe('sackville browser run — replay a persisted flow (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let dir: string
  // 127.0.0.1 is loopback → --allow-private for the SSRF proxy; --unsafe to execute.
  const SAFE = ['--no-sandbox', '--allow-private', '--allow-host', '127.0.0.1', '--unsafe']

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    dir = mkdtempSync(join(tmpdir(), 'sackville-flow-cli-'))
  }, 60_000)

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  function writeFlow(stem: string, steps: string) {
    writeFileSync(join(dir, `${stem}.bru`), BRU)
    writeFileSync(join(dir, `${stem}.sackville.yml`), steps)
  }

  it('runs a flow with a {{secret}} fill, passing; never prints the secret', async () => {
    writeFlow(
      'greet',
      `steps:
  - navigate: "{{baseUrl}}"
  - fill: { role: textbox, name: Name, value: "{{secret:WHO}}" }
  - click: { role: button, name: Greet }
  - assert:
      - { source: text, role: heading, op: contains, value: Hello }
`,
    )
    const c = capture({ SACKVILLE_BROWSER_SECRET_WHO: 'World' })
    const code = await run(
      ['browser', 'run', join(dir, 'greet.bru'), '--var', `baseUrl=${baseUrl}`, '--json', ...SAFE],
      c.io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(c.out()) as { passed: boolean; steps: { action: string }[] }
    expect(result.passed).toBe(true)
    expect(result.steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'click', 'assert'])
    // the secret value is never echoed; the redacted token is
    expect(c.out()).not.toContain('World')
    expect(c.out()).toContain('[redacted:WHO]')
  })

  it('exits non-zero when an assertion fails (CI gate)', async () => {
    writeFlow(
      'bad',
      `steps:
  - navigate: "{{baseUrl}}"
  - assert:
      - { source: title, op: equals, value: Nope, timeout: 500 }
`,
    )
    const c = capture()
    const code = await run(
      ['browser', 'run', join(dir, 'bad.bru'), '--var', `baseUrl=${baseUrl}`, ...SAFE],
      c.io,
    )
    expect(code).toBe(1)
    expect(c.out()).toMatch(/FAIL/i)
  })

  it('reports a missing flow path', async () => {
    const c = capture()
    const code = await run(['browser', 'run'], c.io)
    expect(code).toBe(1)
    expect(c.err()).toMatch(/needs|<flow/i)
  })
})
