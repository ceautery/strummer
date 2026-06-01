import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Browser, BrowserContext } from 'playwright-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager, type BrowserManagerOptions } from './manager.js'

// ── Fakes ──────────────────────────────────────────────────────────────────
// The manager only calls newContext/close on a browser and
// setDefaultTimeout/setDefaultNavigationTimeout/close on a context, so a small
// structural fake (cast to the real types at injection) keeps the lifecycle
// logic — caps, the idle reaper, shutdown — fast and deterministic.
class FakeContext {
  closed = false
  timeout: number | undefined
  navTimeout: number | undefined
  options: Record<string, unknown> | undefined
  setDefaultTimeout(ms: number): void {
    this.timeout = ms
  }
  setDefaultNavigationTimeout(ms: number): void {
    this.navTimeout = ms
  }
  async close(): Promise<void> {
    this.closed = true
  }
}
class FakeBrowser {
  contexts: FakeContext[] = []
  closed = false
  async newContext(options?: Record<string, unknown>): Promise<FakeContext> {
    const c = new FakeContext()
    c.options = options
    this.contexts.push(c)
    return c
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

function setup(opts?: Partial<BrowserManagerOptions>) {
  const browser = new FakeBrowser()
  let launchCount = 0
  let nowMs = 1000
  const manager = new BrowserManager({
    launch: async () => {
      launchCount++
      return browser as unknown as Browser
    },
    now: () => nowMs,
    maxContexts: 2,
    idleTtlMs: 5000,
    defaultTimeoutMs: 15000,
    defaultNavigationTimeoutMs: 30000,
    ...opts,
  })
  return {
    manager,
    browser,
    get launchCount() {
      return launchCount
    },
    setNow: (n: number) => {
      nowMs = n
    },
  }
}

describe('BrowserManager (fake browser, deterministic clock)', () => {
  it('fires onReap with the session id BEFORE the context is closed (closeSession + sweepIdle)', async () => {
    const t = setup()
    const events: string[] = []
    // the surface uses this to flush a RunRecorder's artifacts while the context
    // (and its tracer) is still alive
    t.manager.onReap((id) => {
      events.push(`${id}:closed=${t.browser.contexts.at(-1)?.closed}`)
    })

    await t.manager.createSession('s1')
    await t.manager.closeSession('s1')
    expect(events).toEqual(['s1:closed=false'])
    expect(t.browser.contexts[0]?.closed).toBe(true)

    // sweepIdle reaps via closeSession → the hook fires there too
    events.length = 0
    await t.manager.createSession('s2')
    t.setNow(1000 + 6000) // past idleTtlMs
    await t.manager.sweepIdle()
    expect(events).toEqual(['s2:closed=false'])
    expect(t.browser.contexts[1]?.closed).toBe(true)
  })

  it('fires onClosed with the session id AFTER the context is closed (closeSession + sweepIdle)', async () => {
    const t = setup()
    const events: string[] = []
    // the surface uses this to finalize a HAR (written only on context close)
    t.manager.onClosed((id) => {
      events.push(`${id}:closed=${t.browser.contexts.at(-1)?.closed}`)
    })

    await t.manager.createSession('s1')
    await t.manager.closeSession('s1')
    expect(events).toEqual(['s1:closed=true'])

    // sweepIdle reaps via closeSession → onClosed fires there too, after close
    events.length = 0
    await t.manager.createSession('s2')
    t.setNow(1000 + 6000) // past idleTtlMs
    await t.manager.sweepIdle()
    expect(events).toEqual(['s2:closed=true'])
  })

  it('records a HAR per context when an operator harDir is set (content:attach, full)', async () => {
    const t = setup({ harDir: '/tmp/strummer-har' })
    await t.manager.createSession('sess-1')
    const recordHar = t.browser.contexts[0]?.options?.recordHar as
      | { path: string; content: string; mode: string }
      | undefined
    expect(recordHar?.path).toBe('/tmp/strummer-har/sess-1.zip')
    expect(recordHar?.content).toBe('attach')
    expect(recordHar?.mode).toBe('full')
  })

  it('omits recordHar when no harDir is configured', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    expect(
      (t.browser.contexts[0]?.options as { recordHar?: unknown } | undefined)?.recordHar,
    ).toBeUndefined()
  })

  it('blocks service workers on every context (hardening default)', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    expect(t.browser.contexts[0]?.options?.serviceWorkers).toBe('block')
  })

  it('denies downloads by default (acceptDownloads:false) and accepts only when enabled', async () => {
    const denied = setup()
    await denied.manager.createSession('s1')
    expect(denied.browser.contexts[0]?.options?.acceptDownloads).toBe(false)

    const enabled = setup({ acceptDownloads: true })
    await enabled.manager.createSession('s1')
    expect(enabled.browser.contexts[0]?.options?.acceptDownloads).toBe(true)
  })

  it('applies operator origin-scoped httpCredentials to each new context', async () => {
    const httpCredentials = { username: 'admin', password: 's3cr3t', origin: 'https://app.test' }
    const t = setup({ httpCredentials })
    await t.manager.createSession('s1')
    expect(t.browser.contexts[0]?.options?.httpCredentials).toEqual(httpCredentials)
  })

  it('creates contexts without httpCredentials when none are configured', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    expect(
      (t.browser.contexts[0]?.options as { httpCredentials?: unknown } | undefined)
        ?.httpCredentials,
    ).toBeUndefined()
  })

