import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ConsoleMessage, Page, Request, Response } from 'playwright-core'
import type { ArtifactStore } from './artifacts.js'

// Text entries in a Playwright trace.zip where a secret can land: the JSONL
// metadata (`trace`/`network`/`stacks` — action params incl. fill values, the
// network log's urls/headers/postData, stacks) AND the text resource snapshots
// (the captured DOM `.html`, the `sources` `.txt`, plus css/js/json/xml). Binary
// resources (screenshots `.jpeg`, `.dat`, fonts) are left untouched. Resource
// files are content-addressed by sha, but the trace references them by that
// filename (not by re-hashing), so redacting their bytes is safe — the viewer
// still resolves by name and renders the scrubbed content.
const TRACE_TEXT_ENTRY = /\.(trace|network|stacks|html|css|js|json|txt|xml)$/

/** Unzip a trace.zip, redact its text entries, and re-zip. */
function redactTraceZip(zip: Buffer, redact: (text: string) => string): Buffer {
  const entries = unzipSync(new Uint8Array(zip))
  const out: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(entries)) {
    out[name] = TRACE_TEXT_ENTRY.test(name) ? strToU8(redact(strFromU8(bytes))) : bytes
  }
  return Buffer.from(zipSync(out))
}

/**
 * Per-run artifact capture for the browser pillar (ADR 0006; ROADMAP Phase 3).
 *
 * Attaches to a page (and its context's tracer) for the lifetime of a run and
 * captures three channels — a Playwright **trace.zip** (screenshots + DOM
 * snapshots + sources), the **console** stream (incl. uncaught page errors),
 * and the **network** log (method/url/status/failure). Each is written to the
 * `ArtifactStore` and returned **by handle** (`strummer://browser/run/<id>/<kind>`)
 * with a compact structured summary — large/binary artifacts never get inlined
 * into a tool result.
 *
 * Every channel is passed through the operator's `redact` hook **before** being
 * written to disk, so a registered secret never lands in an artifact via a logged
 * value or a query string. For the trace.zip that means scrubbing its text
 * entries — the JSONL metadata (action params, network log, stacks) and the text
 * resource snapshots (captured DOM `.html`, `sources` `.txt`, css/js/json) —
 * while binary resources (screenshots, fonts) pass through untouched. Trace
 * capture also stays operator-gated (off by default).
 */

/** A single captured console line (or uncaught page error). */
export interface ConsoleEntry {
  /** Playwright console type (`log`/`warn`/`error`/…) or `'pageerror'`. */
  type: string
  text: string
}

/** A single captured network request/response pair. */
export interface NetworkEntry {
  method: string
  url: string
  /** Response status, once the response arrives. Absent for a failed request. */
  status?: number
  /** Failure reason (e.g. `net::ERR_ABORTED`) when the request did not complete. */
  failure?: string
}

export interface ConsoleSummary {
  count: number
  /** Tally by console type, e.g. `{ log: 3, error: 1, pageerror: 1 }`. */
  byType: Record<string, number>
  /** `strummer://browser/run/<id>/console` — the full (redacted) console JSON. */
  handle: string
}

export interface NetworkSummary {
  count: number
  /** Number of requests that failed (never produced a response). */
  failed: number
  /** Tally by response status code (string keys), e.g. `{ '200': 4, '404': 1 }`. */
  byStatus: Record<string, number>
  /** `strummer://browser/run/<id>/network` — the full (redacted) network JSON. */
  handle: string
}

export interface TraceSummary {
  /** `strummer://browser/run/<id>/trace` — the Playwright trace.zip, by handle. */
  handle: string
  byteSize: number
}

/** What a finished run captured. A channel is absent when it was disabled. */
export interface RunArtifacts {
  trace?: TraceSummary
  console?: ConsoleSummary
  network?: NetworkSummary
}

export interface RunRecorderOptions {
  /** Run id used to key stored artifacts. */
  runId: string
  store: ArtifactStore
  /** Applied to every text artifact before it is written. Default identity; the
   * server bin wires the real `@strummer/safety` `Redactor` here. */
  redact?: (value: string) => string
  /** Capture a Playwright trace.zip. Default true. */
  trace?: boolean
  /** Capture the console + page-error stream. Default true. */
  console?: boolean
  /** Capture the network log. Default true. */
  network?: boolean
}

