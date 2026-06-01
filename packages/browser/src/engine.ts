import {
  type Browser,
  type BrowserType,
  chromium,
  firefox,
  type LaunchOptions,
  webkit,
} from 'playwright-core'

/** The browser engines Strummer can drive. Chromium is the default and the
 * most-hardened (it gets the loopback-bypass + WebRTC-neutralize launch args);
 * Firefox/WebKit are for cross-engine parity and rely on the Tier-1 route
 * allowlist + the SSRF proxy for egress control (see `engineLaunchOptions`). */
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit'

const ENGINES: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit }

export function isBrowserEngine(name: string): name is BrowserEngine {
  return Object.hasOwn(ENGINES, name)
}

/** Resolve an engine name to a `BrowserEngine` (default chromium). Throws on an
 * unknown value so an operator typo fails loud rather than silently falling back. */
export function resolveEngine(name: string | undefined): BrowserEngine {
  const n = (name ?? '').trim()
  if (n === '') return 'chromium'
  if (!isBrowserEngine(n)) {
    throw new Error(`unknown browser engine "${name}" (expected chromium | firefox | webkit)`)
  }
  return n
}

/** The `playwright-core` BrowserType for an engine. */
export function browserTypeFor(engine: BrowserEngine): BrowserType {
  return ENGINES[engine]
}

export interface EngineLaunchSpec {
  headless: boolean
  /** Tier-2 SSRF proxy server URL. Honored by ALL engines via `proxy.server`. */
  proxyServer?: string
  /** Drop the Chromium sandbox (a chromium-only CLI arg). */
  noSandbox?: boolean
}

/**
 * Build engine-appropriate Playwright launch options.
 *
 * The SSRF **proxy** (`proxy.server`) is applied to every engine. The hardening
 * **args** — `--proxy-bypass-list=<-loopback>` (force loopback through the
 * pinning proxy, which Chromium otherwise bypasses), `--force-webrtc-ip-handling-
 * policy=disable_non_proxied_udp` (no WebRTC egress bypass), and `--no-sandbox` —
 * are **Chromium CLI flags**: Firefox/WebKit reject or ignore them, so they are
 * emitted only for chromium. For Firefox/WebKit the always-on Tier-1
 * `context.route` allowlist plus the proxy remain the egress controls; chromium
 * stays the recommended hardened engine.
 */
export function engineLaunchOptions(engine: BrowserEngine, spec: EngineLaunchSpec): LaunchOptions {
  const opts: LaunchOptions = { headless: spec.headless }
  if (spec.proxyServer) opts.proxy = { server: spec.proxyServer }
  if (engine === 'chromium') {
    opts.args = [
      ...(spec.proxyServer ? ['--proxy-bypass-list=<-loopback>'] : []),
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ...(spec.noSandbox ? ['--no-sandbox'] : []),
    ]
  }
  return opts
}

/** A launch thunk (engine + options bound) ready to hand to `BrowserManager`. */
export function engineLauncher(
  engine: BrowserEngine,
  spec: EngineLaunchSpec,
): () => Promise<Browser> {
  const type = browserTypeFor(engine)
  const opts = engineLaunchOptions(engine, spec)
  return () => type.launch(opts)
}