  it('launches the browser lazily and only once, shared across sessions', async () => {
    const t = setup()
    expect(t.launchCount).toBe(0)
    await t.manager.createSession('s1')
    await t.manager.createSession('s2')
    expect(t.launchCount).toBe(1)
    expect(t.browser.contexts).toHaveLength(2)
  })

  it('gives each session its own isolated context and applies default timeouts', async () => {
    const t = setup()
    const c1 = await t.manager.createSession('s1')
    const c2 = await t.manager.createSession('s2')
    expect(c1).not.toBe(c2)
    expect(t.browser.contexts[0]?.timeout).toBe(15000)
    expect(t.browser.contexts[0]?.navTimeout).toBe(30000)
  })

  it('rejects a duplicate session id', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    await expect(t.manager.createSession('s1')).rejects.toThrow(/exists/i)
  })

  it('enforces the maxContexts cap and creates no extra context', async () => {
    const t = setup({ maxContexts: 2 })
    await t.manager.createSession('s1')
    await t.manager.createSession('s2')
    await expect(t.manager.createSession('s3')).rejects.toThrow(/max/i)
    expect(t.browser.contexts).toHaveLength(2)
  })

  it('getContext returns the context and touches its idle clock', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    t.setNow(4000)
    expect(t.manager.getContext('s1')).toBe(t.browser.contexts[0])
    // touched at 4000; with TTL 5000, sweeping at 8000 must NOT reap it
    t.setNow(8000)
    expect(await t.manager.sweepIdle()).toEqual([])
    expect(t.browser.contexts[0]?.closed).toBe(false)
    expect(t.manager.getContext('missing')).toBeUndefined()
  })

  it('sweepIdle closes only contexts idle past the TTL and frees their slots', async () => {
    const t = setup({ maxContexts: 2, idleTtlMs: 5000 })
    await t.manager.createSession('old') // lastUsed = 1000
    t.setNow(3000)
    await t.manager.createSession('fresh') // lastUsed = 3000
    t.setNow(7000) // old idle 6000 (>=5000 → reap); fresh idle 4000 (keep)
    const reaped = await t.manager.sweepIdle()
    expect(reaped).toEqual(['old'])
    expect(t.manager.hasSession('old')).toBe(false)
    expect(t.manager.hasSession('fresh')).toBe(true)
    // a slot freed up → a new session now fits under the cap
    await expect(t.manager.createSession('new')).resolves.toBeDefined()
  })

  it('reaps a session past the wall-clock cap even when actively used', async () => {
    // high idle TTL so idle-reaping can't fire; the session is kept "fresh" by a
    // touch — only the wall-clock (createdAt) cap should reap it
    const t = setup({ idleTtlMs: 100_000, maxSessionMs: 10_000 })
    await t.manager.createSession('s1') // createdAt = 1000
    t.setNow(12_000)
    t.manager.touch('s1') // lastUsedAt = 12000 → not idle
    const reaped = await t.manager.sweepIdle()
    expect(reaped).toContain('s1')
    expect(t.manager.hasSession('s1')).toBe(false)
  })

  it('keeps a session within the wall-clock cap', async () => {
    const t = setup({ idleTtlMs: 100_000, maxSessionMs: 10_000 })
    await t.manager.createSession('s1') // createdAt = 1000
    t.setNow(9_000) // age 8000 < 10000, idle 8000 < 100000
    expect(await t.manager.sweepIdle()).toEqual([])
    expect(t.manager.hasSession('s1')).toBe(true)
  })

  it('closeSession closes + removes; unknown id is a no-op', async () => {
    const t = setup()
    const c = await t.manager.createSession('s1')
    await t.manager.closeSession('s1')
    expect((c as unknown as FakeContext).closed).toBe(true)
    expect(t.manager.hasSession('s1')).toBe(false)
    await expect(t.manager.closeSession('nope')).resolves.toBeUndefined()
  })

  it('fires onClosed for every session on shutdown (so HARs get finalized/cleaned)', async () => {
    const t = setup()
    const closed: string[] = []
    // onClosed fires after the context is closed — assert the context is already closed
    t.manager.onClosed((id) => {
      closed.push(id)
      expect(t.browser.contexts.every((c) => c.closed)).toBe(true)
    })
    await t.manager.createSession('s1')
    await t.manager.createSession('s2')
    await t.manager.shutdown()
    expect(closed.sort()).toEqual(['s1', 's2'])
  })

  it('shutdown closes every context and the browser', async () => {
    const t = setup()
    await t.manager.createSession('s1')
    await t.manager.createSession('s2')
    await t.manager.shutdown()
    expect(t.browser.contexts.every((c) => c.closed)).toBe(true)
    expect(t.browser.closed).toBe(true)
    expect(t.manager.sessionCount).toBe(0)
  })

  it('startReaper periodically sweeps idle contexts; stopReaper halts it', async () => {
    vi.useFakeTimers()
    try {
      const t = setup({ idleTtlMs: 5000 })
      await t.manager.createSession('s1') // lastUsed = 1000
      t.setNow(20000) // well past TTL
      t.manager.startReaper(1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.manager.hasSession('s1')).toBe(false)
      t.manager.stopReaper()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('BrowserManager (real headless chromium integration)', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>Lifecycle</title><h1>ok</h1>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
  })

  it('creates a usable isolated context and tears everything down', async () => {
    const { chromium } = await import('playwright-core')
    const manager = new BrowserManager({
      launch: () => chromium.launch({ headless: true, args: ['--no-sandbox'] }),
    })
    const context: BrowserContext = await manager.createSession('live')
    const page = await context.newPage()
    await page.goto(baseUrl)
    expect(await page.title()).toBe('Lifecycle')
    await manager.shutdown()
    expect(manager.sessionCount).toBe(0)
  }, 60_000)

  it('writes a HAR archive to the operator harDir when a session closes', async () => {
    const { chromium } = await import('playwright-core')
    const { existsSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { harPathFor } = await import('./har.js')
    const harDir = mkdtempSync(join(tmpdir(), 'strummer-har-mgr-'))
    const manager = new BrowserManager({
      launch: () => chromium.launch({ headless: true, args: ['--no-sandbox'] }),
      harDir,
    })
    try {
      const context = await manager.createSession('live')
      const page = await context.newPage()
      await page.goto(baseUrl, { waitUntil: 'networkidle' })
      await manager.closeSession('live') // closing flushes the HAR to disk
      expect(existsSync(harPathFor(harDir, 'live'))).toBe(true)
    } finally {
      await manager.shutdown()
      rmSync(harDir, { recursive: true, force: true })
    }
  }, 60_000)

  it('caps pages per context, closing any page opened beyond maxPages', async () => {
    const { chromium } = await import('playwright-core')
    const manager = new BrowserManager({
      launch: () => chromium.launch({ headless: true, args: ['--no-sandbox'] }),
      maxPages: 1,
    })
    try {
      const context = await manager.createSession('live')
      const page = await context.newPage() // the one allowed page
      await page.goto(baseUrl)
      // a second page (e.g. a popup) is opened — the cap guard must close it
      await context.newPage()
      await new Promise((r) => setTimeout(r, 300))
      expect(context.pages().length).toBe(1)
      expect(page.isClosed()).toBe(false) // the original page survives
    } finally {
      await manager.shutdown()
    }
  }, 60_000)
})
