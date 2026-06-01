/**
 * Import foreign API-collection formats into a Bruno `.bru` collection on disk.
 *
 * Supported sources: **Postman** (v2.1 collection), **Insomnia** (v4 export),
 * **OpenAPI** (3.x — one request per operation, + an environment for the server
 * URL), and **HAR** (one request per logged entry). Each is normalized to a small
 * intermediate shape and serialized with `@usebruno/lang`'s `jsonToBruV2`, so the
 * output is a real Bruno collection that `loadCollection` reads back.
 *
 * Scope: method, URL, headers, and the common body types (json/text/xml +
 * form-urlencoded + graphql). multipart/file bodies are noted but not emitted
 * (no portable on-disk file to point at); auth blocks beyond a bearer/`{{var}}`
 * header are left to the operator. `{{var}}` templating passes through unchanged
 * (Postman/Bruno share the syntax).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envJsonToBruV2, jsonToBruV2 } from '@usebruno/lang'
import { parse as parseYaml } from 'yaml'

export type ImportFormat = 'postman' | 'insomnia' | 'openapi' | 'har'

/** Normalized request, format-agnostic. */
export interface ImportedRequest {
  name: string
  method: string
  url: string
  headers: { name: string; value: string }[]
  body?: ImportedBody
}

export interface ImportedBody {
  /** Canonical body type: json | text | xml | form-urlencoded | graphql. */
  type: string
  /** Raw content (json/text/xml). */
  content?: string
  /** form-urlencoded params. */
  params?: { name: string; value: string }[]
  /** graphql query + variables. */
  graphql?: { query: string; variables?: string }
}

export interface ImportResult {
  requests: ImportedRequest[]
  /** A discovered environment (e.g. OpenAPI `servers[0]`), if any. */
  environment?: { name: string; variables: Record<string, string> }
}

// ---------------------------------------------------------------------------
// Source parsers
// ---------------------------------------------------------------------------

interface NameValue {
  name?: string
  key?: string
  value?: string
  disabled?: boolean
  enabled?: boolean
}

function headersFrom(list: NameValue[] | undefined): { name: string; value: string }[] {
  return (list ?? [])
    .filter((h) => h.disabled !== true && h.enabled !== false)
    .map((h) => ({ name: h.name ?? h.key ?? '', value: h.value ?? '' }))
    .filter((h) => h.name)
}

/** Postman v2.1 collection → requests (folders flattened, depth-first). */
export function importPostman(doc: unknown): ImportResult {
  const root = doc as { item?: unknown[] }
  const requests: ImportedRequest[] = []

  const walk = (items: unknown[] | undefined): void => {
    for (const raw of items ?? []) {
      const item = raw as { name?: string; item?: unknown[]; request?: unknown }
      if (item.item) {
        walk(item.item) // folder
        continue
      }
      if (!item.request) continue
      const req = item.request as {
        method?: string
        header?: NameValue[]
        url?: string | { raw?: string }
        body?: PostmanBody
      }
      const url = typeof req.url === 'string' ? req.url : (req.url?.raw ?? '')
      requests.push({
        name: item.name ?? `${req.method ?? 'GET'} ${url}`,
        method: (req.method ?? 'GET').toUpperCase(),
        url,
        headers: headersFrom(req.header),
        body: postmanBody(req.body),
      })
    }
  }
  walk(root.item)
  return { requests }
}

interface PostmanBody {
  mode?: string
  raw?: string
  urlencoded?: NameValue[]
  graphql?: { query?: string; variables?: string }
  options?: { raw?: { language?: string } }
}

function postmanBody(body: PostmanBody | undefined): ImportedBody | undefined {
  if (!body || !body.mode) return undefined
  if (body.mode === 'raw') {
    const lang = body.options?.raw?.language
    const type = lang === 'json' || lang === 'xml' ? lang : 'text'
    return { type, content: body.raw ?? '' }
  }
  if (body.mode === 'urlencoded') {
    return { type: 'form-urlencoded', params: kvParams(body.urlencoded) }
  }
  if (body.mode === 'graphql') {
    return {
      type: 'graphql',
      graphql: { query: body.graphql?.query ?? '', variables: body.graphql?.variables },
    }
  }
  return undefined // formdata/file: not portable on import
}

