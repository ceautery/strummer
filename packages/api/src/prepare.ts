import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { FormData } from 'undici'
import type { ApiRequest, RequestBody, SecretStore } from './model.js'
import type { Redactor } from './secrets.js'
import { interpolate } from './vars.js'

const SECRET_RE = /\{\{\s*secret:([^}\s]+)\s*\}\}/g

const RAW_CONTENT_TYPE: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  sparql: 'application/sparql-query',
}

export interface PreparedBody {
  /** Content-Type to set when the request carries none; `undefined` lets undici
   * set it itself (e.g. multipart, which needs a generated boundary). */
  contentType?: string
  /** The payload handed to undici. */
  content: string | Buffer | FormData
  /** A redaction-safe textual rendering of the body for agent-facing output
   * (binary/file content is summarized, never inlined). */
  preview: string
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
  baseDir?: string,
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
    body: await materializeBody(request.body, fill, baseDir),
  }
}

/** The interpolatable strings inside a body (for secret scanning). */
function bodyTexts(body: RequestBody | undefined): string[] {
  if (!body) return []
  if (body.type === 'graphql') {
    const g = body.graphql
    return g ? [g.query, ...(g.variables ? [g.variables] : [])] : []
  }
  if (body.type === 'multipart-form') {
    return (body.parts ?? []).flatMap((p) =>
      p.kind === 'file' ? (p.filePaths ?? []) : [p.value ?? ''],
    )
  }
  if (body.type === 'file') return body.file ? [body.file.filePath] : []
  if (body.content !== undefined) return [body.content]
  return (body.params ?? []).map((p) => p.value)
}

async function materializeBody(
  body: RequestBody | undefined,
  fill: (text: string) => string,
  baseDir?: string,
): Promise<PreparedBody | undefined> {
  if (!body || body.type === 'none') return undefined
  if (body.type === 'form-urlencoded') {
    const params = new URLSearchParams()
    for (const p of body.params ?? []) params.append(p.name, fill(p.value))
    const content = params.toString()
    return { contentType: 'application/x-www-form-urlencoded', content, preview: content }
  }
  if (body.type === 'graphql') {
    const content = materializeGraphql(body.graphql, fill)
    return { contentType: 'application/json', content, preview: content }
  }
  if (body.type === 'multipart-form') {
    return materializeMultipart(body, fill, baseDir)
  }
  if (body.content !== undefined) {
    const content = fill(body.content)
    return { contentType: RAW_CONTENT_TYPE[body.type] ?? 'text/plain', content, preview: content }
  }
  // Recognized body type with no payload to materialize.
  return undefined
}

/**
 * A `multipart/form-data` body. Text parts carry interpolated values; file parts
 * read their bytes from disk (paths resolved against the collection dir — the
 * `.bru` is operator-authored config, and egress is separately gated, so paths
 * are not sandboxed here). undici mints the boundary, so `contentType` is left
 * unset. The preview summarizes parts (file by name + byte size), never inlining
 * file bytes; text values flow through the redactor at the surface.
 */
async function materializeMultipart(
  body: RequestBody,
  fill: (text: string) => string,
  baseDir?: string,
): Promise<PreparedBody> {
  const form = new FormData()
  const lines = ['multipart/form-data:']
  for (const part of body.parts ?? []) {
    if (part.kind === 'file') {
      for (const rawPath of part.filePaths ?? []) {
        const filled = fill(rawPath)
        const buf = await readFile(resolve(baseDir ?? '', filled))
        const blob = new Blob([buf], part.contentType ? { type: part.contentType } : {})
        form.append(part.name, blob as unknown as Blob, basename(filled))
        lines.push(`  ${part.name} (file): ${filled} (${buf.byteLength} bytes)`)
      }
    } else {
      const value = fill(part.value ?? '')
      form.append(part.name, value)
      lines.push(`  ${part.name} (text): ${value}`)
    }
  }
  return { content: form, preview: lines.join('\n') }
}

/** A GraphQL-over-HTTP envelope: `{query, variables}` as JSON. Variables (a JSON
 * string in the `.bru`) are interpolated then parsed into an object; an empty or
 * whitespace-only variables block is omitted. */
function materializeGraphql(
  graphql: { query: string; variables?: string } | undefined,
  fill: (text: string) => string,
): string {
  const query = fill(graphql?.query ?? '')
  const rawVars = graphql?.variables?.trim()
  if (!rawVars) return JSON.stringify({ query })
  const filled = fill(rawVars)
  let variables: unknown
  try {
    variables = JSON.parse(filled)
  } catch (e) {
    throw new Error(`invalid graphql variables JSON: ${(e as Error).message}`)
  }
  return JSON.stringify({ query, variables })
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
