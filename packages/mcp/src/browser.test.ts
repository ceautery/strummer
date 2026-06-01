import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ArtifactStore, BrowserGate, BrowserManager, harPathFor } from '@strummer/browser'
import { Redactor } from '@strummer/safety'
import { type Browser, chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createBrowserServer } from './browser.js'

vi.setConfig({ testTimeout: 30_000 })

// One stable page: a heading, a labelled text input prefilled with a secret, and
// a Submit button whose click POSTs to a same-origin URL carrying the secret.
const FIXTURE = `<!doctype html><html lang="en"><head><title>MCP</title></head><body>
  <h1>Browser MCP</h1>
  <label>Name <input id="name" type="text" value="hunter2-secret"></label>
  <input id="pw" type="text" aria-label="Secret">
  <button id="go">Submit</button>
  <button id="login">Login</button>
  <button id="del">Delete</button>
  <a id="dl" href="/download.bin" download="report.txt">Get file</a>
  <input type="file" aria-label="Attach">
  <script>
    document.cookie = 'sid=secret-cookie'
    localStorage.setItem('token', 'secret-cookie')
    document.getElementById('go').addEventListener('click', () =>
      fetch('/submit?token=hunter2-secret', { method: 'POST', body: 'x=1' }).catch(() => {}))
    document.getElementById('login').addEventListener('click', () =>
      fetch('/login', { method: 'POST', body: 'pw=' + document.getElementById('pw').value }).catch(() => {}))
    document.getElementById('del').addEventListener('click', () => confirm('Remove hunter2-secret?'))
  </script>
</body></html>`

/** Find a ref in a snapshot StepResult by role + accessible name. */
function refByName(snapshot: string, role: string, name: string): string {
  const re = new RegExp(`${role} "${name}"[^\\n]*\\[ref=([^\\]]+)\\]`)
  const m = re.exec(snapshot)
  if (!m) throw new Error(`no ${role} "${name}" ref in snapshot:\n${snapshot}`)
  return m[1] as string
}

interface StepSC {
  snapshot: string
  diff: string
  dryRun?: boolean
  wouldRequest?: { method: string; url: string; postData?: string } | null
  crossOriginEgress?: boolean
}

