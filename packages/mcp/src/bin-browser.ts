#!/usr/bin/env node
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ArtifactStore,
  BrowserGate,
  BrowserManager,
  createSsrfProxy,
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
  headless: boolean
  noSandbox: boolean
  capture: { trace: boolean; console: boolean; network: boolean }
  maxContexts: number
  idleTtlMs: number
  reaperIntervalMs: number
  defaultTimeoutMs: number
  defaultNavigationTimeoutMs: number
  maxNodes?: number
  artifactsDir: string
  launchArgs: string[]
  /** Operator secret NAMES (never values) registered with the redactor. */
  secretNames: string[]
}

export interface BuiltBrowserServer {
  server: McpServer
  manager: BrowserManager
  proxy: SsrfProxy
  config: BrowserBinConfig
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
  const secretNames: string[] = []
  for (const [key, value] of Object.entries(env)) {
    const m = /^STRUMMER_BROWSER_SECRET_(.+)$/.exec(key)
    if (m?.[1] && value) {
      redactor.register(m[1], value)
      secretNames.push(m[1])
    }
  }
  const redact = (s: string) => redactor.redact(s)

  const allowUnsafe = bool(env.STRUMMER_BROWSER_ALLOW_UNSAFE)
  const allowedHosts = (env.STRUMMER_BROWSER_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const allowPrivate = bool(env.STRUMMER_BROWSER_ALLOW_PRIVATE)
  const headless = bool(env.STRUMMER_BROWSER_HEADLESS, true)
  const noSandbox = bool(env.STRUMMER_BROWSER_NO_SANDBOX)
  const capture = {
    trace: bool(env.STRUMMER_BROWSER_CAPTURE_TRACE), // OFF by default (unredacted binary)
    console: bool(env.STRUMMER_BROWSER_CAPTURE_CONSOLE, true),
    network: bool(env.STRUMMER_BROWSER_CAPTURE_NETWORK, true),
  }
  const maxContexts = num(env.STRUMMER_BROWSER_MAX_SESSIONS, 8)
  const idleTtlMs = num(env.STRUMMER_BROWSER_IDLE_TTL_MS, 300_000)
  const reaperIntervalMs = num(env.STRUMMER_BROWSER_REAPER_INTERVAL_MS, idleTtlMs)
  const defaultTimeoutMs = num(env.STRUMMER_BROWSER_TIMEOUT_MS, 0)
  const defaultNavigationTimeoutMs = num(env.STRUMMER_BROWSER_NAV_TIMEOUT_MS, 0)
  const maxNodes = env.STRUMMER_BROWSER_MAX_NODES
    ? num(env.STRUMMER_BROWSER_MAX_NODES, 60)
    : undefined
  const artifactsDir =
    env.STRUMMER_BROWSER_ARTIFACTS_DIR ?? mkdtempSync(join(tmpdir(), 'strummer-browser-artifacts-'))

  // MANDATORY Tier-2 DNS-pinning proxy — deliberately no disable env.
  const proxy = await createSsrfProxy({ allowPrivate })

  // Force loopback through the pinning proxy too (Chromium bypasses the proxy for
  // localhost by default). --no-sandbox stays an explicit operator opt-in.
  const launchArgs = ['--proxy-bypass-list=<-loopback>', ...(noSandbox ? ['--no-sandbox'] : [])]

  const gate = new BrowserGate({ allowUnsafe, allowedHosts })
  const store = new ArtifactStore(artifactsDir)
  const manager = new BrowserManager({
    launch: () => chromium.launch({ headless, proxy: { server: proxy.url }, args: launchArgs }),
    gate,
    maxContexts,
    idleTtlMs,
    defaultTimeoutMs,
    defaultNavigationTimeoutMs,
  })
  const server = createBrowserServer({ manager, gate, artifacts: store, redact, capture, maxNodes })

  const config: BrowserBinConfig = {
    allowUnsafe,
    allowedHosts,
    allowPrivate,
    headless,
    noSandbox,
    capture,
    maxContexts,
    idleTtlMs,
    reaperIntervalMs,
    defaultTimeoutMs,
    defaultNavigationTimeoutMs,
    maxNodes,
    artifactsDir,
    launchArgs,
    secretNames,
  }
  const shutdown = async () => {
    await manager.shutdown()
    await proxy.close()
  }
  return { server, manager, proxy, config, shutdown }
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