function kvParams(list: NameValue[] | undefined): { name: string; value: string }[] {
  return (list ?? [])
    .filter((p) => p.disabled !== true && p.enabled !== false)
    .map((p) => ({ name: p.name ?? p.key ?? '', value: p.value ?? '' }))
}

/** Insomnia v4 export → requests. */
export function importInsomnia(doc: unknown): ImportResult {
  const resources = (doc as { resources?: unknown[] }).resources ?? []
  const requests: ImportedRequest[] = []
  for (const raw of resources) {
    const r = raw as {
      _type?: string
      name?: string
      method?: string
      url?: string
      headers?: NameValue[]
      body?: { mimeType?: string; text?: string; params?: NameValue[] }
    }
    if (r._type !== 'request') continue
    requests.push({
      name: r.name ?? `${r.method ?? 'GET'} ${r.url ?? ''}`,
      method: (r.method ?? 'GET').toUpperCase(),
      url: r.url ?? '',
      headers: headersFrom(r.headers),
      body: insomniaBody(r.body),
    })
  }
  return { requests }
}

function insomniaBody(
  body: { mimeType?: string; text?: string; params?: NameValue[] } | undefined,
): ImportedBody | undefined {
  if (!body || !body.mimeType) return undefined
  if (body.mimeType.includes('json')) return { type: 'json', content: body.text ?? '' }
  if (body.mimeType.includes('xml')) return { type: 'xml', content: body.text ?? '' }
  if (body.mimeType.includes('x-www-form-urlencoded')) {
    return { type: 'form-urlencoded', params: kvParams(body.params) }
  }
  if (body.text) return { type: 'text', content: body.text }
  return undefined
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'])

/** OpenAPI 3.x → one request per operation + an environment for the server URL. */
export function importOpenApi(doc: unknown): ImportResult {
  const spec = doc as {
    paths?: Record<string, Record<string, unknown>>
    servers?: { url?: string }[]
  }
  const requests: ImportedRequest[] = []
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!item || typeof item !== 'object') continue
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue
      const operation = op as { operationId?: string; requestBody?: OpenApiRequestBody }
      requests.push({
        name: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: `{{baseUrl}}${path}`,
        headers: [],
        body: openApiBody(operation.requestBody),
      })
    }
  }
  const serverUrl = spec.servers?.[0]?.url
  const environment = serverUrl
    ? { name: 'Imported', variables: { baseUrl: serverUrl } }
    : undefined
  return { requests, environment }
}

interface OpenApiRequestBody {
  content?: Record<string, { example?: unknown; schema?: unknown }>
}

function openApiBody(rb: OpenApiRequestBody | undefined): ImportedBody | undefined {
  const json = rb?.content?.['application/json']
  if (!json) return undefined
  // Prefer a provided example; otherwise an empty JSON object stub.
  const example = json.example ?? {}
  return { type: 'json', content: JSON.stringify(example, null, 2) }
}

/** HAR → one request per logged entry. */
export function importHar(doc: unknown): ImportResult {
  const entries = (doc as { log?: { entries?: unknown[] } }).log?.entries ?? []
  const requests: ImportedRequest[] = []
  entries.forEach((raw, i) => {
    const req = (raw as { request?: unknown }).request as
      | {
          method?: string
          url?: string
          headers?: NameValue[]
          postData?: { mimeType?: string; text?: string; params?: NameValue[] }
        }
      | undefined
    if (!req) return
    let label = req.url ?? ''
    try {
      label = new URL(req.url ?? '').pathname
    } catch {}
    requests.push({
      name: `${(req.method ?? 'GET').toUpperCase()} ${label} #${i + 1}`,
      method: (req.method ?? 'GET').toUpperCase(),
      url: req.url ?? '',
      headers: headersFrom(req.headers),
      body: insomniaBody(req.postData), // same {mimeType,text,params} shape
    })
  })
  return { requests }
}

