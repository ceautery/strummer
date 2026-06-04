/**
 * The capture→contract bridge (ADR 0013, Phase-5 milestone 5a). Turns a stored
 * browser/API HAR into the records the *already-shipped* OpenAPI response
 * validator consumes — **no request is re-run**; this is a read over an existing
 * artifact. The high-leverage cross-pillar win: a captured run's traffic is
 * checked against the operator-supplied contract for the installed API version.
 *
 * Security posture (ADR 0013 §3): a HAR is operator-gated bytes whose redaction
 * is known-incomplete, so the *surface* gates resolving one (`validate_capture`,
 * slice 6). Here, the pure bridge MUST NOT copy raw headers/cookies into its
 * output (only status + the parsed body needed for schema validation) and every
 * finding message is routed through the operator `Redactor` before it leaves.
 */
import { strFromU8, unzipSync } from 'fflate'
import { type ResponseFacts, validateOpenApiResponse } from './contract.js'
import type { ContractFinding, ContractResult } from './model.js'

/** fflate is unbounded by default; cap the inflated HAR archive (ADR 0013 §3e). */
const MAX_HAR_INFLATED_BYTES = 64 * 1024 * 1024

/** A captured HTTP exchange reduced to the facts the validator needs. */
export interface CaptureEntry {
  req: { method: string; path: string; origin: string }
  res: ResponseFacts
  /** Lower-cased response content-type (sans parameters), e.g. `application/json`. */
  mimeType: string
  /**
   * Set when an attached body referenced by `_file` could not be resolved or
   * JSON-parsed — surfaced as a HARD finding by the driver, never an empty-body
   * pass (ADR 0013 slice 2).
   */
  unresolvedBody?: string
}

interface HarEntry {
  request?: { method?: string; url?: string }
  response?: {
    status?: number
    content?: { mimeType?: string; text?: string; _file?: string; encoding?: string }
  }
}

function findHarJson(zip: Record<string, Uint8Array>): string | undefined {
  const key = Object.keys(zip).find((k) => k.endsWith('.har'))
  return key ? strFromU8(zip[key] as Uint8Array) : undefined
}

