/**
 * HAR synthesis + redaction for the API pillar (ADR 0013 Addendum 4, milestone 5f).
 * Lets `verify` PRODUCE a HAR from the `@strummer/api` runner (not just the browser
 * pillar's live capture), then validate it against the contract via the SHIPPED
 * {@link validateCapturedTraffic} — full REST + GraphQL parity.
 *
 * This module is a PURE leaf: it imports ONLY `fflate` (no runner/undici/spawn-capable
 * code), so the new `@strummer/browser → @strummer/api` dep edge it creates (browser's
 * `finalizeHar` delegates its Buffer→Buffer transform here) cannot drag heavy code into
 * the browser pillar, and the gate suite exercises synthesis with no network.
 *
 * Security posture (ADR 0013 §3): a synthesized HAR carries the REAL request/response
 * bodies + urls. {@link redactHarZip} is the blanket-redaction pass (lifted from the
 * browser pillar's `finalizeHar` core, shared so the 5e attach-mimeType fix is inherited),
 * and {@link synthesizeRedactedHarZip} folds it in so NO un-redacted buffer is ever
 * returned. The redactor MUST carry the run-resolved `{{secret:NAME}}` values.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

/** fflate is unbounded by default; cap the inflated HAR archive (ADR 0013 §3e). */
const MAX_HAR_INFLATED_BYTES = 64 * 1024 * 1024

// Text entries in a HAR `.zip` where a secret can land: the `.har` JSON itself
// (urls/headers/query/postData) and any persisted text resource bodies. Binary
// resources pass through untouched. Entries are content-addressed but referenced by
// name, so redacting their bytes in place is safe — the HAR still resolves them by name.
const HAR_TEXT_ENTRY = /\.(har|json|txt|html|htm|css|js|xml|svg)$/

// A body's DECLARED mimeType is text-like (so its bytes may carry a secret as text and
// must be redacted), even when its content-addressed attach filename has no text
// extension. Inclusive on purpose — a genuinely binary type is excluded so it passes
// through byte-for-byte. Mirrors `@strummer/browser` `har.ts` (one redaction posture).
const TEXT_MIME = /^text\/|(?:json|xml|javascript|ecmascript|graphql|html|urlencoded|csv|yaml)/i

/**
 * In `content:'attach'` mode a body lives in a SEPARATE archive entry whose name is
 * content-addressed — frequently WITHOUT a text extension — so {@link HAR_TEXT_ENTRY}
 * (a filename gate) would pass a JSON/GraphQL body through unredacted. Walk the `.har`
 * JSON and collect the `_file` names of every body whose DECLARED mimeType is text-like,
 * so they are redacted by type, not by extension.
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

/** Compact tallies over a parsed HAR; tolerant of a malformed/empty log. */
export interface HarCounts {
  entryCount: number
  byStatus: Record<string, number>
  byMethod: Record<string, number>
}

/** Parse the `.har` JSON into compact tallies; tolerant of a malformed/empty log. */
export function summarizeHar(harJson: string): HarCounts {
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

/**
 * The blanket-redaction pass over a HAR `.zip` Buffer (PURE — no file I/O). Unzips,
 * collects the text-like attach `_file` bodies by DECLARED mimeType (so a body stored
 * under a non-text filename is still scrubbed), redacts every text member — the `.har`
 * JSON + text-extension bodies + those attach bodies — and re-zips. A genuinely binary
 * member passes through byte-for-byte. Shared by the browser pillar's `finalizeHar`
 * (file wrapper) and api synthesis (in-memory), so they share ONE redaction code path.
 */
export function redactHarZip(zip: Buffer, redact: (value: string) => string): Buffer {
  const entries = unzipSync(new Uint8Array(zip), {
    filter: (file) => file.originalSize <= MAX_HAR_INFLATED_BYTES,
  })
  // The `.har` JSON names the text-like attach bodies (by declared mimeType) the
  // filename gate would miss — collect them first so they are redacted by TYPE.
  let attachText = new Set<string>()
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith('.har')) attachText = textAttachFiles(strFromU8(bytes))
  }
  const out: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(entries)) {
    if (HAR_TEXT_ENTRY.test(name) || attachText.has(name)) {
      out[name] = strToU8(redact(strFromU8(bytes)))
    } else {
      out[name] = bytes
    }
  }
  return Buffer.from(zipSync(out))
}

/**
 * One captured HTTP exchange (a single request OR a single redirect hop) reduced to
 * what {@link synthesizeRedactedHarZip} needs. The runner's produce channel
 * (`runRequestForHar`, slice 4) emits one of these per hop — so a redirect chain
 * becomes one HAR entry per hop, never a collapsed chain (ADR 0013 Addendum 4 gap a).
 * Bodies are STRING-only: a Buffer/FormData (file/multipart) request body leaves
 * `reqBody` undefined ⇒ no `postData` is synthesized (lossless — the response still
 * validates; gap b's GraphQL path needs only string JSON bodies anyway).
 */
export interface HarHopRecord {
  method: string
  url: string
  /** The real numeric HTTP status. A missing status is INCOMPLETE capture and THROWS
   * (never coerced to 0, which the bridge would read as an undocumented-status finding —
   * a false fail masking the true inconclusive state). */
  status: number
  resContentType?: string
  /** The real (secret-bearing) response body text; redacted by {@link redactHarZip}. */
  resBody?: string
  reqContentType?: string
  /** The real (secret-bearing) request body text (GraphQL's `query` lives here). */
  reqBody?: string
}

interface SynthEntry {
  request: { method: string; url: string; postData?: { mimeType: string; text: string } }
  response: { status: number; content: { mimeType: string; text?: string } }
}

/**
 * Synthesize a HAR `.zip` Buffer from per-hop records and IMMEDIATELY redact it — the
 * ONLY public surface, so no un-redacted synthesized buffer is ever returned/stored/
 * validated (ADR 0013 §3b). Builds `{log:{entries}}` with ONLY the six fields the
 * consume bridge reads, INLINE `text` bodies (we hold the strings — no `_file` attach),
 * one `.har` member, then runs {@link redactHarZip}. THROWS on a status-less record.
 */
export function synthesizeRedactedHarZip(
  records: HarHopRecord[],
  redact: (value: string) => string,
): Buffer {
  const entries: SynthEntry[] = []
  for (const r of records) {
    if (typeof r.status !== 'number' || !Number.isFinite(r.status)) {
      throw new Error(`har-synth: record for ${r.method} ${r.url} has no numeric status`)
    }
    const request: SynthEntry['request'] = { method: r.method, url: r.url }
    // postData only for a string body with a declared content-type (omit for binary).
    if (typeof r.reqBody === 'string' && r.reqContentType) {
      request.postData = { mimeType: r.reqContentType, text: r.reqBody }
    }
    const content: SynthEntry['response']['content'] = { mimeType: r.resContentType ?? '' }
    if (typeof r.resBody === 'string') content.text = r.resBody
    entries.push({ request, response: { status: r.status, content } })
  }
  const har = {
    log: { version: '1.2', creator: { name: 'strummer-api', version: '1.2' }, entries },
  }
  const zip = Buffer.from(zipSync({ 'synth.har': strToU8(JSON.stringify(har)) }))
  return redactHarZip(zip, redact)
}
