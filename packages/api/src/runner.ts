import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { type DnsLookup, SsrfError } from '@strummer/safety'
import { type Dispatcher, type FormData, request } from 'undici'
import { ArtifactStore } from './artifacts.js'
import { evaluateAssertions, extractCaptures } from './assert.js'
import type { Collection, PreparedRequest, RunResult, ScriptTest, SecretStore } from './model.js'
import { prepareRequest } from './prepare.js'
import { assertSsrfAllowed, checkGate, isMutating } from './safety.js'
import { runScript } from './script.js'
import { EnvSecretStore, Redactor } from './secrets.js'

export interface RunOptions {
  /** Variable scope for `{{var}}` interpolation. */
  vars?: Record<string, unknown>
  /** Name of a collection environment whose vars seed the scope (lowest precedence). */
  env?: string
  /** Secret store for `{{secret:NAME}}` resolution (defaults to env). */
  secrets?: SecretStore
  /** Artifact store for the response body (a fresh one is used if omitted). */
  artifacts?: ArtifactStore
  /** Opt in to actually sending mutating requests. */
  allowUnsafe?: boolean
  /** Hostnames a mutating request may reach. */
  allowedHosts?: string[]
  /** Permit loopback/private SSRF targets (default true; see `assertSsrfAllowed`).
   * Set false to block all private ranges, not just metadata/link-local. */
  allowPrivate?: boolean
  /** Injectable DNS resolver for the SSRF pre-flight (tests). */
  lookup?: DnsLookup
  /** Maximum redirect hops to follow (default 0 = don't follow; return the 3xx).
   * Every hop is re-checked: SSRF range-block + the mutation host-allowlist. */
  maxRedirects?: number
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
/** Headers dropped when a redirect crosses to a different host (browser-like). */
const CROSS_ORIGIN_DROP = new Set(['authorization', 'cookie'])

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Method/body for the next hop. 303 (and POST on 301/302) downgrades to GET and
 * drops the body; 307/308 preserve both. */
function redirectTransition(
  status: number,
  method: string,
  body: string | Buffer | FormData | undefined,
): { method: string; body: string | Buffer | FormData | undefined } {
  if (status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === 'POST')) {
    return { method: 'GET', body: undefined }
  }
  return { method, body }
}

function dropCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!CROSS_ORIGIN_DROP.has(key.toLowerCase())) out[key] = value
  }
  return out
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === lower)
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }
  return out
}

/**
 * Execute one request: resolve vars + secrets, apply the mutation safety gate
 * (mutating methods dry-run unless explicitly unlocked), dispatch via undici if
 * allowed, evaluate assertions, and return a result whose surfaced strings
 * (request, response headers, body artifact) are all secret-redacted.
 */