function mimeOf(content: { mimeType?: string } | undefined): string {
  return (content?.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/**
 * Slice 2 — parse a HAR `.zip` and resolve each entry's body. The PRIMARY path
 * is `content:'attach'` (the only mode the browser pillar emits): a body lives
 * in a separate archive entry referenced by `response.content._file`. Inline
 * `response.content.text` (`content:'embed'`) is the fallback. JSON bodies are
 * parsed; the URL is reduced to its `pathname` (+ origin kept separately).
 */
export function harEntriesToFacts(harZip: Buffer): CaptureEntry[] {
  const zip = unzipSync(new Uint8Array(harZip), {
    filter: (file) => file.originalSize <= MAX_HAR_INFLATED_BYTES,
  })
  const harText = findHarJson(zip)
  if (harText === undefined) throw new Error('har-capture: no .har entry in the archive')
  const log = (JSON.parse(harText) as { log?: { entries?: HarEntry[] } }).log
  const entries = log?.entries ?? []

  const out: CaptureEntry[] = []
  for (const e of entries) {
    const method = (e.request?.method ?? 'GET').toUpperCase()
    const rawUrl = e.request?.url ?? ''
    let path = rawUrl
    let origin = ''
    try {
      const u = new URL(rawUrl)
      path = u.pathname
      origin = u.origin
    } catch {
      // a relative/opaque url: keep it verbatim as the path
    }
    const status = e.response?.status ?? 0
    const content = e.response?.content
    const mimeType = mimeOf(content)

    let body: unknown
    let unresolvedBody: string | undefined
    const isJson = mimeType.includes('json')

    // Resolve the body bytes: attach (_file) first, then inline text.
    let rawBody: string | undefined
    if (content?._file) {
      const bytes = zip[content._file]
      if (bytes) rawBody = strFromU8(bytes)
      else unresolvedBody = `attached body ${content._file} not found in the archive`
    } else if (typeof content?.text === 'string') {
      rawBody = content.text
    }

    if (unresolvedBody === undefined && isJson) {
      if (rawBody === undefined || rawBody.length === 0) {
        unresolvedBody = 'json response with no resolvable body'
      } else {
        try {
          body = JSON.parse(rawBody)
        } catch {
          unresolvedBody = 'json response body did not parse'
        }
      }
    } else if (!isJson) {
      body = rawBody
    }

    out.push({
      req: { method, path, origin },
      res: { status, body },
      mimeType,
      ...(unresolvedBody ? { unresolvedBody } : {}),
    })
  }
  return out
}

/** Slice 3 — only JSON responses from allowed origins are routed to the validator. */
export interface CaptureFilterOptions {
  /** When set, only entries whose request origin is in this list are considered. */
  allowedOrigins?: string[]
}

function isApiEntry(entry: CaptureEntry, opts: CaptureFilterOptions): boolean {
  if (opts.allowedOrigins && entry.req.origin && !opts.allowedOrigins.includes(entry.req.origin)) {
    return false
  }
  // REST contract validation is JSON-only in v1; an unresolved JSON body is still
  // an API entry (so it surfaces as a hard finding rather than being filtered away).
  return entry.mimeType.includes('json')
}

/**
 * Slice 4 — strip the OpenAPI `servers[].url` base path so a captured
 * `/api/v1/widgets` matches the documented path `/widgets`. Returns the longest
 * matching server base path's remainder, or the original path when none match.
 */
function serverBasePaths(spec: OpenApiSpec): string[] {
  const servers = Array.isArray(spec.servers) ? spec.servers : []
  const bases: string[] = []
  for (const s of servers) {
    const url = typeof s?.url === 'string' ? s.url : ''
    if (!url) continue
    let base = url
    try {
      base = new URL(url).pathname
    } catch {
      // a path-only server url (e.g. "/api/v1"): use as-is
    }
    base = base.replace(/\/+$/, '')
    if (base && base !== '/') bases.push(base)
  }
  // longest first, so the most specific base path wins
  return bases.sort((a, b) => b.length - a.length)
}

function reconcileBasePath(path: string, bases: string[]): string {
  for (const base of bases) {
    if (path === base) return '/'
    if (path.startsWith(`${base}/`)) return path.slice(base.length)
  }
  return path
}

interface OpenApiSpec {
  servers?: Array<{ url?: string }>
  paths?: Record<string, Record<string, unknown> | undefined>
  [key: string]: unknown
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']

/** Every documented operation as `METHOD /template` — the universe for the drift walk. */
function documentedOperations(spec: OpenApiSpec): string[] {
  const ops: string[] = []
  for (const [template, item] of Object.entries(spec.paths ?? {})) {
    if (!item) continue
    for (const method of HTTP_METHODS) {
      if (method in item) ops.push(`${method.toUpperCase()} ${template}`)
    }
  }
  return ops
}

/** The rolled-up contract sub-verdict over a captured run (ADR 0013 §1/§5). */
export interface CaptureContractVerdict {
  /** Entries actually routed to the validator (JSON, allowed origin). */
  entriesValidated: number
  /** Per-`ContractFindingKind` finding counts across all entries (+ `unresolved-body`). */
  findingsByKind: Record<string, number>
  /** The first entry that failed validation, for a fast headline. */
  firstFailing?: { method: string; path: string; kind: string; message: string }
  /** `METHOD /template` for every documented op an entry exercised — the inverse-of-drift signal. */
  exercisedOperations: string[]
  /** Documented ops NO captured entry hit. */
  unexercisedOperations: string[]
  /** Per-entry validator results (finding messages already redacted). */
  results: ContractResult[]
  /** Entries whose attached body could not be resolved/parsed (never a pass). */
  unresolvedBodies: number
  /**
   * `true` only when at least one entry was validated, every result is valid, and
   * no body was unresolved. Absence is never a pass (ADR 0013 §1).
   */
  clean: boolean
}

export interface ValidateCaptureOptions extends CaptureFilterOptions {
  /** Redacts finding messages before they leave the bridge (ADR 0013 §3b). */
  redact?: (value: string) => string
  /** Spec dir for external local-file `$ref` resolution (passed to the validator). */
  baseDir?: string
}

/**
 * Slice 5 — drive captured entries through the shipped `validateOpenApiResponse`
 * and compute the exercised/unexercised-operations drift walk. Every finding
 * message is routed through the operator `Redactor`; reference paths in our own
 * summary use the matched operation template, never the raw captured path.
 */
export function validateCapturedTraffic(
  harZip: Buffer,
  spec: OpenApiSpec,
  opts: ValidateCaptureOptions = {},
): CaptureContractVerdict {
  const redact = opts.redact ?? ((v: string) => v)
  const bases = serverBasePaths(spec)
  const entries = harEntriesToFacts(harZip).filter((e) => isApiEntry(e, opts))

  const results: ContractResult[] = []
  const findingsByKind: Record<string, number> = {}
  const exercised = new Set<string>()
  let firstFailing: CaptureContractVerdict['firstFailing']
  let unresolvedBodies = 0

  const bump = (kind: string) => {
    findingsByKind[kind] = (findingsByKind[kind] ?? 0) + 1
  }

  for (const entry of entries) {
    if (entry.unresolvedBody) {
      unresolvedBodies++
      bump('unresolved-body')
      firstFailing ??= {
        method: entry.req.method,
        path: redact(reconcileBasePath(entry.req.path, bases)),
        kind: 'unresolved-body',
        message: redact(entry.unresolvedBody),
      }
      continue
    }
    const reqPath = reconcileBasePath(entry.req.path, bases)
    const raw = validateOpenApiResponse(
      spec as Parameters<typeof validateOpenApiResponse>[0],
      { method: entry.req.method, path: reqPath },
      entry.res,
      { baseDir: opts.baseDir },
    )
    // Redact every finding message before it enters the verdict (ADR 0013 §3b).
    const redactedFindings: ContractFinding[] = raw.findings.map((f) => ({
      ...f,
      message: redact(f.message),
    }))
    const result: ContractResult = { ...raw, findings: redactedFindings }
    results.push(result)
    if (result.operation)
      exercised.add(`${result.operation.method.toUpperCase()} ${result.operation.path}`)
    for (const f of redactedFindings) bump(f.kind)
    if (!result.valid && !firstFailing) {
      const f = redactedFindings.find((x) => x.severity === 'error') ?? redactedFindings[0]
      firstFailing = {
        // A matched operation template is operator-authored (safe); a raw captured
        // path is not — redact it (§3b: never echo an unredacted captured path).
        method: entry.req.method,
        path: result.operation?.path ?? redact(reqPath),
        kind: f?.kind ?? 'unknown',
        message: f?.message ?? '',
      }
    }
  }

  const documented = documentedOperations(spec)
  const exercisedOperations = [...exercised].sort()
  const unexercisedOperations = documented.filter((op) => !exercised.has(op)).sort()

  const clean = entries.length > 0 && unresolvedBodies === 0 && results.every((r) => r.valid)

  return {
    entriesValidated: entries.length,
    findingsByKind,
    firstFailing,
    exercisedOperations,
    unexercisedOperations,
    results,
    unresolvedBodies,
    clean,
  }
}