describe('strummer browser MCP surface (real headless chromium)', () => {
  let server: Server
  let baseUrl: string
  let browser: Browser
  let baseDir: string

  /** Build an isolated server+client over a manager with the given gate/clock. */
  async function connect(config: {
    allowUnsafe?: boolean
    allowedHosts?: string[]
    idleTtlMs?: number
    maxContexts?: number
    now?: () => number
    allowStorageState?: boolean
    allowScreenshots?: boolean
    allowDialogs?: boolean
    downloadDir?: string
    uploadDir?: string
    harDir?: string
    replayDir?: string
    flowsDir?: string
    videoDir?: string
    capture?: { trace?: boolean; console?: boolean; network?: boolean }
    runPerfAudit?: Parameters<typeof createBrowserServer>[0]['runPerfAudit']
  }) {
    const gate = new BrowserGate({
      allowUnsafe: config.allowUnsafe,
      allowedHosts: config.allowedHosts ?? ['127.0.0.1'],
      allowDialogs: config.allowDialogs,
    })
    const store = new ArtifactStore(mkdtempSync(join(baseDir, 'store-')))
    const secrets = new Map([['pw', 'hunter2-secret']])
    const redactor = new Redactor()
    for (const [name, value] of secrets) redactor.register(name, value)
    const manager = new BrowserManager({
      launch: async () => browser,
      gate,
      idleTtlMs: config.idleTtlMs ?? 5 * 60_000,
      maxContexts: config.maxContexts ?? 8,
      now: config.now,
      acceptDownloads: config.downloadDir !== undefined,
      harDir: config.harDir,
      videoDir: config.videoDir,
    })
    const srv = createBrowserServer({
      manager,
      gate,
      artifacts: store,
      redact: (v) => redactor.redact(v),
      resolveSecret: (name) => secrets.get(name),
      allowStorageState: config.allowStorageState,
      allowScreenshots: config.allowScreenshots,
      downloadDir: config.downloadDir,
      uploadDir: config.uploadDir,
      harDir: config.harDir,
      replayDir: config.replayDir,
      flowsDir: config.flowsDir,
      videoDir: config.videoDir,
      capture: config.capture,
      runPerfAudit: config.runPerfAudit,
    })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([srv.connect(st), client.connect(ct)])
    return { client, manager, store }
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    return client.callTool({ name, arguments: args })
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith('/submit')) {
        res.writeHead(200)
        res.end('ok')
        return
      }
      if (req.url?.startsWith('/download.bin')) {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.txt"',
        })
        res.end('downloaded-bytes')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(FIXTURE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    baseDir = mkdtempSync(join(tmpdir(), 'strummer-bmcp-'))
  }, 60_000)

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((r) => server.close(() => r()))
    if (baseDir) rmSync(baseDir, { recursive: true, force: true })
  })

  it('exposes the browser tool set', async () => {
    const { client } = await connect({})
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const t of [
      'browser_open_session',
      'browser_list_sessions',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_fill',
      'browser_fill_form',
      'browser_select',
      'browser_press',
      'browser_upload',
      'browser_wait_for',
      'browser_get_text',
      'browser_get_value',
      'browser_get_attribute',
      'browser_assert',
      'browser_perf_audit',
      'browser_replay_har',
      'browser_trace_query',
      'browser_audit_a11y',
      'browser_screenshot',
      'browser_downloads',
      'browser_save_storage_state',
      'browser_list_flows',
      'browser_run_flow',
      'browser_close_session',
    ]) {
      expect(names).toContain(t)
    }
    await client.close()
  })

  it('open → navigate → close: server-minted ids, snapshot refs, artifact handles', async () => {
    const { client } = await connect({})
    const open = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
      sessionCount: number
      capturing: { console: boolean; network: boolean; trace: boolean }
    }
    expect(open.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(open.runId).toMatch(/[0-9a-f-]{36}/)
    expect(open.sessionCount).toBe(1)
    expect(open.capturing).toEqual({ trace: false, console: true, network: true })

    const nav = (
      await call(client, 'browser_navigate', { sessionId: open.sessionId, url: baseUrl })
    ).structuredContent as StepSC
    expect(nav.snapshot).toContain('[ref=')
    expect(nav.snapshot).toContain('button "Submit"')

    const close = (await call(client, 'browser_close_session', { sessionId: open.sessionId }))
      .structuredContent as {
      closed: boolean
      runId: string
      artifacts?: { console?: { handle: string }; network?: { handle: string } }
    }
    expect(close.closed).toBe(true)
    expect(close.runId).toBe(open.runId)
    expect(close.artifacts?.console?.handle).toBe(`strummer://browser/run/${open.runId}/console`)
    expect(close.artifacts?.network?.handle).toBe(`strummer://browser/run/${open.runId}/network`)
    await client.close()
  })

  it('reads do not invalidate refs; a re-snapshot supersedes them (stale-ref error)', async () => {
    const { client } = await connect({})
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const nameRef = refByName(nav.snapshot, 'textbox', 'Name')

    // a free read keeps the ref valid + is redacted (prefilled value is a secret)
    const val = (await call(client, 'browser_get_value', { sessionId, ref: nameRef }))
      .structuredContent as { value: string }
    expect(val.value).toBe('[redacted:pw]')
    expect(val.value).not.toContain('hunter2-secret')

    // re-snapshot bumps the generation → the old ref is now stale
    await call(client, 'browser_snapshot', { sessionId })
    const stale = await call(client, 'browser_get_text', { sessionId, ref: nameRef })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toMatch(/unknown ref/i)
    await client.close()
  })

  it('acting before a snapshot returns the no-snapshot error', async () => {
    const { client } = await connect({})
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const res = await call(client, 'browser_click', { sessionId, ref: 'e1' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/no snapshot yet/i)
    await client.close()
  })

  it('gate is operator-only: dry-runs mutations + redacts the preview; denies off-allowlist nav', async () => {
    const { client } = await connect({ allowUnsafe: false, allowedHosts: ['127.0.0.1'] })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const goRef = refByName(nav.snapshot, 'button', 'Submit')

    const click = (await call(client, 'browser_click', { sessionId, ref: goRef }))
      .structuredContent as StepSC
    expect(click.dryRun).toBe(true)
    expect(click.wouldRequest?.method).toBe('POST')
    expect(click.wouldRequest?.url).toContain('[redacted:pw]')
    expect(click.wouldRequest?.url).not.toContain('hunter2-secret')
    expect(click.crossOriginEgress).toBe(false)

    // navigation to a non-allowlisted host is denied (no tool input can override)
    const denied = await call(client, 'browser_navigate', {
      sessionId,
      url: 'https://evil.test/',
    })
    expect(denied.isError).toBe(true)
    await client.close()
  })

  it('resolves a {{secret:NAME}} fill server-side and redacts it everywhere; never echoes it', async () => {
    const { client } = await connect({ allowUnsafe: false, allowedHosts: ['127.0.0.1'] })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const secretRef = refByName(nav.snapshot, 'textbox', 'Secret')

    // fill with the placeholder — the real secret is typed into the input, never returned
    const fill = await call(client, 'browser_fill', {
      sessionId,
      ref: secretRef,
      value: '{{secret:pw}}',
    })
    expect(fill.isError).toBeFalsy()
    expect(JSON.stringify(fill)).not.toContain('hunter2-secret')

    // the fill re-snapshots (new generation) — take the Login ref from that fresh snapshot.
    // Submitting posts the input value → the dry-run preview shows it redacted (proves the
    // real secret was typed in), and the secret never appears anywhere unredacted.
    const loginRef = refByName((fill.structuredContent as StepSC).snapshot, 'button', 'Login')
    const click = (await call(client, 'browser_click', { sessionId, ref: loginRef }))
      .structuredContent as StepSC
    expect(click.dryRun).toBe(true)
    expect(click.wouldRequest?.postData).toBe('pw=[redacted:pw]')
    expect(click.wouldRequest?.postData).not.toContain('hunter2-secret')
    await client.close()
  })

  it('fails closed on an unknown {{secret:NAME}}', async () => {
    const { client } = await connect({})
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const secretRef = refByName(nav.snapshot, 'textbox', 'Secret')
    const res = await call(client, 'browser_fill', {
      sessionId,
      ref: secretRef,
      value: '{{secret:nope}}',
    })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/unknown secret/i)
    await client.close()
  })

  it('saves storageState by handle (operator-gated), never inlining values; resource refuses it', async () => {
    const { client } = await connect({ allowStorageState: true })
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })

    const save = await call(client, 'browser_save_storage_state', { sessionId })
    const sc = save.structuredContent as { handle: string; cookies: number; origins: number }
    expect(sc.handle).toBe(`strummer://browser/run/${runId}/storage-state`)
    expect(sc.cookies).toBeGreaterThanOrEqual(1)
    expect(sc.origins).toBeGreaterThanOrEqual(1)
    // the result carries only counts + a handle — never the cookie/localStorage values
    expect(JSON.stringify(save)).not.toContain('secret-cookie')

    // password-equivalent: the resource refuses to serve it to the agent (operator-path)
    await expect(client.readResource({ uri: sc.handle })).rejects.toThrow(/operator-path/i)
    await client.close()
  })

  it('refuses storageState capture when the operator has not enabled it', async () => {
    const { client } = await connect({}) // allowStorageState defaults off
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const res = await call(client, 'browser_save_storage_state', { sessionId })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/not enabled/i)
    await client.close()
  })

  it('captures a screenshot by handle (operator-gated), served as a PNG blob', async () => {
    const { client } = await connect({ allowScreenshots: true })
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })

    const shot = await call(client, 'browser_screenshot', { sessionId })
    const sc = shot.structuredContent as {
      handle: string
      byteSize: number
      contentType: string
      fullPage: boolean
    }
    expect(sc.handle).toBe(`strummer://browser/run/${runId}/screenshot-s1`)
    expect(sc.contentType).toBe('image/png')
    expect(sc.byteSize).toBeGreaterThan(0)

    // served back as a base64 PNG blob (binary), not inlined text
    const res = await client.readResource({ uri: sc.handle })
    const content = res.contents[0] as { mimeType: string; blob?: string; text?: string }
    expect(content.mimeType).toBe('image/png')
    expect(content.text).toBeUndefined()
    expect(Buffer.from(content.blob as string, 'base64').subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    await client.close()
  })

  it('refuses a screenshot when the operator has not enabled it', async () => {
    const { client } = await connect({}) // allowScreenshots defaults off
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })
    const res = await call(client, 'browser_screenshot', { sessionId })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/not enabled/i)
    await client.close()
  })

  it('dismisses a JS dialog by default; accepts + records it (redacted) when unlocked', async () => {
    type StepWithDialogs = StepSC & {
      dialogs?: { type: string; message: string; accepted: boolean }[]
    }
    // default: dialogs dismissed (allowUnsafe so the click executes, allowDialogs off)
    const dismissCx = await connect({ allowUnsafe: true })
    const dis = (await call(dismissCx.client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const disNav = (
      await call(dismissCx.client, 'browser_navigate', {
        sessionId: dis.sessionId,
        url: baseUrl,
      })
    ).structuredContent as StepSC
    const disClick = (
      await call(dismissCx.client, 'browser_click', {
        sessionId: dis.sessionId,
        ref: refByName(disNav.snapshot, 'button', 'Delete'),
      })
    ).structuredContent as StepWithDialogs
    expect(disClick.dialogs?.[0]?.accepted).toBe(false)
    expect(disClick.dialogs?.[0]?.type).toBe('confirm')
    await dismissCx.client.close()

    // operator unlock: dialogs accepted, message redacted (carries a secret)
    const { client } = await connect({ allowUnsafe: true, allowDialogs: true })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const res = (
      await call(client, 'browser_click', {
        sessionId,
        ref: refByName(nav.snapshot, 'button', 'Delete'),
      })
    ).structuredContent as StepWithDialogs
    expect(res.dialogs?.[0]?.accepted).toBe(true)
    expect(res.dialogs?.[0]?.message).toBe('Remove [redacted:pw]?')
    expect(JSON.stringify(res)).not.toContain('hunter2-secret')
    await client.close()
  })

  it('saves a download to the operator quarantine dir, surfaced by browser_downloads (no bytes)', async () => {
    const dlDir = mkdtempSync(join(baseDir, 'dl-'))
    const { client } = await connect({ allowUnsafe: true, downloadDir: dlDir })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    await call(client, 'browser_click', {
      sessionId,
      ref: refByName(nav.snapshot, 'link', 'Get file'),
    })
    const dl = (await call(client, 'browser_downloads', { sessionId, waitMs: 3000 }))
      .structuredContent as {
      downloads: {
        suggestedFilename: string
        savedAs?: string
        byteSize?: number
        accepted: boolean
      }[]
    }
    expect(dl.downloads).toHaveLength(1)
    expect(dl.downloads[0]?.accepted).toBe(true)
    expect(dl.downloads[0]?.suggestedFilename).toBe('report.txt')
    expect(dl.downloads[0]?.savedAs?.startsWith(dlDir)).toBe(true)
    expect(existsSync(dl.downloads[0]?.savedAs as string)).toBe(true)
    // metadata only — the downloaded bytes are never returned to the agent
    expect(JSON.stringify(dl)).not.toContain('downloaded-bytes')
    await client.close()
  })

  it('uploads only from the operator allowlist dir; denies traversal and when unset', async () => {
    const upDir = mkdtempSync(join(baseDir, 'up-'))
    writeFileSync(join(upDir, 'ok.txt'), 'hello')
    const { client } = await connect({ uploadDir: upDir })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    const attachRef = refByName(nav.snapshot, 'button', 'Attach')

    const ok = await call(client, 'browser_upload', {
      sessionId,
      ref: attachRef,
      files: ['ok.txt'],
    })
    expect((ok.structuredContent as StepSC).snapshot).toContain('[ref=')
    expect(ok.isError).toBeFalsy()

    // a traversal path outside the allowlist is denied
    const outside = await call(client, 'browser_upload', {
      sessionId,
      ref: refByName((ok.structuredContent as StepSC).snapshot, 'button', 'Attach'),
      files: ['../../../etc/passwd'],
    })
    expect(outside.isError).toBe(true)
    expect(JSON.stringify(outside.content)).toMatch(/allowlist/i)

    // with no operator upload dir, uploads are denied entirely
    const noDir = await connect({})
    const nd = (await call(noDir.client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const ndNav = (
      await call(noDir.client, 'browser_navigate', { sessionId: nd.sessionId, url: baseUrl })
    ).structuredContent as StepSC
    const denied = await call(noDir.client, 'browser_upload', {
      sessionId: nd.sessionId,
      ref: refByName(ndNav.snapshot, 'button', 'Attach'),
      files: ['x'],
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/not enabled/i)
    await noDir.client.close()
    await client.close()
  })

  it('browser_assert evaluates page conditions; pass reflects the true value, actual is redacted', async () => {
    const { client } = await connect({})
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })
    const res = (
      await call(client, 'browser_assert', {
        sessionId,
        assertions: [
          { source: 'title', op: 'equals', value: 'MCP' },
          {
            source: 'text',
            role: 'heading',
            name: 'Browser MCP',
            op: 'contains',
            value: 'Browser',
          },
          // the input is prefilled with a secret; assert it EXISTS without naming
          // it — proving the server-read value is redacted in `actual`
          { source: 'value', role: 'textbox', name: 'Name', op: 'exists' },
          { source: 'count', role: 'button', op: 'gte', value: 3 },
        ],
      })
    ).structuredContent as {
      pass: boolean
      results: { source: string; actual: unknown; pass: boolean }[]
    }
    expect(res.pass).toBe(true)
    // the assertion passes on the TRUE (raw) value, but the reported actual is redacted
    const valResult = res.results.find((r) => r.source === 'value')
    expect(valResult?.pass).toBe(true)
    expect(valResult?.actual).toBe('[redacted:pw]')
    expect(JSON.stringify(res)).not.toContain('hunter2-secret')
    await client.close()
  })

  it('browser_trace_query parses a captured trace into an action timeline (after close)', async () => {
    const { client } = await connect({ capture: { trace: true } })
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    await call(client, 'browser_get_text', {
      sessionId,
      ref: refByName(nav.snapshot, 'heading', 'Browser MCP'),
    })
    await call(client, 'browser_close_session', { sessionId }) // flushes the trace to the store

    // querying needs no live session — it reads the stored (redacted) trace by runId
    const res = (await call(client, 'browser_trace_query', { runId, apiFilter: 'goto' }))
      .structuredContent as {
      browserName?: string
      actions: { api: string; durationMs?: number }[]
      summary: { actionCount: number }
    }
    expect(res.browserName).toBe('chromium')
    expect(res.actions.length).toBeGreaterThan(0)
    expect(res.actions.every((a) => /goto/i.test(a.api))).toBe(true)

    // a run without a trace gives an actionable error
    const noTrace = await call(client, 'browser_trace_query', { runId: 'no-such-run' })
    expect(noTrace.isError).toBe(true)
    expect(JSON.stringify(noTrace.content)).toMatch(/no trace/i)
    await client.close()
  })

  it('browser_perf_audit: allowlist-gated, mints a runId, returns the summary + handles', async () => {
    const calls: { url: string; runId: string }[] = []
    const fakePerf = async (url: string, runId: string) => {
      calls.push({ url, runId })
      return {
        summary: {
          performanceScore: 0.92,
          metrics: [{ id: 'first-contentful-paint', score: 1, numericValue: 600 }],
          lighthouseVersion: '13.3.0',
        },
        reportHandle: `strummer://browser/run/${runId}/perf`,
        htmlHandle: `strummer://browser/run/${runId}/perf-html`,
      }
    }
    const { client } = await connect({ allowedHosts: ['app.test'], runPerfAudit: fakePerf })

    const res = (await call(client, 'browser_perf_audit', { url: 'https://app.test/' }))
      .structuredContent as {
      runId: string
      summary: { performanceScore: number; lighthouseVersion: string }
      reportHandle: string
    }
    expect(res.summary.performanceScore).toBe(0.92)
    expect(res.summary.lighthouseVersion).toBe('13.3.0')
    expect(res.runId).toMatch(/[0-9a-f-]{36}/)
    expect(res.reportHandle).toBe(`strummer://browser/run/${res.runId}/perf`)
    expect(calls).toHaveLength(1) // the audit ran exactly once, with the minted runId
    expect(calls[0]?.runId).toBe(res.runId)

    // a non-allowlisted host is refused before any audit runs
    const denied = await call(client, 'browser_perf_audit', { url: 'https://evil.test/' })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/denied|allowlist/i)
    expect(calls).toHaveLength(1) // not invoked for the denied host
    await client.close()
  })

  it('browser_perf_audit reports when perf is not operator-enabled', async () => {
    const { client } = await connect({}) // no runPerfAudit wired
    const res = await call(client, 'browser_perf_audit', { url: 'http://127.0.0.1/' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/not enabled/i)
    await client.close()
  })

  it('captures a HAR by handle on close (operator-gated), redacted + served as a zip blob', async () => {
    const harDir = mkdtempSync(join(baseDir, 'har-'))
    const { client } = await connect({ harDir })
    const open = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    // the document body itself carries a secret (value="hunter2-secret") → it lands
    // in the HAR (content:'attach') and must be redacted before the archive is served
    await call(client, 'browser_navigate', { sessionId: open.sessionId, url: baseUrl })

    const close = (await call(client, 'browser_close_session', { sessionId: open.sessionId }))
      .structuredContent as {
      artifacts?: {
        har?: { handle: string; entryCount: number; byStatus: Record<string, number> }
      }
    }
    const har = close.artifacts?.har
    expect(har?.handle).toBe(`strummer://browser/run/${open.runId}/har`)
    expect(har?.entryCount).toBeGreaterThanOrEqual(1)

    // served back as a base64 zip blob (binary), not inlined text
    const res = await client.readResource({ uri: har?.handle as string })
    const content = res.contents[0] as { mimeType: string; blob?: string; text?: string }
    expect(content.mimeType).toBe('application/zip')
    expect(content.text).toBeUndefined()
    const zip = Buffer.from(content.blob as string, 'base64')
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK') // zip magic
    // the operator redactor is wired through finalizeHar; the deep
    // redact-every-text-entry proof lives in the engine's har.test.ts.
    await client.close()
  })

  it('captures a video by handle on close (operator-gated), served as a webm blob', async () => {
    const videoDir = mkdtempSync(join(baseDir, 'video-'))
    const { client } = await connect({ videoDir })
    const open = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    await call(client, 'browser_navigate', { sessionId: open.sessionId, url: baseUrl })

    const close = (await call(client, 'browser_close_session', { sessionId: open.sessionId }))
      .structuredContent as {
      artifacts?: { video?: { handle: string; byteSize: number; contentType: string } }
    }
    const video = close.artifacts?.video
    expect(video?.handle).toBe(`strummer://browser/run/${open.runId}/video`)
    expect(video?.contentType).toBe('video/webm')
    expect(video?.byteSize).toBeGreaterThan(0)

    // served back as a base64 webm blob (binary), never inlined as text
    const res = await client.readResource({ uri: video?.handle as string })
    const content = res.contents[0] as { mimeType: string; blob?: string; text?: string }
    expect(content.mimeType).toBe('video/webm')
    expect(content.text).toBeUndefined()
    const webm = Buffer.from(content.blob as string, 'base64')
    // EBML magic (0x1A45DFA3) — a real Matroska/WebM container
    expect(webm.subarray(0, 4).toString('hex')).toBe('1a45dfa3')
    await client.close()
  })

  it('captures no video when the operator has not set a videoDir', async () => {
    const { client } = await connect({})
    const open = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    await call(client, 'browser_navigate', { sessionId: open.sessionId, url: baseUrl })
    const close = (await call(client, 'browser_close_session', { sessionId: open.sessionId }))
      .structuredContent as { artifacts?: { video?: unknown } }
    expect(close.artifacts?.video).toBeUndefined()
    await client.close()
  })

  it('captures no HAR when the operator has not set a harDir', async () => {
    const { client } = await connect({})
    const open = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    await call(client, 'browser_navigate', { sessionId: open.sessionId, url: baseUrl })
    const close = (await call(client, 'browser_close_session', { sessionId: open.sessionId }))
      .structuredContent as { artifacts?: { har?: unknown } }
    expect(close.artifacts?.har).toBeUndefined()
    await client.close()
  })

  it('finalizes a reaped session’s HAR (no unredacted archive left behind)', async () => {
    const harDir = mkdtempSync(join(baseDir, 'har-reap-'))
    let nowMs = 1_000
    const { client, manager, store } = await connect({
      harDir,
      idleTtlMs: 5_000,
      now: () => nowMs,
    })
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })

    nowMs += 6_000
    const reaped = await manager.sweepIdle()
    expect(reaped).toContain(sessionId)
    // onClosed finalized the HAR on the reaper path → it resolves on disk, redacted,
    // and the raw staged file is gone
    const stored = store.get(`strummer://browser/run/${runId}/har`)
    expect(stored).toBeDefined()
    expect(existsSync(harPathFor(harDir, sessionId))).toBe(false)
    await client.close()
  })

  it('replays from a recorded HAR (operator-gated); denies traversal + when unset', async () => {
    // record a HAR into an operator replay dir (raw context — this is the seed run)
    const replayDir = mkdtempSync(join(baseDir, 'replay-'))
    const recCtx = await browser.newContext({
      recordHar: { path: harPathFor(replayDir, 'rec'), content: 'attach', mode: 'full' },
    })
    const recPage = await recCtx.newPage()
    await recPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await recCtx.close()

    const { client } = await connect({ replayDir })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const res = (await call(client, 'browser_replay_har', { sessionId, har: 'rec.zip' }))
      .structuredContent as { action: string; har: string; notFound: string }
    expect(res.action).toBe('replay_har')
    expect(res.har).toBe('rec.zip')
    expect(res.notFound).toBe('abort')

    // navigating after replay is armed is served from the HAR (here the server is
    // still up; the offline-determinism proof lives in the engine's replay.test.ts)
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as StepSC
    expect(nav.snapshot).toContain('[ref=')

    // a traversal path outside the operator replay dir is denied
    const bad = await call(client, 'browser_replay_har', { sessionId, har: '../../../etc/hosts' })
    expect(bad.isError).toBe(true)
    expect(JSON.stringify(bad.content)).toMatch(/replay/i)

    // with no operator replay dir, replay is denied entirely (deny-by-default)
    const noDir = await connect({})
    const nd = (await call(noDir.client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const denied = await call(noDir.client, 'browser_replay_har', {
      sessionId: nd.sessionId,
      har: 'rec.zip',
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toMatch(/not enabled/i)
    await noDir.client.close()
    await client.close()
  })

  it('serves run artifacts by handle and 404s an unknown handle', async () => {
    const { client } = await connect({})
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    const nav = (await call(client, 'browser_navigate', { sessionId, url: baseUrl }))
      .structuredContent as { snapshotHandle?: string }
    expect(nav.snapshotHandle).toBe(`strummer://browser/run/${runId}/snapshot-s1`)

    const snap = await client.readResource({ uri: nav.snapshotHandle as string })
    expect((snap.contents[0] as { text: string }).text).toContain('button "Submit"')

    await expect(
      client.readResource({ uri: `strummer://browser/run/${runId}/nope` }),
    ).rejects.toThrow(/No stored artifact/)
    await client.close()
  })

  it('reaps an idle session, flushing its artifacts, then refuses further calls on it', async () => {
    let nowMs = 1_000
    const { client, manager, store } = await connect({ idleTtlMs: 5_000, now: () => nowMs })
    const { sessionId, runId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
      runId: string
    }
    await call(client, 'browser_navigate', { sessionId, url: baseUrl })

    // advance past the idle TTL and sweep → onReap flushes the recorder
    nowMs += 6_000
    const reaped = await manager.sweepIdle()
    expect(reaped).toContain(sessionId)
    // artifacts were written on reap (not lost) and resolve on disk
    expect(store.get(`strummer://browser/run/${runId}/console`)).toBeDefined()
    expect(store.get(`strummer://browser/run/${runId}/network`)).toBeDefined()

    // a call on the reaped session is refused, not silently re-created
    const after = await call(client, 'browser_get_text', { sessionId, ref: 'e1' })
    expect(after.isError).toBe(true)
    expect(JSON.stringify(after.content)).toMatch(/expired or was reaped/i)
    await client.close()
  })

  // ── Persisted .bru flows (browser_list_flows / browser_run_flow) ────────────
  // Write an operator flows dir holding one flow: navigate (a {{var}}), fill the
  // "Secret" input with an operator {{secret:pw}}, then read it back via an assert.
  function writeFlowsDir(): string {
    const dir = mkdtempSync(join(baseDir, 'flows-'))
    writeFileSync(join(dir, 'inspect.bru'), 'meta {\n  name: inspect\n  type: http\n}\n')
    writeFileSync(
      join(dir, 'inspect.strummer.yml'),
      [
        'steps:',
        '  - navigate: "{{baseUrl}}"',
        '  - fill: { role: textbox, name: Secret, value: "{{secret:pw}}" }',
        '  - assert:',
        '      - { source: value, role: textbox, name: Secret, op: exists }',
      ].join('\n'),
    )
    return dir
  }

  it('runs a persisted flow on a session: vars + operator secret, result redacted', async () => {
    const flowsDir = writeFlowsDir()
    // allowUnsafe so the fill executes; 127.0.0.1 is allowlisted by default.
    const { client } = await connect({ allowUnsafe: true, flowsDir })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const res = await call(client, 'browser_run_flow', {
      sessionId,
      flow: 'inspect',
      vars: { baseUrl },
    })
    const sc = res.structuredContent as {
      name: string
      passed: boolean
      steps: { action: string; ok: boolean; assertions?: { pass: boolean; actual: unknown }[] }[]
    }
    expect(sc.name).toBe('inspect')
    expect(sc.passed).toBe(true)
    expect(sc.steps.map((s) => s.action)).toEqual(['navigate', 'fill', 'assert'])
    // the assert read the secret value back and it existed → pass on the TRUE value…
    const assertStep = sc.steps.find((s) => s.action === 'assert')
    expect(assertStep?.assertions?.[0]?.pass).toBe(true)
    // …but the operator secret is redacted everywhere it surfaces, never echoed.
    expect(JSON.stringify(res.content)).not.toContain('hunter2-secret')
    expect(JSON.stringify(res.content)).toContain('[redacted:pw]')
    await client.close()
  })

  it('browser_list_flows lists the operator flows (name + step count)', async () => {
    const flowsDir = writeFlowsDir()
    const { client } = await connect({ flowsDir })
    const list = (await call(client, 'browser_list_flows')).structuredContent as {
      flows: { name: string; steps: number }[]
    }
    expect(list.flows).toEqual([{ name: 'inspect', steps: 3 }])
    await client.close()
  })

  it('errors on an unknown flow name, naming the available flows', async () => {
    const flowsDir = writeFlowsDir()
    const { client } = await connect({ flowsDir })
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const res = await call(client, 'browser_run_flow', { sessionId, flow: 'nope' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toMatch(/no flow.*nope/i)
    expect(JSON.stringify(res.content)).toMatch(/inspect/) // lists what IS available
    await client.close()
  })

  it('flow tools are deny-by-default: disabled when the operator set no flows dir', async () => {
    const { client } = await connect({}) // no flowsDir
    const { sessionId } = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    const run = await call(client, 'browser_run_flow', { sessionId, flow: 'inspect' })
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.content)).toMatch(/not enabled/i)
    const list = await call(client, 'browser_list_flows')
    expect(list.isError).toBe(true)
    expect(JSON.stringify(list.content)).toMatch(/not enabled/i)
    await client.close()
  })

  it('enforces the session cap and lists open sessions', async () => {
    const { client } = await connect({ maxContexts: 2 })
    const a = (await call(client, 'browser_open_session')).structuredContent as {
      sessionId: string
    }
    await call(client, 'browser_open_session')
    const capped = await call(client, 'browser_open_session')
    expect(capped.isError).toBe(true)
    expect(JSON.stringify(capped.content)).toMatch(/max contexts|maxContexts/i)

    const list = (await call(client, 'browser_list_sessions')).structuredContent as {
      sessions: { sessionId: string }[]
      sessionCount: number
      maxContexts: number
    }
    expect(list.sessionCount).toBe(2)
    expect(list.maxContexts).toBe(2)
    expect(list.sessions.map((s) => s.sessionId)).toContain(a.sessionId)
    await client.close()
  })
})