const PARSERS: Record<ImportFormat, (doc: unknown) => ImportResult> = {
  postman: importPostman,
  insomnia: importInsomnia,
  openapi: importOpenApi,
  har: importHar,
}

/** Parse a source document (JSON, or YAML for OpenAPI) into normalized requests. */
export function parseImport(format: ImportFormat, source: string): ImportResult {
  const doc = format === 'openapi' ? parseYaml(source) : JSON.parse(source)
  return PARSERS[format](doc)
}

// ---------------------------------------------------------------------------
// .bru serialization
// ---------------------------------------------------------------------------

/** Map our canonical body type to the `@usebruno/lang` discriminator + payload. */
function bruBody(body: ImportedBody): { discriminator: string; body: Record<string, unknown> } {
  if (body.type === 'form-urlencoded') {
    return {
      discriminator: 'formUrlEncoded',
      body: {
        formUrlEncoded: (body.params ?? []).map((p) => ({ ...p, enabled: true })),
      },
    }
  }
  if (body.type === 'graphql') {
    return {
      discriminator: 'graphql',
      body: { graphql: { query: body.graphql?.query ?? '', variables: body.graphql?.variables } },
    }
  }
  // raw types
  return { discriminator: body.type, body: { [body.type]: body.content ?? '' } }
}

function toBruJson(req: ImportedRequest, seq: number): Record<string, unknown> {
  const http: Record<string, unknown> = {
    method: req.method.toLowerCase(),
    url: req.url,
    auth: 'none',
  }
  let body: Record<string, unknown> = {}
  if (req.body) {
    const mapped = bruBody(req.body)
    http.body = mapped.discriminator
    body = mapped.body
  }
  return {
    meta: { name: req.name, type: 'http', seq },
    http,
    headers: req.headers.map((h) => ({ ...h, enabled: true })),
    body,
  }
}

/** Sanitize a request name into a unique `.bru` filename stem. */
function fileStem(name: string, used: Set<string>): string {
  const base =
    name
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'request'
  let stem = base
  let n = 2
  while (used.has(stem)) stem = `${base}-${n++}`
  used.add(stem)
  return stem
}

export interface WriteOptions {
  /** Collection name written to `bruno.json`. */
  name?: string
}

/**
 * Write a normalized import to `destDir` as a Bruno collection: `bruno.json`, a
 * `<name>.bru` per request, and (if present) an `environments/<env>.bru`. Returns
 * the request count written.
 */
export function writeImported(
  destDir: string,
  result: ImportResult,
  opts: WriteOptions = {},
): number {
  mkdirSync(destDir, { recursive: true })
  writeFileSync(
    join(destDir, 'bruno.json'),
    `${JSON.stringify({ version: '1', name: opts.name ?? 'imported', type: 'collection' }, null, 2)}\n`,
  )

  const used = new Set<string>()
  result.requests.forEach((req, i) => {
    const stem = fileStem(req.name, used)
    writeFileSync(join(destDir, `${stem}.bru`), jsonToBruV2(toBruJson(req, i + 1)))
  })

  if (result.environment) {
    mkdirSync(join(destDir, 'environments'), { recursive: true })
    const variables = Object.entries(result.environment.variables).map(([name, value]) => ({
      name,
      value,
      enabled: true,
    }))
    writeFileSync(
      join(destDir, 'environments', `${fileStem(result.environment.name, new Set())}.bru`),
      envJsonToBruV2({ variables }),
    )
  }
  return result.requests.length
}

/** One-shot: parse a source document and write the Bruno collection to disk. */
export function importToCollection(
  format: ImportFormat,
  source: string,
  destDir: string,
  opts: WriteOptions = {},
): number {
  return writeImported(destDir, parseImport(format, source), opts)
}
