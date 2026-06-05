import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BuiltBrowserServer,
  buildBrowserRuntimeFromEnv,
  buildBrowserServerFromEnv,
} from './bin-browser.js'

describe('sackville-browser-mcp bin config (operator env)', () => {
  const built: BuiltBrowserServer[] = []

  async function build(env: Record<string, string> = {}) {
    const b = await buildBrowserServerFromEnv({
      SACKVILLE_BROWSER_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), 'sackville-binc-')),
      ...env,
    })
    built.push(b)
    return b
  }

  afterEach(async () => {
    for (const b of built.splice(0)) await b.shutdown()
  })

  it('buildBrowserRuntimeFromEnv exposes the egress-safe runtime (proxy started + gate + manager) for reuse', async () => {
    // The single-source egress wiring the 5e verify-driven capture reuses (ADR 0013
    // Addendum 3): the proxy is STARTED, the gate is built, and the manager + config carry
    // the hardening launch args — so the verify path can't re-implement and omit one.
    const rt = await buildBrowserRuntimeFromEnv({
      SACKVILLE_BROWSER_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), 'sackville-rt-')),
      SACKVILLE_BROWSER_ALLOWED_HOSTS: 'app.test',
    })
    try {
      expect(rt.proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(rt.gate.isHostAllowed('https://app.test/x')).toBe(true)
      expect(rt.gate.isHostAllowed('https://evil.test/x')).toBe(false)
      expect(rt.manager).toBeDefined()
      expect(rt.config.launchArgs).toContain('--proxy-bypass-list=<-loopback>')
    } finally {
      await rt.shutdown()
    }
  })

  it('reads namespaced SACKVILLE_BROWSER_* safety env, with NO fallback to the api vars', async () => {
    const b = await build({
      // the api pillar's unprefixed vars must NOT unlock the browser pillar
      SACKVILLE_ALLOW_UNSAFE: '1',
      SACKVILLE_ALLOWED_HOSTS: 'evil.test',
      SACKVILLE_BROWSER_ALLOWED_HOSTS: 'app.test, 127.0.0.1',
    })
    expect(b.config.allowUnsafe).toBe(false)
    expect(b.config.allowedHosts).toEqual(['app.test', '127.0.0.1'])
  })

  it('unlocks mutations only via the browser-namespaced var', async () => {
    const b = await build({ SACKVILLE_BROWSER_ALLOW_UNSAFE: 'yes' })
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

  it('defaults to the chromium engine', async () => {
    const b = await build({})
    expect(b.config.engine).toBe('chromium')
  })

  it('selects firefox/webkit via SACKVILLE_BROWSER_ENGINE — and drops the chromium-only args', async () => {
    for (const engine of ['firefox', 'webkit']) {
      const b = await build({ SACKVILLE_BROWSER_ENGINE: engine })
      expect(b.config.engine).toBe(engine)
      // chromium CLI flags would error/no-op on firefox/webkit, so they're omitted.
      expect(b.config.launchArgs).toEqual([])
    }
  })

  it('fails loud on an unknown engine', async () => {
    await expect(
      buildBrowserServerFromEnv({
        SACKVILLE_BROWSER_ARTIFACTS_DIR: mkdtempSync(join(tmpdir(), 'sackville-binc-')),
        SACKVILLE_BROWSER_ENGINE: 'safari',
      }),
    ).rejects.toThrow(/unknown browser engine/i)
  })

  it('defaults trace capture OFF and console/network ON; trace opt-in flips it', async () => {
    const off = await build({})
    expect(off.config.capture).toEqual({ trace: false, console: true, network: true })
    const on = await build({ SACKVILLE_BROWSER_CAPTURE_TRACE: '1' })
    expect(on.config.capture.trace).toBe(true)
  })

  it('keeps the sandbox on by default; --no-sandbox is an explicit operator opt-in', async () => {
    const fenced = await build({})
    expect(fenced.config.launchArgs).not.toContain('--no-sandbox')
    const open = await build({ SACKVILLE_BROWSER_NO_SANDBOX: '1' })
    expect(open.config.launchArgs).toContain('--no-sandbox')
  })

  it('registers operator secrets by NAME from SACKVILLE_BROWSER_SECRET_*', async () => {
    const b = await build({ SACKVILLE_BROWSER_SECRET_API_TOKEN: 'super-secret' })
    expect(b.config.secretNames).toContain('API_TOKEN')
    expect(JSON.stringify(b.config)).not.toContain('super-secret') // values never surface in config
  })

  it('wires resolveSecret from the same operator-secret map (for {{secret:NAME}} fills)', async () => {
    const b = await build({ SACKVILLE_BROWSER_SECRET_API_TOKEN: 'super-secret' })
    expect(b.resolveSecret('API_TOKEN')).toBe('super-secret')
    expect(b.resolveSecret('MISSING')).toBeUndefined()
  })

  it('builds origin-scoped httpCredentials from env, redacts the password, keeps it out of config', async () => {
    const b = await build({
      SACKVILLE_BROWSER_HTTP_USERNAME: 'admin',
      SACKVILLE_BROWSER_HTTP_PASSWORD: 'basic-pass',
      SACKVILLE_BROWSER_HTTP_ORIGIN: 'https://app.test',
    })
    expect(b.config.httpCredentials).toEqual({ username: 'admin', origin: 'https://app.test' })
    expect(JSON.stringify(b.config)).not.toContain('basic-pass') // password never in config
    expect(b.redact('Authorization: Basic basic-pass')).not.toContain('basic-pass') // scrubbed
  })

  it('omits httpCredentials unless BOTH username and password are set', async () => {
    const b = await build({ SACKVILLE_BROWSER_HTTP_USERNAME: 'admin' })
    expect(b.config.httpCredentials).toBeUndefined()
  })

  it('parses optional session wall-clock + max-pages caps (omitted when unset)', async () => {
    const none = await build({})
    expect(none.config.maxSessionMs).toBeUndefined()
    expect(none.config.maxPages).toBeUndefined()
    const capped = await build({
      SACKVILLE_BROWSER_SESSION_MS: '600000',
      SACKVILLE_BROWSER_MAX_PAGES: '3',
    })
    expect(capped.config.maxSessionMs).toBe(600000)
    expect(capped.config.maxPages).toBe(3)
  })

  it('gates storageState capture behind SACKVILLE_BROWSER_ALLOW_STORAGE_STATE (default off)', async () => {
    expect((await build({})).config.allowStorageState).toBe(false)
    expect(
      (await build({ SACKVILLE_BROWSER_ALLOW_STORAGE_STATE: '1' })).config.allowStorageState,
    ).toBe(true)
  })

  it('gates screenshot capture behind SACKVILLE_BROWSER_ALLOW_SCREENSHOTS (default off)', async () => {
    expect((await build({})).config.allowScreenshots).toBe(false)
    expect(
      (await build({ SACKVILLE_BROWSER_ALLOW_SCREENSHOTS: 'true' })).config.allowScreenshots,
    ).toBe(true)
  })

  it('gates vision/coordinate input behind SACKVILLE_BROWSER_ALLOW_VISION (default off)', async () => {
    expect((await build({})).config.allowVision).toBe(false)
    expect((await build({ SACKVILLE_BROWSER_ALLOW_VISION: '1' })).config.allowVision).toBe(true)
  })

  it('gates dialog acceptance behind SACKVILLE_BROWSER_ALLOW_DIALOGS (default off)', async () => {
    expect((await build({})).config.allowDialogs).toBe(false)
    expect((await build({ SACKVILLE_BROWSER_ALLOW_DIALOGS: 'yes' })).config.allowDialogs).toBe(true)
  })

  it('denies downloads unless SACKVILLE_BROWSER_DOWNLOAD_DIR sets a quarantine dir', async () => {
    expect((await build({})).config.downloadDir).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-dlq-'))
    expect((await build({ SACKVILLE_BROWSER_DOWNLOAD_DIR: dir })).config.downloadDir).toBe(dir)
  })

  it('denies uploads unless SACKVILLE_BROWSER_UPLOAD_DIR sets an allowlist dir', async () => {
    expect((await build({})).config.uploadDir).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-upq-'))
    expect((await build({ SACKVILLE_BROWSER_UPLOAD_DIR: dir })).config.uploadDir).toBe(dir)
  })

  it('records no HAR unless SACKVILLE_BROWSER_HAR_DIR sets a network-heavy output dir', async () => {
    expect((await build({})).config.harDir).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-har-'))
    expect((await build({ SACKVILLE_BROWSER_HAR_DIR: dir })).config.harDir).toBe(dir)
  })

  it('denies HAR replay unless SACKVILLE_BROWSER_REPLAY_HAR_DIR sets a replay dir', async () => {
    expect((await build({})).config.replayDir).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-replay-'))
    expect((await build({ SACKVILLE_BROWSER_REPLAY_HAR_DIR: dir })).config.replayDir).toBe(dir)
  })

  it('disables flows unless SACKVILLE_BROWSER_FLOWS_DIR sets a flows dir', async () => {
    expect((await build({})).config.flowsDir).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-flows-'))
    expect((await build({ SACKVILLE_BROWSER_FLOWS_DIR: dir })).config.flowsDir).toBe(dir)
  })

  it('disables visual compare unless SACKVILLE_BROWSER_BASELINE_DIR is set; gates baseline update', async () => {
    expect((await build({})).config.baselineDir).toBeUndefined()
    expect((await build({})).config.allowBaselineUpdate).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'sackville-baseline-'))
    const on = await build({
      SACKVILLE_BROWSER_BASELINE_DIR: dir,
      SACKVILLE_BROWSER_ALLOW_BASELINE_UPDATE: '1',
    })
    expect(on.config.baselineDir).toBe(dir)
    expect(on.config.allowBaselineUpdate).toBe(true)
  })

  it('records no video unless SACKVILLE_BROWSER_VIDEO_DIR is set; parses an optional size cap', async () => {
    expect((await build({})).config.videoDir).toBeUndefined()
    expect((await build({})).config.videoSize).toBeUndefined()
    const dir = mkdtempSync(join(tmpdir(), 'sackville-video-'))
    const on = await build({
      SACKVILLE_BROWSER_VIDEO_DIR: dir,
      SACKVILLE_BROWSER_VIDEO_WIDTH: '640',
      SACKVILLE_BROWSER_VIDEO_HEIGHT: '480',
    })
    expect(on.config.videoDir).toBe(dir)
    expect(on.config.videoSize).toEqual({ width: 640, height: 480 })
    // a dir with only one dimension set ⇒ no size cap (need both)
    const partial = await build({
      SACKVILLE_BROWSER_VIDEO_DIR: dir,
      SACKVILLE_BROWSER_VIDEO_WIDTH: '640',
    })
    expect(partial.config.videoSize).toBeUndefined()
  })
})
