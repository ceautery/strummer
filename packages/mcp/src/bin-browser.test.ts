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

  it('neutralizes WebRTC egress (forces proxied UDP / no IP leak) via a launch arg', async () => {
    const b = await build({})
    expect(b.config.launchArgs).toContain(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    )
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

  it('wires resolveSecret from the same operator-secret map (for {{secret:NAME}} fills)', async () => {
    const b = await build({ STRUMMER_BROWSER_SECRET_API_TOKEN: 'super-secret' })
    expect(b.resolveSecret('API_TOKEN')).toBe('super-secret')
    expect(b.resolveSecret('MISSING')).toBeUndefined()
  })

  it('builds origin-scoped httpCredentials from env, redacts the password, keeps it out of config', async () => {
    const b = await build({
      STRUMMER_BROWSER_HTTP_USERNAME: 'admin',
      STRUMMER_BROWSER_HTTP_PASSWORD: 'basic-pass',
      STRUMMER_BROWSER_HTTP_ORIGIN: 'https://app.test',
    })
    expect(b.config.httpCredentials).toEqual({ username: 'admin', origin: 'https://app.test' })
    expect(JSON.stringify(b.config)).not.toContain('basic-pass') // password never in config
    expect(b.redact('Authorization: Basic basic-pass')).not.toContain('basic-pass') // scrubbed
  })

  it('omits httpCredentials unless BOTH username and password are set', async () => {
    const b = await build({ STRUMMER_BROWSER_HTTP_USERNAME: 'admin' })
    expect(b.config.httpCredentials).toBeUndefined()
  })

  it('parses optional session wall-clock + max-pages caps (omitted when unset)', async () => {
    const none = await build({})
    expect(none.config.maxSessionMs).toBeUndefined()
    expect(none.config.maxPages).toBeUndefined()
    const capped = await build({
      STRUMMER_BROWSER_SESSION_MS: '600000',
      STRUMMER_BROWSER_MAX_PAGES: '3',
    })
    expect(capped.config.maxSessionMs).toBe(600000)
    expect(capped.config.maxPages).toBe(3)
  })

  it('gates storageState capture behind STRUMMER_BROWSER_ALLOW_STORAGE_STATE (default off)', async () => {
    expect((await build({})).config.allowStorageState).toBe(false)
    expect(
      (await build({ STRUMMER_BROWSER_ALLOW_STORAGE_STATE: '1' })).config.allowStorageState,
    ).toBe(true)
  })

  it('gates screenshot capture behind STRUMMER_BROWSER_ALLOW_SCREENSHOTS (default off)', async () => {
    expect((await build({})).config.allowScreenshots).toBe(false)
    expect(
      (await build({ STRUMMER_BROWSER_ALLOW_SCREENSHOTS: 'true' })).config.allowScreenshots,
    ).toBe(true)
  })

  it('gates dialog acceptance behind STRUMMER_BROWSER_ALLOW_DIALOGS (default off)', async () => {
    expect((await build({})).config.allowDialogs).toBe(false)
    expect((await build({ STRUMMER_BROWSER_ALLOW_DIALOGS: 'yes' })).config.allowDialogs).toBe(true)
  })
})
