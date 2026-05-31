import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { type Dispatcher, request } from 'undici'
import { ArtifactStore } from './artifacts.js'
import { evaluateAssertions, extractCaptures } from './assert.js'
import type { Collection, PreparedRequest, RunResult, ScriptTest, SecretStore } from './model.js'
import { prepareRequest } from './prepare.js'
import { checkGate } from './safety.js'
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

  const prepared = await prepareRequest(entry.request, scope, secrets, redactor)

  // Headers actually sent: add a default Content-Type for the body if unset.
  const sendHeaders = { ...prepared.headers }
  if (prepared.body && !hasHeader(sendHeaders, 'content-type')) {
    sendHeaders['Content-Type'] = prepared.body.contentType
  }

  const redactedRequest: PreparedRequest = {
    method: prepared.method,
    url: redactor.redact(prepared.url),
    headers: redactor.redactHeaders(sendHeaders),
    body: prepared.body ? redactor.redact(prepared.body.content) : undefined,
  }

  const gate = checkGate(prepared.method, hostOf(prepared.url), {
    allowUnsafe: opts.allowUnsafe,
    allowedHosts: opts.allowedHosts,
  })
  if (!gate.allowed) {
    return { request: redactedRequest, sent: false, dryRun: true, reason: gate.reason }
  }

  const started = performance.now()
  const res = await request(prepared.url, {
    method: prepared.method as Dispatcher.HttpMethod,
    headers: sendHeaders,
    body: prepared.body?.content,
  })
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
    },
  }
}
