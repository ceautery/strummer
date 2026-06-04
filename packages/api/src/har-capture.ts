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
import { validateGraphqlOperation } from './graphql.js'
import type { ContractFinding, ContractResult } from './model.js'
import { validateOpenApiRequest } from './request-contract.js'

/** fflate is unbounded by default; cap the inflated HAR archive (ADR 0013 §3e). */
const MAX_HAR_INFLATED_BYTES = 64 * 1024 * 1024

/** A captured HTTP exchange reduced to the facts the validator needs. */
export interface CaptureEntry {
  req: {
    method: string
    path: string
    origin: string
    /**
     * The parsed JSON request body, when the request carried a JSON `postData`
     * (attach `_file` first, inline `text` fallback). Needed for GraphQL drift:
     * the operation `query` lives in the request, not the response (ADR 0013 §5).
     */
    body?: unknown
    /** Decoded request query params (repeated keys → array). Captured for
     * request-side contract validation (slice 4a); only set when non-empty. */
    query?: Record<string, string | string[]>
    /** Lower-cased request header names → value (last wins). Only set when present. */
    headers?: Record<string, string>
    /** Decoded TEXT fields of a `form`-style request body (form-urlencoded /
     * multipart text parts) from HAR `postData.params[]` (repeated keys → array;
     * urlencoded `text` fallback). The authoritative-source rule still holds: the
     * capture path drives the validator NON-authoritatively (ADR 0016 addendum 4). */
    form?: Record<string, string | string[]>
    /** NAMES of multipart FILE parts (a `postData.params` entry with `fileName`);
     * bytes never enter the facts. */
    formFileFields?: string[]
  }
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

interface HarContent {
  mimeType?: string
  text?: string
  _file?: string
  encoding?: string
  /** Structured form fields (HAR `postData.params`): `{name, value?, fileName?}`. A
   * `fileName` marks a FILE part (bytes never inlined). */
  params?: { name?: string; value?: string; fileName?: string }[]
}

interface HarEntry {
  request?: {
    method?: string
    url?: string
    postData?: HarContent
    headers?: { name?: string; value?: string }[]
  }
  response?: {
    status?: number
    content?: HarContent
  }
}

/** Build a decoded query record from a URL's search params (repeated keys → array). */
function collectQuery(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key)
    out[key] = all.length > 1 ? all : (all[0] ?? '')
  }
  return out
}

/** Lower-cased request header map (last value wins) from the HAR header array. */
function collectHeaders(
  hdrs: { name?: string; value?: string }[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of hdrs ?? []) {
    if (typeof h?.name === 'string') out[h.name.toLowerCase()] = String(h.value ?? '')
  }
  return out
}

function findHarJson(zip: Record<string, Uint8Array>): string | undefined {
  const key = Object.keys(zip).find((k) => k.endsWith('.har'))
  return key ? strFromU8(zip[key] as Uint8Array) : undefined
}

