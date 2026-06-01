#!/usr/bin/env node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ArtifactStore,
  auditPerf,
  type BrowserEngine,
  BrowserGate,
  BrowserManager,
  createSsrfProxy,
  engineLauncher,
  engineLaunchOptions,
  resolveEngine,
  type SsrfProxy,
} from '@strummer/browser'
import { Redactor } from '@strummer/safety'
import { chromium } from 'playwright-core'
import { createBrowserServer } from './browser.js'

/**
 * `strummer-browser-mcp` — the operator-configured server bin. This is the ONLY
 * reader of the `STRUMMER_BROWSER_*` operator env and the ONLY constructor of the
 * network-egress boundary (mirrors `bin-api.ts`). Every safety knob is namespaced
 * (`STRUMMER_BROWSER_*`) with **no fallback** to the api pillar's unprefixed vars,
 * so unlocking the API pillar never silently unlocks the browser pillar.
 *
 * The Tier-2 DNS-pinning SSRF proxy is **mandatory** — there is deliberately no
 * disable env (an operator must not be able to turn off rebinding protection from
 * env). Chromium is launched with `--proxy-bypass-list=<-loopback>` so loopback
 * ALSO traverses the pinning proxy (Chromium otherwise bypasses the proxy for
 * localhost — a documented gap that `allowPrivate` would not actually govern).
 */

const TRUTHY = ['1', 'true', 'yes']
const bool = (v: string | undefined, dflt = false): boolean =>
  v === undefined ? dflt : TRUTHY.includes(v.toLowerCase())

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

export interface BrowserBinConfig {
  allowUnsafe: boolean
  allowedHosts: string[]
  allowPrivate: boolean
  /** Whether JS dialogs are accepted (true) or dismissed (false, default). */
  allowDialogs: boolean
  /** The browser engine the server drives (operator-selected; default chromium). */
  engine: BrowserEngine
  headless: boolean
  noSandbox: boolean
  capture: { trace: boolean; console: boolean; network: boolean }
  maxContexts: number
  idleTtlMs: number
  reaperIntervalMs: number
  maxSessionMs?: number
  maxPages?: number
  defaultTimeoutMs: number
  defaultNavigationTimeoutMs: number
  maxNodes?: number
  artifactsDir: string
  launchArgs: string[]
  /** Operator secret NAMES (never values) registered with the redactor. */
  secretNames: string[]
  /** Origin-scoped HTTP Basic auth, password-free (the password never lands here). */
  httpCredentials?: { username: string; origin?: string }
  /** Whether browser_save_storage_state is enabled (password-equivalent capture). */
  allowStorageState: boolean
  /** Whether browser_screenshot is enabled (unredactable PNG pixels). */
  allowScreenshots: boolean
  /** Whether browser_vision_click/move are enabled (blind coordinate input). */
  allowVision: boolean
  /** Operator download-quarantine dir (downloads denied/cancelled when unset). */
  downloadDir?: string
  /** Operator upload-allowlist dir (uploads denied when unset). */
  uploadDir?: string
  /** Operator "network heavy mode" HAR output dir (no HAR capture when unset). */
  harDir?: string
  /** Operator HAR-replay dir (replay denied when unset). */
  replayDir?: string
  /** Operator persisted-flows dir (browser_list_flows/browser_run_flow denied when unset). */
  flowsDir?: string
  /** Operator visual-regression baseline dir (browser_visual_compare denied when unset). */
  baselineDir?: string
  /** Whether browser_visual_compare may (over)write a baseline from the current page. */
  allowBaselineUpdate: boolean
  /** Operator video-capture dir (no video recorded when unset). */
  videoDir?: string
  /** Optional recorded-video frame-size cap (both width + height required). */
  videoSize?: { width: number; height: number }
}

export interface BuiltBrowserServer {
  server: McpServer
  manager: BrowserManager
  proxy: SsrfProxy
  config: BrowserBinConfig
  /** Resolve an operator secret NAME → value (same map the redactor is built from). */
  resolveSecret: (name: string) => string | undefined
  /** The operator redactor's scrub function (secrets + http password). */
  redact: (value: string) => string
  /** Tear down the manager (and browser) then close the proxy. */
  shutdown: () => Promise<void>
}

/**
 * Build (but do not connect/serve) the browser MCP server from operator env.
 * Exported so the wiring — namespaced safety env, the mandatory proxy, the
 * loopback-bypass launch arg, capture defaults — is unit-testable without
 * launching Chromium or attaching a transport.
 */
