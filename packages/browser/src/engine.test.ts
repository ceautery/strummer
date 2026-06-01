import { describe, expect, it } from 'vitest'
import {
  type BrowserEngine,
  engineLaunchOptions,
  isBrowserEngine,
  resolveEngine,
} from './engine.js'

describe('resolveEngine', () => {
  it('defaults to chromium for undefined/empty', () => {
    expect(resolveEngine(undefined)).toBe('chromium')
    expect(resolveEngine('')).toBe('chromium')
    expect(resolveEngine('  ')).toBe('chromium')
  })

  it('accepts the three supported engines', () => {
    for (const e of ['chromium', 'firefox', 'webkit'] as BrowserEngine[]) {
      expect(resolveEngine(e)).toBe(e)
    }
  })

  it('throws on an unknown engine', () => {
    expect(() => resolveEngine('safari')).toThrow(/unknown browser engine/i)
  })

  it('isBrowserEngine is a precise guard', () => {
    expect(isBrowserEngine('firefox')).toBe(true)
    expect(isBrowserEngine('safari')).toBe(false)
  })
})

describe('engineLaunchOptions', () => {
  const proxyServer = 'http://127.0.0.1:9999'

  it('chromium gets the proxy AND the chromium-only hardening args', () => {
    const o = engineLaunchOptions('chromium', { headless: true, proxyServer, noSandbox: true })
    expect(o.headless).toBe(true)
    expect(o.proxy).toEqual({ server: proxyServer })
    expect(o.args).toContain('--proxy-bypass-list=<-loopback>')
    expect(o.args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
    expect(o.args).toContain('--no-sandbox')
  })

  it('chromium omits --no-sandbox unless asked', () => {
    const o = engineLaunchOptions('chromium', { headless: true, proxyServer })
    expect(o.args).not.toContain('--no-sandbox')
  })

  it('firefox/webkit get the proxy but NONE of the chromium CLI args', () => {
    for (const e of ['firefox', 'webkit'] as BrowserEngine[]) {
      const o = engineLaunchOptions(e, { headless: true, proxyServer, noSandbox: true })
      expect(o.proxy).toEqual({ server: proxyServer })
      // chromium-only flags would error/be ignored on firefox/webkit
      expect(o.args).toBeUndefined()
    }
  })

  it('omits the proxy when no server is given (e.g. tests)', () => {
    const o = engineLaunchOptions('chromium', { headless: true })
    expect(o.proxy).toBeUndefined()
    expect(o.args).not.toContain('--proxy-bypass-list=<-loopback>')
  })
})
