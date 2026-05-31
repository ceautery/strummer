import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { type Dispatcher, request } from 'undici'
import { ArtifactStore } from './artifacts.js'
import { evaluateAssertions } from './assert.js'
import type { Collection, RunResult } from './model.js'
import { interpolate } from './vars.js'

export interface RunOptions {
  /** Variable scope for `{{var}}` interpolation. */
  vars?: Record<string, unknown>
  /** Artifact store for the response body (a fresh one is used if omitted). */
  artifacts?: ArtifactStore
}

/**
 * Execute one request from a collection: interpolate variables, dispatch via
 * undici, capture status/headers/body/timing, evaluate declarative assertions,
 * and store the body behind a resource handle. (Secrets, mutation gating, and
 * scripts layer on next.)
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
  const scope = opts.vars ?? {}
  const url = interpolate(entry.request.url, scope)
  const headers: Record<string, string> = {}
  for (const header of entry.request.headers) {
    headers[header.name] = interpolate(header.value, scope)
  }

  const started = performance.now()
  const res = await request(url, {
    method: entry.request.method as Dispatcher.HttpMethod,
    headers,
  })
  const bodyText = await res.body.text()
  const latencyMs = performance.now() - started

  const flatHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(res.headers)) {
    flatHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '')
  }

  let json: unknown
  try {
    json = JSON.parse(bodyText)
  } catch {
    json = undefined
  }

  const assertions = evaluateAssertions(entry.assertions, {
    status: res.statusCode,
    statusText: '',
    headers: flatHeaders,
    bodyText,
    json,
    latencyMs,
  })

  const store = opts.artifacts ?? new ArtifactStore()
  const bodyHandle = store.put(
    randomUUID(),
    bodyText,
    flatHeaders['content-type'] ?? 'application/octet-stream',
  )

  return {
    status: res.statusCode,
    latencyMs,
    headers: flatHeaders,
    assertions,
    captured: {},
    bodyHandle,
  }
}
