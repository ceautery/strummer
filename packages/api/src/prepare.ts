import type { ApiRequest, SecretStore } from './model.js'
import type { Redactor } from './secrets.js'
import { interpolate } from './vars.js'

const SECRET_RE = /\{\{\s*secret:([^}\s]+)\s*\}\}/g

/** A request prepared for the wire — these strings carry REAL secret values. */
export interface Prepared {
  method: string
  url: string
  headers: Record<string, string>
}

/**
 * Resolve `{{secret:NAME}}` (from the store, registered with the redactor) and
 * `{{var}}` (from the scope) into the actual values sent on the wire. Fails
 * closed: a referenced secret that can't be resolved aborts the run rather than
 * sending an unresolved placeholder.
 */
export async function prepareRequest(
  request: ApiRequest,
  scope: Record<string, unknown>,
  secrets: SecretStore,
  redactor: Redactor,
): Promise<Prepared> {
  const fillSecrets = await secretFiller(request, secrets, redactor)
  const fill = (text: string) => interpolate(fillSecrets(text), scope)

  const headers: Record<string, string> = {}
  for (const header of request.headers) headers[header.name] = fill(header.value)
  return { method: request.method, url: fill(request.url), headers }
}

async function secretFiller(
  request: ApiRequest,
  secrets: SecretStore,
  redactor: Redactor,
): Promise<(text: string) => string> {
  const names = new Set<string>()
  for (const text of [request.url, ...request.headers.map((h) => h.value)]) {
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
