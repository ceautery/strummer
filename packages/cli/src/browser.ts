import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ArtifactStore,
  auditA11y,
  type BrowserEngine,
  browserSecretsFromEnv,
  buildCaptureRuntime,
  type FlowResult,
  loadFlow,
  PageDriver,
  resolveEngine,
  runFlow,
} from '@sackville-mcp/browser'
import type { Page } from 'playwright-core'
import type { CliIO } from './index.js'

/**
 * Human-facing `sackville browser …` — single-shot page-inspection commands over
 * the `@sackville-mcp/browser` engine. Each command navigates once and reads, so the
 * per-snapshot refs never need to outlive the process (unlike the stateful MCP
 * surface). The egress boundary mirrors the server bin: navigation is gated by an
 * allowlist (the typed host is auto-allowed, since the human explicitly asked for
 * it) and a **mandatory** DNS-pinning SSRF proxy fronts every request. The human
 * is the operator here, so the safety flags are theirs to set.
 */

interface BrowserFlags {
  allowHost: string[]
  allowPrivate: boolean
  noSandbox: boolean
  headed: boolean
  engine: BrowserEngine
}

/** Flags shared by every browser command. */
const COMMON_OPTIONS = {
  'allow-host': { type: 'string', multiple: true },
  'allow-private': { type: 'boolean' },
  'no-sandbox': { type: 'boolean' },
  headed: { type: 'boolean' },
  engine: { type: 'string' },
  json: { type: 'boolean' },
} as const

type CommonValues = {
  'allow-host'?: string[]
  'allow-private'?: boolean
  'no-sandbox'?: boolean
  headed?: boolean
  engine?: string
}

function flagsFrom(values: CommonValues): BrowserFlags {
  return {
    allowHost: values['allow-host'] ?? [],
    allowPrivate: values['allow-private'] ?? false,
    noSandbox: values['no-sandbox'] ?? false,
    headed: values.headed ?? false,
    engine: resolveEngine(values.engine),
  }
}

interface SessionContext {
  driver: PageDriver
  store: ArtifactStore
  page: Page
}

/**
 * Stand up a gated, proxy-fronted browser, navigate to `url`, run `fn`, and tear
 * everything down. Returns `undefined` for a bad URL (after reporting it).
 */
async function withSession(
  url: string,
  flags: BrowserFlags,
  io: CliIO,
  fn: (ctx: SessionContext) => Promise<number>,
): Promise<number> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    io.err(`invalid url: ${url}\n`)
    return 1
  }
  // The human typed this URL → auto-allow its host, plus any extra --allow-host.
  const runtime = await buildCaptureRuntime({
    allowedHosts: [host, ...flags.allowHost],
    allowPrivate: flags.allowPrivate,
    engine: flags.engine,
    headless: !flags.headed,
    noSandbox: flags.noSandbox,
  })
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'sackville-browser-cli-')))
  try {
    const context = await runtime.manager.createSession('cli')
    const page = await context.newPage()
    const driver = new PageDriver(page, { runId: 'cli', store, gate: runtime.gate })
    await driver.navigate(url)
    return await fn({ driver, store, page })
  } catch (err) {
    io.err(`${(err as Error).message}\n`)
    return 1
  } finally {
    await runtime.shutdown()
  }
}

export async function runBrowser(args: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = args
  try {
    switch (sub) {
      case 'snapshot':
        return await cmdSnapshot(rest, io)
      case 'audit':
        return await cmdAudit(rest, io)
      case 'screenshot':
        return await cmdScreenshot(rest, io)
      case 'run':
        return await cmdRun(rest, io)
      default:
        io.err(`unknown browser subcommand: ${sub ?? '(none)'}\n`)
        return 1
    }
  } catch (err) {
    // Early flag-validation errors (e.g. an unknown --engine) surface as a clean
    // message + exit 1 rather than an uncaught rejection.
    io.err(`${(err as Error).message}\n`)
    return 1
  }
}