function mimeOf(content: { mimeType?: string } | undefined): string {
  return (content?.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** `'urlencoded'`/`'multipart'` for the two form media bases, else `undefined`. */
function formBaseOf(mime: string): 'urlencoded' | 'multipart' | undefined {
  if (mime === 'application/x-www-form-urlencoded') return 'urlencoded'
  if (mime === 'multipart/form-data') return 'multipart'
  return undefined
}

/** Append a field into a repeated-keys-→-array map (the form-field channel shape). */
function appendFormField(
  map: Record<string, string | string[]>,
  name: string,
  value: string,
): void {
  const cur = map[name]
  if (cur === undefined) map[name] = value
  else if (Array.isArray(cur)) cur.push(value)
  else map[name] = [cur, value]
}

/**
 * Resolve a `form`-style request `postData` into the structured field channel
 * `validateFormBody` consumes (ADR 0016 addendum 4 capture path). PREFER the
 * structured `params[]` (each `{name, value?, fileName?}`, already URL-decoded by
 * the capturer; a `fileName` marks a FILE part → names-only). For `urlencoded`
 * ONLY, fall back to parsing `postData.text` (well-defined percent-decoding). A
 * `multipart` body with no `params[]` (only raw `_file`/`text`) is NOT parsed —
 * boundary parsing reintroduces the embedded-delimiter trap — so `undefined` is
 * returned and the validator `unverified`-skips. Returns `undefined` when nothing
 * sound is extractable.
 */
function formFieldsFromPostData(
  pd: HarContent,
  base: 'urlencoded' | 'multipart',
): { form: Record<string, string | string[]>; fileFields: string[] } | undefined {
  const form: Record<string, string | string[]> = {}
  const fileFields: string[] = []
  if (Array.isArray(pd.params) && pd.params.length > 0) {
    for (const p of pd.params) {
      if (typeof p?.name !== 'string') continue
      if (typeof p.fileName === 'string')
        fileFields.push(p.name) // FILE part — name only
      else appendFormField(form, p.name, String(p.value ?? ''))
    }
    return { form, fileFields }
  }
  if (base === 'urlencoded' && typeof pd.text === 'string') {
    const sp = new URLSearchParams(pd.text)
    for (const key of new Set(sp.keys())) {
      const all = sp.getAll(key)
      form[key] = all.length > 1 ? all : (all[0] ?? '')
    }
    return { form, fileFields }
  }
  return undefined
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
    let query: Record<string, string | string[]> | undefined
    try {
      const u = new URL(rawUrl)
      path = u.pathname
      origin = u.origin
      const q = collectQuery(u.searchParams)
      if (Object.keys(q).length > 0) query = q
    } catch {
      // a relative/opaque url: keep it verbatim as the path
    }
    const headersMap = collectHeaders(e.request?.headers)
    const headers = Object.keys(headersMap).length > 0 ? headersMap : undefined
    const status = e.response?.status ?? 0
    const content = e.response?.content
    const mimeType = mimeOf(content)

    // Resolve the JSON request body (GraphQL's operation lives here). Attach
    // (`_file`) first, inline `text` fallback; parse only a JSON content-type.
    // A non-resolving/non-JSON request body just leaves `req.body` undefined —
    // the GraphQL router treats a missing query as a hard finding itself.
    const reqContent = e.request?.postData
    // Resolve a `form`-style request body into the structured field channel (ADR 0016
    // addendum 4 capture path); the validator drives it non-authoritatively.
    let reqForm: Record<string, string | string[]> | undefined
    let reqFormFiles: string[] | undefined
    const reqFormBase = reqContent ? formBaseOf(mimeOf(reqContent)) : undefined
    if (reqContent && reqFormBase) {
      const extracted = formFieldsFromPostData(reqContent, reqFormBase)
      if (extracted) {
        reqForm = extracted.form
        if (extracted.fileFields.length > 0) reqFormFiles = extracted.fileFields
      }
    }
    let reqBody: unknown
    if (reqContent && mimeOf(reqContent).includes('json')) {
      let rawReq: string | undefined
      if (reqContent._file) {
        const bytes = zip[reqContent._file]
        if (bytes) rawReq = strFromU8(bytes)
      } else if (typeof reqContent.text === 'string') {
        rawReq = reqContent.text
      }
      if (rawReq !== undefined && rawReq.length > 0) {
        try {
          reqBody = JSON.parse(rawReq)
        } catch {
          // unparseable request body: leave undefined (no GraphQL query extractable)
        }
      }
    }

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
      req: {
        method,
        path,
        origin,
        ...(reqBody !== undefined ? { body: reqBody } : {}),
        ...(query ? { query } : {}),
        ...(headers ? { headers } : {}),
        ...(reqForm ? { form: reqForm } : {}),
        ...(reqFormFiles ? { formFileFields: reqFormFiles } : {}),
      },
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

/** The GraphQL half of a capture contract (ADR 0013 §5 discriminated input). */
export interface GraphqlContract {
  /** The full request pathname that serves GraphQL, e.g. `/graphql`. */
  endpointPath: string
  /** The schema SDL captured operations are validated against (drift detection). */
  sdl: string
}

/**
 * The discriminated contract a captured run is validated against. Supply
 * `openapi` (REST), `graphql` (GraphQL), or both. A captured entry is routed to
 * exactly one validator; a GraphQL entry never falls through to the OpenAPI
 * validator (which would flood `missing-operation`), and an entry with no
 * matching contract half is **no-signal**, never a pass (ADR 0013 §1/§5).
 */
export interface CaptureContract {
  openapi?: OpenApiSpec
  graphql?: GraphqlContract
}

/**
 * Extract the GraphQL operation from a captured request body. The GraphQL-over-
 * HTTP shape is a JSON object with a string `query` (and optional `operationName`
 * and `variables`). Returns `undefined` for a non-GraphQL body.
 */
function graphqlOperationOf(
  entry: CaptureEntry,
): { query: string; operationName?: string; variables?: unknown } | undefined {
  const b = entry.req.body
  if (b && typeof b === 'object' && typeof (b as { query?: unknown }).query === 'string') {
    const opName = (b as { operationName?: unknown }).operationName
    const variables = (b as { variables?: unknown }).variables
    return {
      query: (b as { query: string }).query,
      ...(typeof opName === 'string' ? { operationName: opName } : {}),
      ...(variables !== undefined ? { variables } : {}),
    }
  }
  return undefined
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
   * Entries we could NOT verify because no matching contract half was supplied —
   * a GraphQL call with no SDL (`graphql-sdl-not-supplied`), or a REST call with
   * no OpenAPI spec (`no-contract-for-entry`). Counted, never a pass (ADR 0013 §1).
   */
  noSignal: number
  /**
   * `true` only when at least one entry was validated, every result is valid, no
   * body was unresolved, AND no entry was no-signal. Absence is never a pass
   * (ADR 0013 §1) — an unverifiable GraphQL/REST call can't make a run clean.
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
 * Slice 5 (+ ADR 0013 §5 GraphQL) — drive each captured JSON entry through the
 * matching shipped validator. A GraphQL entry (matched by the contract's
 * `endpointPath` or the JSON `{query}` shape) goes to `validateGraphqlOperation`
 * and NEVER to the OpenAPI validator; a REST entry goes to
 * `validateOpenApiResponse` and feeds the exercised/unexercised drift walk. An
 * entry with no matching contract half is no-signal (never a pass). Every finding
 * message is routed through the operator `Redactor`; our own summary paths use the
 * matched operation template / operator-supplied endpoint, never a raw captured path.
 */
export function validateCapturedTraffic(
  harZip: Buffer,
  contract: CaptureContract,
  opts: ValidateCaptureOptions = {},
): CaptureContractVerdict {
  const redact = opts.redact ?? ((v: string) => v)
  const { openapi: spec, graphql } = contract
  const bases = spec ? serverBasePaths(spec) : []
  const entries = harEntriesToFacts(harZip).filter((e) => isApiEntry(e, opts))

  const results: ContractResult[] = []
  const findingsByKind: Record<string, number> = {}
  const exercised = new Set<string>()
  let firstFailing: CaptureContractVerdict['firstFailing']
  let unresolvedBodies = 0
  let noSignal = 0

  const bump = (kind: string) => {
    findingsByKind[kind] = (findingsByKind[kind] ?? 0) + 1
  }
  const pushResult = (entry: CaptureEntry, raw: ContractResult, displayPath: string) => {
    // Redact every finding message AND path before it enters the verdict (ADR 0013
    // §3b; the path-redaction widening was human-ratified — request bodies/params are
    // secret-bearing, so `path` can carry a captured key name; cheap, one chokepoint).
    const redactedFindings: ContractFinding[] = raw.findings.map((f) => ({
      ...f,
      message: redact(f.message),
      ...(f.path !== undefined ? { path: redact(f.path) } : {}),
    }))
    const result: ContractResult = { ...raw, findings: redactedFindings }
    results.push(result)
    for (const f of redactedFindings) bump(f.kind)
    if (!result.valid && !firstFailing) {
      const f = redactedFindings.find((x) => x.severity === 'error') ?? redactedFindings[0]
      firstFailing = {
        method: entry.req.method,
        path: displayPath,
        kind: f?.kind ?? 'unknown',
        message: f?.message ?? '',
      }
    }
    return result
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

    // GraphQL detection: the operator-supplied endpoint path, or the JSON
    // `{query}` request shape. Either way it is a GraphQL call, not a REST one.
    const op = graphqlOperationOf(entry)
    const isGraphql = (graphql !== undefined && entry.req.path === graphql.endpointPath) || !!op
    if (isGraphql) {
      if (!graphql) {
        // Detected GraphQL but no SDL supplied: no-signal, NEVER an OpenAPI
        // fall-through (which would flood `missing-operation`). ADR 0013 §5.
        noSignal++
        bump('graphql-sdl-not-supplied')
        continue
      }
      if (!op) {
        // Matched the GraphQL endpoint but no `query` could be extracted from the
        // request — a hard finding, never an empty pass.
        pushResult(
          entry,
          {
            valid: false,
            findings: [
              {
                kind: 'graphql-no-query',
                severity: 'error',
                message: 'no GraphQL query found in the captured request body',
              },
            ],
          },
          redact(graphql.endpointPath),
        )
        continue
      }
      // The capture path is NOT authoritative about variable completeness (a HAR may
      // have dropped `variables`), so `variablesAuthoritative` is omitted — an absent
      // required variable surfaces as `unverified`, never a false finding (ADR 0015).
      const raw = validateGraphqlOperation(graphql.sdl, op.query, {
        json: entry.res.body,
        operationName: op.operationName,
        ...(op.variables !== undefined ? { variables: op.variables } : {}),
      })
      pushResult(entry, raw, redact(graphql.endpointPath))
      // A present-but-uncheckable variable set is `unverified` — fold into `noSignal`
      // (out-of-band, NOT a finding) so it can never be laundered into a clean pass
      // (absence-is-never-a-pass; mirrors the REST `request-unverified` fold).
      if (raw.unverified) {
        noSignal++
        bump('graphql-variable-unverified')
      }
      continue
    }

    // REST: requires an OpenAPI contract. Without one, the call is unverifiable.
    if (!spec) {
      noSignal++
      bump('no-contract-for-entry')
      continue
    }
    const reqPath = reconcileBasePath(entry.req.path, bases)
    const typedSpec = spec as Parameters<typeof validateOpenApiResponse>[0]
    const resRaw = validateOpenApiResponse(
      typedSpec,
      { method: entry.req.method, path: reqPath },
      entry.res,
      { baseDir: opts.baseDir },
    )
    // Drive REQUEST-side validation over the same entry. The capture path is NOT
    // authoritative about body presence or param completeness (it cannot tell "no
    // body" from a dropped non-JSON body, and may not have captured every param), so
    // both authority flags are OMITTED — a required-but-absent body/param surfaces as
    // `unverified`, never a false `missing-*` finding.
    const reqRaw = validateOpenApiRequest(
      typedSpec,
      {
        method: entry.req.method,
        path: reqPath,
        body: entry.req.body,
        query: entry.req.query,
        headers: entry.req.headers,
        form: entry.req.form,
        formFileFields: entry.req.formFileFields,
      },
      { baseDir: opts.baseDir },
    )
    // Merge into one ContractResult before the single redaction chokepoint. Drop the
    // request side's `missing-operation` (the response side reports it once).
    const merged: ContractResult = {
      valid: resRaw.valid && reqRaw.valid,
      findings: [
        ...resRaw.findings,
        ...reqRaw.findings.filter((f) => f.kind !== 'missing-operation'),
      ],
      ...((resRaw.operation ?? reqRaw.operation)
        ? { operation: resRaw.operation ?? reqRaw.operation }
        : {}),
    }
    // A matched operation template is operator-authored (safe); a raw captured
    // path is not — redact it (§3b: never echo an unredacted captured path).
    const result = pushResult(entry, merged, merged.operation?.path ?? redact(reqPath))
    if (result.operation)
      exercised.add(`${result.operation.method.toUpperCase()} ${result.operation.path}`)
    // A present-but-uncheckable body / uncapturable required param is `unverified` —
    // fold it into `noSignal` (out-of-band, NOT a finding in `results[]`, so it never
    // double-counts as a warning) so it can never be laundered into a clean pass
    // (absence-is-never-a-pass; closes the leak the design's critic proved).
    if (reqRaw.unverified) {
      noSignal++
      bump('request-unverified')
    }
  }

  const documented = spec ? documentedOperations(spec) : []
  const exercisedOperations = [...exercised].sort()
  const unexercisedOperations = documented.filter((op) => !exercised.has(op)).sort()

  const clean =
    entries.length > 0 && unresolvedBodies === 0 && noSignal === 0 && results.every((r) => r.valid)

  return {
    entriesValidated: entries.length,
    findingsByKind,
    firstFailing,
    exercisedOperations,
    unexercisedOperations,
    results,
    unresolvedBodies,
    noSignal,
    clean,
  }
}
