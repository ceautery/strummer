import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ArtifactStore,
  auditA11y,
  BrowserGate,
  BrowserManager,
  createSsrfProxy,
  PageDriver,
} from '@strummer/browser'
import { chromium, type Page } from 'playwright-core'
import type { CliIO } from './index.js'

/**
 * Human-facing `strummer browser …` — single-shot page-inspection commands over
 * the `@strummer/browser` engine. Each command navigates once and reads, so the
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
}

/** Flags shared by every browser command. */
const COMMON_OPTIONS = {
  'allow-host': { type: 'string', multiple: true },
  'allow-private': { type: 'boolean' },
  'no-sandbox': { type: 'boolean' },
  headed: { type: 'boolean' },
  json: { type: 'boolean' },
} as const

type CommonValues = {
  'allow-host'?: string[]
  'allow-private'?: boolean
  'no-sandbox'?: boolean
  headed?: boolean
}

function flagsFrom(values: CommonValues): BrowserFlags {
  return {
    allowHost: values['allow-host'] ?? [],
    allowPrivate: values['allow-private'] ?? false,
    noSandbox: values['no-sandbox'] ?? false,
    headed: values.headed ?? false,
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
  const gate = new BrowserGate({ allowedHosts: [host, ...flags.allowHost] })
  const proxy = await createSsrfProxy({ allowPrivate: flags.allowPrivate })
  const store = new ArtifactStore(mkdtempSync(join(tmpdir(), 'strummer-browser-cli-')))
  const manager = new BrowserManager({
    gate,
    launch: () =>
      chromium.launch({
        headless: !flags.headed,
        proxy: { server: proxy.url },
        args: [
          '--proxy-bypass-list=<-loopback>',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
          ...(flags.noSandbox ? ['--no-sandbox'] : []),
        ],
      }),
  })
  try {
    const context = await manager.createSession('cli')
    const page = await context.newPage()
    const driver = new PageDriver(page, { runId: 'cli', store, gate })
    await driver.navigate(url)
    return await fn({ driver, store, page })
  } catch (err) {
    io.err(`${(err as Error).message}\n`)
    return 1
  } finally {
    await manager.shutdown()
    await proxy.close()
  }
}

export async function runBrowser(args: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'snapshot':
      return cmdSnapshot(rest, io)
    case 'audit':
      return cmdAudit(rest, io)
    case 'screenshot':
      return cmdScreenshot(rest, io)
    default:
      io.err(`unknown browser subcommand: ${sub ?? '(none)'}\n`)
      return 1
  }
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