export async function runRequest(
  collection: Collection,
  name: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const entry = collection.requests.get(name)
  if (!entry) {
    throw new Error(`no request '${name}' in collection at ${collection.dir}`)
  }

  const secrets = opts.secrets ?? new EnvSecretStore()
  const redactor = new Redactor()
  // Scope precedence: explicit/captured vars override the chosen environment.
  const envVars = opts.env ? (collection.environments.get(opts.env) ?? {}) : {}
  const scope = { ...envVars, ...(opts.vars ?? {}) }

  // Pre-request script may set variables used in interpolation.
  if (entry.preScript) {
    const pre = await runScript(entry.preScript, { vars: scope })
    Object.assign(scope, pre.vars)
  }

  const prepared = await prepareRequest(entry.request, scope, secrets, redactor, collection.dir)

  // Headers actually sent: add a default Content-Type for the body if unset.
  // A body with no explicit contentType (multipart) is left for undici to set,
  // since it must generate the boundary.
  const sendHeaders = { ...prepared.headers }
  if (prepared.body?.contentType && !hasHeader(sendHeaders, 'content-type')) {
    sendHeaders['Content-Type'] = prepared.body.contentType
  }

  const redactedRequest: PreparedRequest = {
    method: prepared.method,
    url: redactor.redact(prepared.url),
    headers: redactor.redactHeaders(sendHeaders),
    body: prepared.body ? redactor.redact(prepared.body.preview) : undefined,
  }

  const gate = checkGate(prepared.method, hostOf(prepared.url), {
    allowUnsafe: opts.allowUnsafe,
    allowedHosts: opts.allowedHosts,
  })
  if (!gate.allowed) {
    return { request: redactedRequest, sent: false, dryRun: true, reason: gate.reason }
  }

  // SSRF range-block: applies to every request that would actually go out (a
  // safe GET to the metadata endpoint is the classic SSRF). A block is a safety
  // refusal, not a dry-run — surfaced as withheld with a reason.
  try {
    await assertSsrfAllowed(prepared.url, { allowPrivate: opts.allowPrivate, lookup: opts.lookup })
  } catch (err) {
    if (err instanceof SsrfError) {
      return {
        request: redactedRequest,
        sent: false,
        dryRun: false,
        reason: `blocked: ${err.message}`,
      }
    }
    throw err
  }

  const started = performance.now()
  const maxRedirects = opts.maxRedirects ?? 0
  const redirects: { status: number; location: string }[] = []

  let currentUrl = prepared.url
  let currentMethod = prepared.method
  let currentHeaders = sendHeaders
  let currentBody = prepared.body?.content

  let res = await request(currentUrl, {
    method: currentMethod as Dispatcher.HttpMethod,
    headers: currentHeaders,
    body: currentBody,
  })

  // Follow redirects (opt-in), re-checking every hop: SSRF range-block, then the
  // mutation host-allowlist, then strip credential headers on a host change.
  while (REDIRECT_CODES.has(res.statusCode) && redirects.length < maxRedirects) {
    const location = headerValue(res.headers, 'location')
    if (!location) break
    await res.body.dump() // drain the intermediate response before the next hop

    let nextUrl: string
    try {
      nextUrl = new URL(location, currentUrl).toString()
    } catch {
      break // unparseable Location — surface the 3xx as the response
    }

    try {
      await assertSsrfAllowed(nextUrl, { allowPrivate: opts.allowPrivate, lookup: opts.lookup })
    } catch (err) {
      if (err instanceof SsrfError) {
        return {
          request: redactedRequest,
          sent: false,
          dryRun: false,
          reason: `blocked redirect: ${err.message}`,
        }
      }
      throw err
    }

    const next = redirectTransition(res.statusCode, currentMethod, currentBody)
    if (isMutating(next.method)) {
      const g = checkGate(next.method, hostOf(nextUrl), {
        allowUnsafe: opts.allowUnsafe,
        allowedHosts: opts.allowedHosts,
      })
      if (!g.allowed) {
        return {
          request: redactedRequest,
          sent: false,
          dryRun: true,
          reason: `redirect blocked: ${g.reason}`,
        }
      }
    }

    const sameHost = hostOf(nextUrl) === hostOf(currentUrl)
    const nextHeaders = sameHost ? currentHeaders : dropCrossOriginHeaders(currentHeaders)
    redirects.push({ status: res.statusCode, location: redactor.redact(nextUrl) })

    res = await request(nextUrl, {
      method: next.method as Dispatcher.HttpMethod,
      headers: nextHeaders,
      body: next.body,
    })
    currentUrl = nextUrl
    currentMethod = next.method
    currentHeaders = nextHeaders
    currentBody = next.body
  }

  const bodyText = await res.body.text()
  const latencyMs = performance.now() - started
  const headers = flattenHeaders(res.headers)

  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    json = undefined
  }

  // Assertions/captures evaluate the REAL response; only surfaced strings are
  // redacted. Captures feed later requests in a sequence (see runSequence).
  const ctx = { status: res.statusCode, statusText: '', headers, bodyText, json, latencyMs }
  const assertions = evaluateAssertions(entry.assertions, ctx)
  const captured = extractCaptures(entry.captures, ctx)

  // Post-response script: programmatic tests + captures over the REAL response.
  let scriptTests: ScriptTest[] = []
  if (entry.postScript) {
    const before = { ...scope }
    const post = await runScript(entry.postScript, {
      vars: scope,
      res: { status: res.statusCode, headers, body: bodyText, json },
    })
    scriptTests = post.tests.map((t) => ({
      name: redactor.redact(t.name),
      pass: t.pass,
      error: t.error ? redactor.redact(t.error) : undefined,
    }))
    for (const [key, value] of Object.entries(post.vars)) {
      if (!(key in before) || before[key] !== value) {
        captured[key] = value
        scope[key] = value
      }
    }
  }

  const store = opts.artifacts ?? new ArtifactStore()
  const bodyHandle = store.put(
    randomUUID(),
    redactor.redact(bodyText),
    headers['content-type'] ?? 'application/octet-stream',
  )

  return {
    request: redactedRequest,
    sent: true,
    dryRun: false,
    response: {
      status: res.statusCode,
      latencyMs,
      headers: redactor.redactHeaders(headers),
      assertions,
      scriptTests,
      captured,
      bodyHandle,
      redirects,
    },
  }
}
