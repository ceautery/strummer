import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { PillarSetup } from './pillars.js'

/**
 * The aggregate Strummer MCP server (ADR 0019): one stdio process exposing every
 * ENABLED pillar's tools, composed via each bin's `setup<X>FromEnv` seam. Pillars
 * are loaded by DYNAMIC import so a process that didn't enable a heavy pillar never
 * loads its engine (playwright/sqlite/onnx). Selection is subtractive — it chooses
 * which pillars register, never grants a capability (each pillar still reads its OWN
 * gate). The api + verify pillars are composed in `aggregate` mode so they read the
 * prefixed `STRUMMER_API_*` namespace (compose, never widen — §A8).
 */

/** A pillar's env→setup constructor (the `setup<X>FromEnv` a bin exports). May be
 * async (e.g. browser starts an SSRF proxy). Returns `undefined` ⇒ a loud disable. */
export type PillarSetupFn = (
  env: Record<string, string | undefined>,
) => PillarSetup | undefined | Promise<PillarSetup | undefined>

export interface PillarEntry {
  /** In the curated read-heavy default set (enabled when `STRUMMER_TOOLSETS` is unset). */
  default: boolean
  /** The package whose absence makes a dynamic import fail ⇒ a LOUD DISABLE message. */
  pkg: string
  /** Dynamically import the bin module and return its `setup<X>FromEnv`. */
  load: () => Promise<PillarSetupFn>
}

export type PillarRegistry = Record<string, PillarEntry>

/**
 * The real pillar registry. Each `load` dynamically imports the bin module (whose
 * executable tail is import.meta-guarded, so importing it has no side effect) and
 * returns its setup function. api/verify are wrapped to run in `aggregate` mode.
 */
export const DEFAULT_PILLARS: PillarRegistry = {
  // Curated read-heavy default set (the ratified fork). docs needs an index +
  // @strummer/core/@strummer/embed, so without them it loud-disables (effective
  // zero-config default = api+deps+verify).
  docs: {
    default: true,
    pkg: '@strummer/core',
    load: async () => (await import('./docs.js')).setupDocsFromEnv,
  },
  api: {
    default: true,
    pkg: '@strummer/api',
    load: async () => {
      const m = await import('./bin-api.js')
      return (env) => m.setupApiFromEnv(env, { aggregate: true })
    },
  },
  deps: {
    default: true,
    pkg: '@strummer/deps',
    load: async () => (await import('./bin-deps.js')).setupDepsFromEnv,
  },
  verify: {
    default: true,
    pkg: '@strummer/verify',
    load: async () => {
      const m = await import('./bin-verify.js')
      return (env) => m.setupVerifyFromEnv(env, { aggregate: true })
    },
  },
  // Opt-in (heavier / specialized) pillars.
  browser: {
    default: false,
    pkg: '@strummer/browser',
    load: async () => (await import('./bin-browser.js')).setupBrowserFromEnv,
  },
  coverage: {
    default: false,
    pkg: '@strummer/coverage',
    load: async () => (await import('./bin-coverage.js')).setupCoverageFromEnv,
  },
  flake: {
    default: false,
    pkg: '@strummer/flake',
    load: async () => (await import('./bin-flake.js')).setupFlakeFromEnv,
  },
  lsp: {
    default: false,
    pkg: '@strummer/lsp',
    load: async () => (await import('./bin-lsp.js')).setupLspFromEnv,
  },
  mutate: {
    default: false,
    pkg: '@strummer/mutate',
    load: async () => (await import('./bin-mutate.js')).setupMutateFromEnv,
  },
}

/**
 * Resolve the enabled pillar set from `STRUMMER_TOOLSETS` (subtractive selection):
 * unset ⇒ the curated default set; set ⇒ exactly the named pillars. An unknown name
 * is a loud config error (typo protection) — never silently ignored.
 */