export async function buildBrowserServerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BuiltBrowserServer> {
  // Secrets: STRUMMER_BROWSER_SECRET_<NAME>=value — register NAME→value; values
  // are never logged or surfaced (only the NAME appears anywhere).
  const redactor = new Redactor()
  const secrets = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    const m = /^STRUMMER_BROWSER_SECRET_(.+)$/.exec(key)
    if (m?.[1] && value) {
      redactor.register(m[1], value)
      secrets.set(m[1], value)
    }
  }
  const secretNames = [...secrets.keys()]
  const resolveSecret = (name: string) => secrets.get(name)

  // Origin-scoped HTTP Basic auth (operator-set). Built only when BOTH username +
  // password are present; the password is registered with the redactor so it never
  // leaks via an artifact, and it never appears in the returned config.
  const httpUsername = env.STRUMMER_BROWSER_HTTP_USERNAME
  const httpPassword = env.STRUMMER_BROWSER_HTTP_PASSWORD
  const httpOrigin = env.STRUMMER_BROWSER_HTTP_ORIGIN
  let httpCredentials: { username: string; password: string; origin?: string } | undefined
  if (httpUsername && httpPassword) {
    redactor.register('http-credentials', httpPassword)
    httpCredentials = {
      username: httpUsername,
      password: httpPassword,
      ...(httpOrigin ? { origin: httpOrigin } : {}),
    }
  }
  const redact = (s: string) => redactor.redact(s)

  const allowUnsafe = bool(env.STRUMMER_BROWSER_ALLOW_UNSAFE)
  const allowedHosts = (env.STRUMMER_BROWSER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const allowPrivate = bool(env.STRUMMER_BROWSER_ALLOW_PRIVATE)
  const allowDialogs = bool(env.STRUMMER_BROWSER_ALLOW_DIALOGS)
  const allowStorageState = bool(env.STRUMMER_BROWSER_ALLOW_STORAGE_STATE)
  const allowScreenshots = bool(env.STRUMMER_BROWSER_ALLOW_SCREENSHOTS)
  // Vision/coordinate input (blind pixel click/move) — off by default, like screenshots.
  const allowVision = bool(env.STRUMMER_BROWSER_ALLOW_VISION)
  // Downloads: deny-by-default. An operator quarantine dir flips acceptDownloads on
  // AND tells the driver where to save; unset ⇒ contexts cancel every download.
  const downloadDir = env.STRUMMER_BROWSER_DOWNLOAD_DIR || undefined
  const acceptDownloads = downloadDir !== undefined
  // Uploads: deny-by-default. An operator allowlist dir is the exfiltration control.
  const uploadDir = env.STRUMMER_BROWSER_UPLOAD_DIR || undefined
  // "Network heavy mode": HAR capture off unless the operator sets an output dir.
  // HAR is a heavy secret surface (full req/resp headers+bodies), so it is gated
  // off like the trace; the manager records it, the surface finalizes (redacted).
  const harDir = env.STRUMMER_BROWSER_HAR_DIR || undefined
  // HAR replay (offline determinism): deny-by-default. An operator replay dir is
  // the trust boundary — the source HAR dictates what the page is served.
  const replayDir = env.STRUMMER_BROWSER_REPLAY_HAR_DIR || undefined
  // Persisted flows: deny-by-default. An operator flows dir holds the replayable
  // .bru + sidecar flows browser_run_flow may run (by name, no caller path).
  const flowsDir = env.STRUMMER_BROWSER_FLOWS_DIR || undefined
  // Visual regression: compare off unless an operator baseline dir is set; recording
  // a baseline (the accepted golden) is separately gated so an agent can't rewrite it.
  const baselineDir = env.STRUMMER_BROWSER_BASELINE_DIR || undefined
  const allowBaselineUpdate = bool(env.STRUMMER_BROWSER_ALLOW_BASELINE_UPDATE)
  // Video capture: off unless the operator sets an output dir. Video is unredactable
  // pixels (gated off like the trace/screenshots). An optional size cap needs BOTH
  // dimensions; the session wall-clock cap (SESSION_MS) bounds duration.
  const videoDir = env.STRUMMER_BROWSER_VIDEO_DIR || undefined
  const videoWidth = env.STRUMMER_BROWSER_VIDEO_WIDTH
  const videoHeight = env.STRUMMER_BROWSER_VIDEO_HEIGHT
  const videoSize =
    videoWidth && videoHeight
      ? { width: num(videoWidth, 0), height: num(videoHeight, 0) }
      : undefined
  const headless = bool(env.STRUMMER_BROWSER_HEADLESS, true)
  const noSandbox = bool(env.STRUMMER_BROWSER_NO_SANDBOX)
  // Operator-selected engine (default chromium). Resolved EARLY so a typo fails
  // loud before any resource (proxy, browser) is allocated. One engine per server.
  const engine: BrowserEngine = resolveEngine(env.STRUMMER_BROWSER_ENGINE)
  const capture = {
    trace: bool(env.STRUMMER_BROWSER_CAPTURE_TRACE), // OFF by default (unredacted binary)
    console: bool(env.STRUMMER_BROWSER_CAPTURE_CONSOLE, true),
    network: bool(env.STRUMMER_BROWSER_CAPTURE_NETWORK, true),
  }
  const maxContexts = num(env.STRUMMER_BROWSER_MAX_SESSIONS, 8)
  const idleTtlMs = num(env.STRUMMER_BROWSER_IDLE_TTL_MS, 300_000)
  const reaperIntervalMs = num(env.STRUMMER_BROWSER_REAPER_INTERVAL_MS, idleTtlMs)
  // Optional resource caps — undefined (no cap) unless the operator sets them.
  const maxSessionMs = env.STRUMMER_BROWSER_SESSION_MS
    ? num(env.STRUMMER_BROWSER_SESSION_MS, 0)
    : undefined
  const maxPages = env.STRUMMER_BROWSER_MAX_PAGES
    ? num(env.STRUMMER_BROWSER_MAX_PAGES, 0)
    : undefined
  const defaultTimeoutMs = num(env.STRUMMER_BROWSER_TIMEOUT_MS, 0)
  const defaultNavigationTimeoutMs = num(env.STRUMMER_BROWSER_NAV_TIMEOUT_MS, 0)
  const maxNodes = env.STRUMMER_BROWSER_MAX_NODES
    ? num(env.STRUMMER_BROWSER_MAX_NODES, 60)
    : undefined
  const artifactsDir =
    env.STRUMMER_BROWSER_ARTIFACTS_DIR ?? mkdtempSync(join(tmpdir(), 'strummer-browser-artifacts-'))

  // MANDATORY Tier-2 DNS-pinning proxy — deliberately no disable env.
  const proxy = await createSsrfProxy({ allowPrivate })

  // Chromium is the hardened default — it gets the loopback-bypass +
  // WebRTC-neutralize CLI args below; Firefox/WebKit rely on the always-on Tier-1
  // route allowlist + the proxy (see engineLaunchOptions).
  const launchSpec = { headless, proxyServer: proxy.url, noSandbox }
  // Hardening launch args (chromium only; empty for firefox/webkit):
  // - --proxy-bypass-list=<-loopback> forces loopback through the pinning proxy too
  //   (Chromium bypasses the proxy for localhost by default).
  // - --force-webrtc-ip-handling-policy=disable_non_proxied_udp neutralizes WebRTC
  //   egress: only proxied UDP is allowed (no P2P bypass of the SSRF proxy, no local
  //   IP leak). --no-sandbox stays an explicit operator opt-in.
  const launchArgs = engineLaunchOptions(engine, launchSpec).args ?? []

  const gate = new BrowserGate({ allowUnsafe, allowedHosts, allowDialogs })
  const store = new ArtifactStore(artifactsDir)
  // Lighthouse spawns its OWN Chrome (chrome-launcher) and is Chrome-only, so the
  // perf audit ALWAYS uses chromium regardless of the session engine. It gets the
  // same egress boundary via flags: the mandatory SSRF proxy + loopback-bypass +
  // WebRTC neutralize + the operator sandbox choice. Reports are redacted before write.
  const perfChromeFlags = [
    `--proxy-server=${proxy.url}`,
    '--proxy-bypass-list=<-loopback>',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-gpu',
    ...(headless ? ['--headless=new'] : []),
    ...(noSandbox ? ['--no-sandbox'] : []),
  ]
  const runPerfAudit = (url: string, runId: string) =>
    auditPerf(url, {
      runId,
      store,
      chromePath: chromium.executablePath(),
      chromeFlags: perfChromeFlags,
      redact,
    })
  const manager = new BrowserManager({
    launch: engineLauncher(engine, launchSpec),
    gate,
    maxContexts,
    idleTtlMs,
    defaultTimeoutMs,
    defaultNavigationTimeoutMs,
    httpCredentials,
    maxSessionMs,
    maxPages,
    acceptDownloads,
    harDir,
    videoDir,
    videoSize,
  })
  const server = createBrowserServer({
    manager,
    gate,
    artifacts: store,
    redact,
    resolveSecret,
    allowStorageState,
    allowScreenshots,
    allowVision,
    downloadDir,
    uploadDir,
    harDir,
    replayDir,
    flowsDir,
    videoDir,
    baselineDir,
    allowBaselineUpdate,
    runPerfAudit,
    capture,
    maxNodes,
  })

  const config: BrowserBinConfig = {
    allowUnsafe,
    allowedHosts,
    allowPrivate,
    allowDialogs,
    engine,
    headless,
    noSandbox,
    capture,
    maxContexts,
    idleTtlMs,
    reaperIntervalMs,
    maxSessionMs,
    maxPages,
    defaultTimeoutMs,
    defaultNavigationTimeoutMs,
    maxNodes,
    artifactsDir,
    launchArgs,
    secretNames,
    allowStorageState,
    allowScreenshots,
    allowVision,
    downloadDir,
    uploadDir,
    harDir,
    replayDir,
    flowsDir,
    videoDir,
    videoSize,
    baselineDir,
    allowBaselineUpdate,
    httpCredentials: httpCredentials
      ? {
          username: httpCredentials.username,
          ...(httpCredentials.origin ? { origin: httpCredentials.origin } : {}),
        }
      : undefined,
  }
  const shutdown = async () => {
    await manager.shutdown()
    await proxy.close()
  }
  return { server, manager, proxy, config, resolveSecret, redact, shutdown }
}

// Run as a server only when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const { server, manager, config, shutdown } = await buildBrowserServerFromEnv()
  manager.startReaper(config.reaperIntervalMs)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0))
    })
  }
  await server.connect(new StdioServerTransport())
}
