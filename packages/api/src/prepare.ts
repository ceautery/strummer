import type { ApiRequest, RequestBody, SecretStore } from './model.js'
import type { Redactor } from './secrets.js'
import { interpolate } from './vars.js'

const SECRET_RE = /\{\{\s*secret:([^}\s]+)\s*\}\}/g

const RAW_CONTENT_TYPE: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  sparql: 'application/sparql-query',
  graphql: 'application/json',
}

export interface PreparedBody {
  contentType: string
  content: string
}

/** A request prepared for the wire — these strings carry REAL secret values. */
export interface Prepared {
  method: string
  url: string
  headers: Record<string, string>
  body?: PreparedBody
}

/**
 * Resolve `{{secret:NAME}}` (from the store, registered with the redactor) and
 * `{{var}}` (from the scope) across the URL, headers, AND body into the actual
 * values sent on the wire. Fails closed on an unresolved secret.
 */
export async function prepareRequest(
  request: ApiRequest,
  scope: Record<string, unknown>,
  secrets: SecretStore,
  redactor: Redactor,
): Promise<Prepared> {
  const texts = [request.url, ...request.headers.map((h) => h.value), ...bodyTexts(request.body)]
  const fillSecrets = await secretFiller(texts, secrets, redactor)
  const fill = (text: string) => interpolate(fillSecrets(text), scope)

  const headers: Record<string, string> = {}
  for (const header of request.headers) headers[header.name] = fill(header.value)
  return {
    method: request.method,
    url: fill(request.url),
    headers,
    body: materializeBody(request.body, fill),
  }
}

/** The interpolatable strings inside a body (for secret scanning). */
function bodyTexts(body: RequestBody | undefined): string[] {
  if (!body) return []
  if (body.content !== undefined) return [body.content]
  return (body.params ?? []).map((p) => p.value)
}

function materializeBody(
  body: RequestBody | undefined,
  fill: (text: string) => string,
): PreparedBody | undefined {
  if (!body || body.type === 'none') return undefined
  if (body.type === 'form-urlencoded') {
    const params = new URLSearchParams()
    for (const p of body.params ?? []) params.append(p.name, fill(p.value))
    return { contentType: 'application/x-www-form-urlencoded', content: params.toString() }
  }
  if (body.content !== undefined) {
    return { contentType: RAW_CONTENT_TYPE[body.type] ?? 'text/plain', content: fill(body.content) }
  }
  // Unsupported body type (multipart-form, file, …) — nothing to send yet.
  return undefined
}

async function secretFiller(
  texts: string[],
  secrets: SecretStore,
  redactor: Redactor,
): Promise<(text: string) => string> {
  const names = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(SECRET_RE)) names.add(match[1] as string)
  }

  const resolved = new Map<string, string>()
  const missing: string[] = []
  for (const name of names) {
    const value = await secrets.get(name)
    if (value === undefined) {
      missing.push(name)
      continue
    }
    resolved.set(name, value)
    redactor.register(name, value)
  }
  if (missing.length > 0) {
    throw new Error(`missing secret(s): ${missing.join(', ')}`)
  }

  return (text) =>
    text.replace(SECRET_RE, (_m, name: string) => resolved.get(name) ?? `{{secret:${name}}}`)
}