export function parseToolsets(raw: string | undefined, registry: PillarRegistry): string[] {
  const known = Object.keys(registry)
  if (!raw?.trim()) return known.filter((n) => registry[n]?.default)
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const unknown = names.filter((n) => !known.includes(n))
  if (unknown.length > 0) {
    throw new Error(
      `unknown STRUMMER_TOOLSETS entr${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')} ` +
        `(known pillars: ${known.join(', ')})`,
    )
  }
  return [...new Set(names)]
}

function isModuleNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
  )
}

function aggregateInstructions(enabled: string[]): string {
  return (
    'Strummer — an agent-first developer testing & verification toolkit (aggregate server).\n\n' +
    `Enabled toolsets: ${enabled.length ? enabled.join(', ') : '(none)'}.\n\n` +
    'Tools are namespaced by pillar — docs (search_docs/get_doc), api (run_request/' +
    'validate_response), browser_*, coverage (uncovered_in_diff/run_scoped), deps ' +
    '(audit_dependency/audit_project), flake_*, lsp_*, mutate_*, verify (request_verdict/' +
    'verify_change). Run/write tools appear only when the operator set that pillar’s gate.'
  )
}

export interface AggregateResult {
  server: McpServer
  /** Tear down every enabled pillar’s owned resources (proxies, managers, db handles). */
  shutdown: () => Promise<void>
  enabled: string[]
  disabled: { pillar: string; reason: string }[]
}

/**
 * Compose the aggregate server. For each enabled pillar: dynamically import its
 * setup (a missing engine package ⇒ ERR_MODULE_NOT_FOUND ⇒ LOUD DISABLE, the server
 * still starts), then call it (a CONTRADICTORY operator gate throws ⇒ FATAL, never
 * swallowed — those throws are anti-widening guards). A pillar that returns
 * `undefined` (e.g. docs with no index) is a loud disable. Every owned `shutdown` is
 * collected for one SIGINT/SIGTERM teardown.
 */
export async function buildAggregateServer(
  env: Record<string, string | undefined> = process.env,
  opts: { registry?: PillarRegistry; log?: (msg: string) => void } = {},
): Promise<AggregateResult> {
  const registry = opts.registry ?? DEFAULT_PILLARS
  const log = opts.log ?? ((m) => process.stderr.write(`${m}\n`))
  const requested = parseToolsets(env.STRUMMER_TOOLSETS, registry)

  const enabled: string[] = []
  const disabled: { pillar: string; reason: string }[] = []
  const ready: { name: string; setup: PillarSetup }[] = []

  for (const name of requested) {
    const entry = registry[name]
    if (!entry) continue // parseToolsets already validated membership; defensive
    let setupFn: PillarSetupFn
    try {
      setupFn = await entry.load()
    } catch (e) {
      if (isModuleNotFound(e)) {
        const reason = `engine not installed (${entry.pkg})`
        log(`strummer: pillar "${name}" disabled — ${reason}`)
        disabled.push({ pillar: name, reason })
        continue
      }
      throw e // any other import error is fatal
    }
    // A contradictory operator gate (e.g. lsp ALLOW_WRITE without ALLOW_RUN) throws
    // here — that is FATAL by design (an anti-widening guard, never swallowed).
    const setup = await setupFn(env)
    if (!setup) {
      const reason = name === 'docs' ? 'no STRUMMER_INDEX configured' : 'not configured'
      log(`strummer: pillar "${name}" disabled — ${reason}`)
      disabled.push({ pillar: name, reason })
      continue
    }
    ready.push({ name, setup })
    enabled.push(name)
  }

  const server = new McpServer(
    { name: 'strummer', version: '0.0.0' },
    { instructions: aggregateInstructions(enabled) },
  )
  const shutdowns: (() => Promise<void> | void)[] = []
  for (const { setup } of ready) {
    setup.register(server)
    if (setup.shutdown) shutdowns.push(setup.shutdown)
  }

  const shutdown = async () => {
    for (const s of shutdowns) {
      try {
        await s()
      } catch (e) {
        log(`strummer: shutdown error — ${String(e)}`)
      }
    }
  }

  return { server, shutdown, enabled, disabled }
}
