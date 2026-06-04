import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { ArtifactStore } from './artifacts.js'

/**
 * HAR capture for the browser pillar — "network heavy mode" (ROADMAP Phase 3;
 * ADR 0006). Playwright records a HAR for a context when it is created with
 * `recordHar` and writes it **on context close**. With a `.zip` path it uses
 * `content:'attach'`, persisting request/response bodies as separate entries in
 * the archive alongside the `.har` JSON.
 *
 * HAR is a heavy secret surface — it carries full request/response headers,
 * query strings, and bodies — so it is **operator-gated off by default** (same
 * posture as the trace.zip and screenshots) and every text entry is passed
 * through the operator's `redact` hook **before** the archive is surfaced.
 * Redaction covers only *registered* secrets (operator secret values + the HTTP
 * password); dynamically-set cookies/tokens are not scrubbed, which is why HAR
 * stays operator-gated rather than on by default.
 */

// Text entries in a HAR `.zip` where a secret can land: the `.har` JSON itself
// (urls/headers/query/postData) and any persisted text resource bodies. Binary
// resources (images, fonts, the `.dat` bodies) pass through untouched. Entries
// are content-addressed but referenced by name, so redacting their bytes in place
// is safe — the HAR still resolves them by name.
const HAR_TEXT_ENTRY = /\.(har|json|txt|html|htm|css|js|xml|svg)$/

// A body's DECLARED mimeType is text-like (so its bytes may carry a secret as text and
// must be redacted), even when its content-addressed attach filename has no text
// extension. Inclusive on purpose — redacting more is safe; a genuinely binary type
// (image/font/octet-stream) is excluded so its bytes pass through byte-for-byte.
const TEXT_MIME = /^text\/|(?:json|xml|javascript|ecmascript|graphql|html|urlencoded|csv|yaml)/i

/**
 * In `content:'attach'` mode Playwright persists request/response bodies as SEPARATE
 * archive entries whose names are content-addressed — frequently WITHOUT a text
 * extension — so {@link HAR_TEXT_ENTRY} (a filename gate) would pass a JSON/GraphQL body
 * through unredacted. Walk the `.har` JSON and collect the `_file` names of every body
 * whose DECLARED mimeType is text-like, so they are redacted by type, not by extension.
 */
function textAttachFiles(harJson: string): Set<string> {
  const files = new Set<string>()
  let entries: unknown[] = []
  try {
    const log = (JSON.parse(harJson) as { log?: { entries?: unknown[] } }).log
    if (Array.isArray(log?.entries)) entries = log.entries
  } catch {
    return files
  }
  const consider = (part: { mimeType?: unknown; _file?: unknown } | undefined) => {
    if (
      part &&
      typeof part._file === 'string' &&
      typeof part.mimeType === 'string' &&
      TEXT_MIME.test(part.mimeType)
    ) {
      files.add(part._file)
    }
  }
  for (const e of entries as {
    request?: { postData?: { mimeType?: unknown; _file?: unknown } }
    response?: { content?: { mimeType?: unknown; _file?: unknown } }
  }[]) {
    consider(e?.request?.postData)
    consider(e?.response?.content)
  }
  return files
}

/** A finished HAR capture, returned by handle with a compact summary. */
export interface HarSummary {
  /** `strummer://browser/run/<id>/har` — the recorded HAR archive (.zip), by handle. */
  handle: string
  byteSize: number
  /** Number of network entries (`log.entries.length`). */
  entryCount: number
  /** Tally by response status (string keys), e.g. `{ '200': 4, '404': 1 }`. */
  byStatus: Record<string, number>
  /** Tally by request method, e.g. `{ GET: 5, POST: 2 }`. */
  byMethod: Record<string, number>
}

/**
 * Where the manager tells Playwright to write a session's HAR. A `.zip` path
 * selects `content:'attach'`; the session id is sanitized so it is a safe
 * filename. Shared by the manager (which sets `recordHar`) and the surface
 * (which locates the file after the context closes).
 */
export function harPathFor(dir: string, sessionId: string): string {
  return join(dir, `${sessionId.replace(/[^\w.-]/g, '_')}.zip`)
}

interface HarCounts {
  entryCount: number
  byStatus: Record<string, number>
  byMethod: Record<string, number>
}

/** Parse the `.har` JSON into compact tallies; tolerant of a malformed/empty log. */
function summarizeHar(harJson: string): HarCounts {
  const byStatus: Record<string, number> = {}
  const byMethod: Record<string, number> = {}
  let entries: unknown[] = []
  try {
    const log = (JSON.parse(harJson) as { log?: { entries?: unknown[] } }).log
    if (Array.isArray(log?.entries)) entries = log.entries
  } catch {
    return { entryCount: 0, byStatus, byMethod }
  }
  for (const e of entries as {
    request?: { method?: unknown }
    response?: { status?: unknown }
  }[]) {
    const status = e?.response?.status
    if (typeof status === 'number') byStatus[String(status)] = (byStatus[String(status)] ?? 0) + 1
    const method = e?.request?.method
    if (typeof method === 'string') byMethod[method] = (byMethod[method] ?? 0) + 1
  }
  return { entryCount: entries.length, byStatus, byMethod }
}

export interface FinalizeHarOptions {
  /** Path Playwright wrote the HAR `.zip` to (see {@link harPathFor}). */
  harPath: string
  /** Run id used to key the stored artifact. */
  runId: string
  store: ArtifactStore
  /** Applied to every text entry before write. Default identity; the server bin
   * wires the real `@strummer/safety` `Redactor` here. */
  redact?: (value: string) => string
}

/**
 * Finalize a recorded HAR: read the `.zip` Playwright wrote on context close,
 * redact its text entries, store the (redacted) archive by handle, and return a
 * compact summary. The temp file is removed (the store owns the canonical copy).
 * Returns `undefined` when no HAR file is present (recording was disabled, or
 * the context made no requests).
 */
export async function finalizeHar(opts: FinalizeHarOptions): Promise<HarSummary | undefined> {
  let raw: Buffer
  try {
    raw = readFileSync(opts.harPath)
  } catch {
    return undefined
  }
  const redact = opts.redact ?? ((v: string) => v)

  const entries = unzipSync(new Uint8Array(raw))
  // The `.har` JSON names the text-like attach bodies (by declared mimeType) that the
  // filename gate would miss — collect them first so they are redacted by TYPE.
  let attachText = new Set<string>()
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('.har')) attachText = textAttachFiles(strFromU8(bytes))
  }
  // Redact every text entry — the `.har` JSON + persisted text bodies (by extension OR
  // by declared mimeType) — and summarize from the `.har`; binary bodies pass through.
  const out: Record<string, Uint8Array> = {}
  let counts: HarCounts = { entryCount: 0, byStatus: {}, byMethod: {} }
  for (const [name, bytes] of Object.entries(entries)) {
    if (HAR_TEXT_ENTRY.test(name) || attachText.has(name)) {
      const text = redact(strFromU8(bytes))
      if (name.endsWith('.har')) counts = summarizeHar(text)
      out[name] = strToU8(text)
    } else {
      out[name] = bytes
    }
  }
  const zip = Buffer.from(zipSync(out))
  const handle = opts.store.put(opts.runId, 'har', zip, 'application/zip')

  // Drop the unredacted temp HAR — the store now holds the canonical (redacted) one.
  try {
    unlinkSync(opts.harPath)
  } catch {
    // already gone; nothing to clean up
  }

  return { handle, byteSize: zip.byteLength, ...counts }
}