/** Parse repeatable `--var k=v` flags (split on the FIRST `=`) into a record. */
function parseVars(raw: string[] | undefined): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const item of raw ?? []) {
    const eq = item.indexOf('=')
    if (eq === -1) vars[item] = ''
    else vars[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return vars
}

/**
 * Replay a persisted browser flow (`<flow>.bru` + sidecar) — `sackville browser
 * run <flow.bru>`. Unlike the single-shot commands the flow drives its own
 * navigations, so no URL is auto-allowed: the human allowlists target hosts with
 * `--allow-host` and unlocks mutations with `--unsafe` (else they dry-run).
 * `{{secret:NAME}}` resolves from `SACKVILLE_BROWSER_SECRET_<NAME>` env (the human
 * is the operator); a `Redactor` scrubs those values from every result. Exits
 * non-zero when the flow fails (a step error or a failed assertion) — CI-usable.
 */
async function cmdRun(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...COMMON_OPTIONS,
      unsafe: { type: 'boolean' },
      var: { type: 'string', multiple: true },
    },
  })
  const flowPath = positionals[0]
  if (!flowPath) {
    io.err('browser run needs <flow.bru>\n')
    return 1
  }

  let flow: ReturnType<typeof loadFlow>
  try {
    flow = loadFlow(flowPath)
  } catch (err) {
    io.err(`${(err as Error).message}\n`)
    return 1
  }

  // Operator secrets from env (SACKVILLE_BROWSER_SECRET_<NAME>); registered with a
  // redactor so they never surface, exposed only by NAME. Shared with the verify
  // CLI + the browser MCP server (one source of truth, `@sackville-mcp/browser`).
  const { redact, resolveSecret } = browserSecretsFromEnv(io.env ?? {})
  const flags = flagsFrom(values)
  const runtime = await buildCaptureRuntime({
    allowedHosts: flags.allowHost,
    allowUnsafe: values.unsafe ?? false,
    allowPrivate: flags.allowPrivate,
    engine: flags.engine,
    headless: !flags.headed,
    noSandbox: flags.noSandbox,
    redact,
    resolveSecret,
  })
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'sackville-browser-flow-')))
  try {
    const context = await runtime.manager.createSession('cli')
    const page = await context.newPage()
    const driver = new PageDriver(page, {
      runId: 'cli',
      store,
      gate: runtime.gate,
      redact: runtime.redact,
    })
    const result = await runFlow(driver, flow, {
      vars: parseVars(values.var),
      resolveSecret: runtime.resolveSecret,
    })
    if (values.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      printFlowResult(result, io)
    }
    return result.passed ? 0 : 1
  } catch (err) {
    io.err(`${(err as Error).message}\n`)
    return 1
  } finally {
    await runtime.shutdown()
  }
}

function printFlowResult(result: FlowResult, io: CliIO): void {
  io.out(`flow: ${result.name}\n`)
  for (const step of result.steps) {
    if (step.error) {
      io.out(`  FAIL ${step.action} — ${step.error}\n`)
    } else if (step.assertions) {
      const passed = step.assertions.filter((a) => a.pass).length
      const total = step.assertions.length
      io.out(`  ${passed === total ? 'ok  ' : 'FAIL'} assert (${passed}/${total} passed)\n`)
    } else {
      io.out(`  ok   ${step.action}${step.dryRun ? ' (dry-run)' : ''}\n`)
    }
  }
  io.out(`${result.passed ? 'PASS' : 'FAIL'}\n`)
}

async function cmdSnapshot(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: COMMON_OPTIONS,
  })
  const url = positionals[0]
  if (!url) {
    io.err('browser snapshot needs <url>\n')
    return 1
  }
  return withSession(url, flagsFrom(values), io, async ({ driver }) => {
    const snap = await driver.snapshot()
    if (values.json) {
      io.out(`${JSON.stringify(snap, null, 2)}\n`)
      return 0
    }
    io.out(`${snap.snapshot}\n`)
    if (snap.truncated) io.err('(snapshot truncated — re-run with --json for the full handle)\n')
    return 0
  })
}

async function cmdAudit(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: COMMON_OPTIONS,
  })
  const url = positionals[0]
  if (!url) {
    io.err('browser audit needs <url>\n')
    return 1
  }
  return withSession(url, flagsFrom(values), io, async ({ store, page }) => {
    const res = await auditA11y(page, { runId: 'cli', store })
    if (values.json) {
      io.out(`${JSON.stringify(res, null, 2)}\n`)
      return res.summary.violationCount === 0 ? 0 : 1
    }
    const s = res.summary
    io.out(`violations: ${s.violationCount}\n`)
    for (const v of s.top) {
      io.out(`  [${v.impact ?? '-'}] ${v.id}: ${v.nodeCount} node(s) — ${v.help}\n`)
    }
    const path = store.get(res.resultsHandle)?.path
    if (path) io.out(`full report: ${path}\n`)
    // exit non-zero when violations exist, so the command is usable as a CI gate
    return s.violationCount === 0 ? 0 : 1
  })
}

async function cmdScreenshot(args: string[], io: CliIO): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { ...COMMON_OPTIONS, out: { type: 'string' }, 'full-page': { type: 'boolean' } },
  })
  const url = positionals[0]
  if (!url) {
    io.err('browser screenshot needs <url>\n')
    return 1
  }
  const out = values.out ?? 'screenshot.png'
  return withSession(url, flagsFrom(values), io, async ({ driver, store }) => {
    const shot = await driver.screenshot({ fullPage: values['full-page'] ?? false })
    const bytes = shot.handle ? store.get(shot.handle)?.body : undefined
    if (!bytes) {
      io.err('screenshot capture failed\n')
      return 1
    }
    writeFileSync(out, bytes)
    if (values.json) {
      io.out(`${JSON.stringify({ ...shot, savedTo: out }, null, 2)}\n`)
      return 0
    }
    io.out(`saved ${shot.byteSize} bytes to ${out}\n`)
    return 0
  })
}