export class RunRecorder {
  private readonly redact: (value: string) => string
  private readonly hasRedact: boolean
  private readonly captureTrace: boolean
  private readonly captureConsole: boolean
  private readonly captureNetwork: boolean
  private readonly consoleEntries: ConsoleEntry[] = []
  private readonly networkEntries: NetworkEntry[] = []
  private readonly indexOf = new Map<Request, number>()
  private stopped = false

  private constructor(
    private readonly page: Page,
    private readonly opts: RunRecorderOptions,
  ) {
    this.redact = opts.redact ?? ((v) => v)
    this.hasRedact = opts.redact !== undefined
    this.captureTrace = opts.trace ?? true
    this.captureConsole = opts.console ?? true
    this.captureNetwork = opts.network ?? true
  }

  /** Attach the capture listeners (and start tracing) before any navigation. */
  static async start(page: Page, opts: RunRecorderOptions): Promise<RunRecorder> {
    const recorder = new RunRecorder(page, opts)
    if (recorder.captureConsole) {
      page.on('console', recorder.onConsole)
      page.on('pageerror', recorder.onPageError)
    }
    if (recorder.captureNetwork) {
      page.on('request', recorder.onRequest)
      page.on('response', recorder.onResponse)
      page.on('requestfailed', recorder.onRequestFailed)
    }
    if (recorder.captureTrace) {
      await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    }
    return recorder
  }

  private readonly onConsole = (msg: ConsoleMessage): void => {
    this.consoleEntries.push({ type: msg.type(), text: msg.text() })
  }

  private readonly onPageError = (err: Error): void => {
    this.consoleEntries.push({ type: 'pageerror', text: err.message })
  }

  private readonly onRequest = (req: Request): void => {
    this.indexOf.set(req, this.networkEntries.push({ method: req.method(), url: req.url() }) - 1)
  }

  private readonly onResponse = (res: Response): void => {
    const i = this.indexOf.get(res.request())
    const entry = i === undefined ? undefined : this.networkEntries[i]
    if (entry) entry.status = res.status()
  }

  private readonly onRequestFailed = (req: Request): void => {
    const i = this.indexOf.get(req)
    const entry = i === undefined ? undefined : this.networkEntries[i]
    const failure = req.failure()?.errorText
    if (entry && failure) entry.failure = failure
  }

  /** Detach listeners, stop tracing, write the artifacts, and return summaries. */
  async stop(): Promise<RunArtifacts> {
    if (this.stopped) throw new Error('RunRecorder.stop() already called')
    this.stopped = true
    const { runId, store } = this.opts

    if (this.captureConsole) {
      this.page.off('console', this.onConsole)
      this.page.off('pageerror', this.onPageError)
    }
    if (this.captureNetwork) {
      this.page.off('request', this.onRequest)
      this.page.off('response', this.onResponse)
      this.page.off('requestfailed', this.onRequestFailed)
    }

    const artifacts: RunArtifacts = {}

    if (this.captureTrace) {
      // Playwright only writes a trace to a path; stage it in a temp file, then
      // hand the bytes to the store (which owns the canonical layout) and clean up.
      const tmp = join(tmpdir(), `strummer-trace-${runId.replace(/[^\w.-]/g, '_')}.zip`)
      await this.page.context().tracing.stop({ path: tmp })
      let buf: Buffer = readFileSync(tmp)
      unlinkSync(tmp)
      // Scrub registered secrets from the trace's text metadata before write (the
      // only redaction the trace gets — Playwright does none).
      if (this.hasRedact) buf = redactTraceZip(buf, this.redact)
      const handle = store.put(runId, 'trace', buf, 'application/zip')
      artifacts.trace = { handle, byteSize: buf.byteLength }
    }

    if (this.captureConsole) {
      const byType: Record<string, number> = {}
      for (const e of this.consoleEntries) byType[e.type] = (byType[e.type] ?? 0) + 1
      const body = this.redact(JSON.stringify(this.consoleEntries, null, 2))
      const handle = store.put(runId, 'console', body, 'application/json')
      artifacts.console = { count: this.consoleEntries.length, byType, handle }
    }

    if (this.captureNetwork) {
      const byStatus: Record<string, number> = {}
      let failed = 0
      for (const e of this.networkEntries) {
        if (e.status !== undefined)
          byStatus[String(e.status)] = (byStatus[String(e.status)] ?? 0) + 1
        if (e.failure !== undefined) failed += 1
      }
      const body = this.redact(JSON.stringify(this.networkEntries, null, 2))
      const handle = store.put(runId, 'network', body, 'application/json')
      artifacts.network = { count: this.networkEntries.length, failed, byStatus, handle }
    }

    return artifacts
  }
}
