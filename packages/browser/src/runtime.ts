/**
 * The shared browser-capture runtime builder. The browser CLI (`sackville browser
 * run`), the verify CLI's `--flow` capture path, and the browser MCP server each
 * stand up the same core — a `BrowserGate`, a mandatory DNS-pinning SSRF proxy, a
 * `BrowserManager`, and a secret resolver/redactor from `SACKVILLE_BROWSER_SECRET_*`
 * — and they had **drifted**: the verify CLI's copy shipped without the
 * unsafe/secret wiring the other two had, so `verify run --flow` couldn't drive a
 * real flow. This is the single source of truth for that construction. The MCP
 * server's runtime is a strict superset (download/upload dirs, video, retention,
 * http-credentials, …), so it builds its own richer `BrowserManager` but shares
 * `browserSecretsFromEnv` for the one part that genuinely overlaps.
 */
import { Redactor } from '@sackville-mcp/safety'
import { engineLauncher, resolveEngine } from './engine.js'
import { BrowserGate } from './gate.js'
import type { CaptureRuntime } from './live-capture.js'
import { BrowserManager } from './manager.js'
import { createSsrfProxy } from './proxy.js'

/** A redactor + secret resolver built from `SACKVILLE_BROWSER_SECRET_<NAME>` env. */
export interface BrowserSecrets {
  /** The redactor the secret values are registered with (so callers can register more). */
  redactor: Redactor
  redact: (value: string) => string
  resolveSecret: (name: string) => string | undefined
  /** The registered secret NAMES (never the values) — for surfacing what's available. */
  secretNames: string[]
}

/**
 * Parse `SACKVILLE_BROWSER_SECRET_<NAME>=value` env vars into a redactor + resolver.
 * Values are registered for redaction and never surfaced; only NAMEs are exposed.
 * The single implementation behind the browser CLI, the verify CLI, and the MCP
 * server (which layers HTTP-credentials onto the returned `redactor`).
 */
export function browserSecretsFromEnv(env: Record<string, string | undefined>): BrowserSecrets {
  const redactor = new Redactor()
  const secrets = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    const m = /^SACKVILLE_BROWSER_SECRET_(.+)$/.exec(key)
    if (m?.[1] && value) {
      redactor.register(m[1], value)
      secrets.set(m[1], value)
    }
  }
  return {
    redactor,
    redact: (s) => redactor.redact(s),
    resolveSecret: (name) => secrets.get(name),
    secretNames: [...secrets.keys()],
  }
}

/** Normalized options for {@link buildCaptureRuntime} — surface-agnostic (the CLI
 * flag / MCP env adapters map onto this). `harDir` set ⇒ the manager records a HAR
 * (the capture path); omitted ⇒ no HAR (e.g. interactive flow replay). */
export interface BuildCaptureRuntimeOptions {
  allowedHosts: string[]
  allowUnsafe?: boolean
  allowPrivate?: boolean
  engine?: string
  headless?: boolean
  noSandbox?: boolean
  harDir?: string
  redact?: (value: string) => string
  resolveSecret?: (name: string) => string | undefined
}

/**
 * Build the shared capture runtime: a gate, a mandatory SSRF proxy, and a manager
 * launching the selected engine through it. `shutdown()` tears down both the
 * manager and the proxy listener (always call it in a `finally`).
 */
export async function buildCaptureRuntime(
  opts: BuildCaptureRuntimeOptions,
): Promise<CaptureRuntime> {
  const gate = new BrowserGate({
    allowedHosts: opts.allowedHosts,
    allowUnsafe: opts.allowUnsafe ?? false,
  })
  const proxy = await createSsrfProxy({ allowPrivate: opts.allowPrivate ?? false })
  const manager = new BrowserManager({
    gate,
    harDir: opts.harDir,
    launch: engineLauncher(resolveEngine(opts.engine), {
      headless: opts.headless ?? true,
      proxyServer: proxy.url,
      noSandbox: opts.noSandbox ?? false,
    }),
  })
  return {
    manager,
    gate,
    redact: opts.redact ?? ((s) => s),
    resolveSecret: opts.resolveSecret,
    config: { harDir: opts.harDir },
    shutdown: async () => {
      await manager.shutdown()
      await proxy.close()
    },
  }
}
