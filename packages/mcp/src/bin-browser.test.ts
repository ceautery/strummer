import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type BuiltBrowserServer, buildBrowserServerFromEnv } from './bin-browser.js'

describe('strummer-browser-mcp bin config (operator env)', () => {
  const built: BuiltBrowserServer[] = []

  async function build(env: Record<string, string> = {}) {
    const b = await buildBrowserServerFromEnv({
      STRUMMER_BROWSER_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), 'strummer-binc-')),
      ...env,
    })
    built.push(b)
    return b
  }

  afterEach(async () => {
    for (const b of built.splice(0)) await b.shutdown()
  })

  it('reads namespaced STRUMMER_BROWSER_* safety env, with NO fallback to the api vars', async () => {
    const b = await build({
      // the api pillar's unprefixed vars must NOT unlock the browser pillar
      STRUMMER_ALLOW_UNSAFE: '1',
      STRUMMER_ALLOWED_HOSTS: 'evil.test',
      STRUMMER_BROWSER_ALLOWED_HOSTS: 'app.test, 127.0.0.1',
    })
    expect(b.config.allowUnsafe).toBe(false)
    expect(b.config.allowedHosts).toEqual(['app.test', '127.0.0.1'])
  })

  it('unlocks mutations only via the browser-namespaced var', async () => {
    const b = await build({ STRUMMER_BROWSER_ALLOW_UNSAFE: 'yes' })
    expect(b.config.allowUnsafe).toBe(true)
  })

  it('ALWAYS builds a DNS-pinning proxy (no disable env) and forces loopback through it', async () => {
    const b = await build({})
    expect(b.proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(b.config.launchArgs).toContain('--proxy-bypass-list=<-loopback>')
  })

  it('defaults trace capture OFF and console/network ON; trace opt-in flips it', async () => {
    const off = await build({})
    expect(off.config.capture).toEqual({ trace: false, console: true, network: true })
    const on = await build({ STRUMMER_BROWSER_CAPTURE_TRACE: '1' })
    expect(on.config.capture.trace).toBe(true)
  })

  it('keeps the sandbox on by default; --no-sandbox is an explicit operator opt-in', async () => {
    const fenced = await build({})
    expect(fenced.config.launchArgs).not.toContain('--no-sandbox')
    const open = await build({ STRUMMER_BROWSER_NO_SANDBOX: '1' })
    expect(open.config.launchArgs).toContain('--no-sandbox')
  })

  it('registers operator secrets by NAME from STRUMMER_BROWSER_SECRET_*', async () => {
    const b = await build({ STRUMMER_BROWSER_SECRET_API_TOKEN: 'super-secret' })
    expect(b.config.secretNames).toContain('API_TOKEN')
    expect(JSON.stringify(b.config)).not.toContain('super-secret') // values never surface in config
  })
})
