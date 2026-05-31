import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { type Dispatcher, request } from 'undici'
import { ArtifactStore } from './artifacts.js'
import { evaluateAssertions } from './assert.js'
import type { Collection, PreparedRequest, RunResult, SecretStore } from './model.js'
import { prepareRequest } from './prepare.js'
import { checkGate } from './safety.js'
import { EnvSecretStore, Redactor } from './secrets.js'

export interface RunOptions {
  /** Variable scope for `{{var}}` interpolation. */
  vars?: Record<string, unknown>
  /** Secret store for `{{secret:NAME}}` resolution (defaults to env). */
  secrets?: SecretStore
  /** Artifact store for the response body (a fresh one is used if omitted). */
  artifacts?: ArtifactStore
  /** Opt in to actually sending mutating requests. */
  allowUnsafe?: boolean
  /** Hostnames a mutating request may reach. */
  allowedHosts?: string[]
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
  const prepared = await prepareRequest(entry.request, opts.vars ?? {}, secrets, redactor)

  const redactedRequest: PreparedRequest = {
    method: prepared.method,
    url: redactor.redact(prepared.url),
    headers: redactor.redactHeaders(prepared.headers),
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
    headers: prepared.headers,
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

  // Assertions evaluate the REAL response; only surfaced strings are redacted.
  const assertions = evaluateAssertions(entry.assertions, {
    status: res.statusCode,
    statusText: '',
    headers,
    bodyText,
    json,
    latencyMs,
  })

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
      captured: {},
      bodyHandle,
    },
  }
}
