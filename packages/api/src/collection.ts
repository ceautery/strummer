import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bruToEnvJsonV2, bruToJsonV2 } from '@usebruno/lang'
import { parse as parseYaml } from 'yaml'
import type {
  ApiRequest,
  AssertionSpec,
  CaptureSpec,
  Collection,
  MultipartPart,
  RequestBody,
  RequestEntry,
} from './model.js'

// Collection/folder-level .bru files are settings, not requests.
const NON_REQUEST = new Set(['collection.bru', 'folder.bru'])
// Body types stored as a raw string under body.<key>.
const RAW_BODY_TYPES = new Set(['json', 'text', 'xml', 'sparql'])
// `@usebruno/lang` discriminators (camelCase) → our canonical body-type names.
const BODY_TYPE_ALIASES: Record<string, string> = {
  formUrlEncoded: 'form-urlencoded',
  multipartForm: 'multipart-form',
}

interface BruMultipartPart {
  name: string
  value: string | string[]
  enabled?: boolean
  type?: 'text' | 'file'
  contentType?: string
}

interface BruFilePart {
  filePath: string
  contentType?: string
  selected?: boolean
}

interface BruBody {
  json?: string
  text?: string
  xml?: string
  sparql?: string
  graphql?: { query?: string; variables?: string }
  formUrlEncoded?: { name: string; value: string; enabled?: boolean }[]
  multipartForm?: BruMultipartPart[]
  file?: BruFilePart[]
}

interface BruJson {
  meta?: { name?: string }
  http?: { method?: string; url?: string; body?: string }
  headers?: { name: string; value: string; enabled?: boolean }[]
  body?: BruBody
}

interface Sidecar {
  assertions?: AssertionSpec[]
  captures?: CaptureSpec[]
  preScript?: string
  postScript?: string
}

interface EnvJson {
  variables?: { name: string; value: string; enabled?: boolean; secret?: boolean }[]
}

/**
 * Load a Bruno collection directory: each `<name>.bru` request (+ optional
 * `<name>.sackville.yml` sidecar), plus any `environments/<Env>.bru` files.
 */
export function loadCollection(dir: string): Collection {
  const requests = new Map<string, RequestEntry>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.bru') || NON_REQUEST.has(file)) continue
    const stem = basename(file, '.bru')
    const parsed = bruToJsonV2(readFileSync(join(dir, file), 'utf8')) as BruJson
    const request = toRequest(stem, parsed)

    const entry: RequestEntry = { request, assertions: [], captures: [] }
    const sidecar = join(dir, `${stem}.sackville.yml`)
    if (existsSync(sidecar)) {
      const yaml = (parseYaml(readFileSync(sidecar, 'utf8')) ?? {}) as Sidecar
      entry.assertions = yaml.assertions ?? []
      entry.captures = yaml.captures ?? []
      entry.preScript = yaml.preScript
      entry.postScript = yaml.postScript
    }
    requests.set(stem, entry)
  }
  return { dir, requests, environments: loadEnvironments(dir) }
}

function loadEnvironments(dir: string): Map<string, Record<string, string>> {
  const environments = new Map<string, Record<string, string>>()
  const envDir = join(dir, 'environments')
  if (!existsSync(envDir)) return environments
  for (const file of readdirSync(envDir)) {
    if (!file.endsWith('.bru')) continue
    const parsed = bruToEnvJsonV2(readFileSync(join(envDir, file), 'utf8')) as EnvJson
    const vars: Record<string, string> = {}
    for (const v of parsed.variables ?? []) {
      // Skip disabled and secret-marked vars (real secrets come from the SecretStore).
      if (v.enabled !== false && !v.secret) vars[v.name] = v.value
    }
    environments.set(basename(file, '.bru'), vars)
  }
  return environments
}

function toRequest(stem: string, parsed: BruJson): ApiRequest {
  const http = parsed.http ?? {}
  const headers = (parsed.headers ?? [])
    .filter((h) => h.enabled !== false)
    .map((h) => ({ name: h.name, value: h.value }))
  return {
    name: parsed.meta?.name ?? stem,
    method: String(http.method ?? 'get').toUpperCase(),
    url: http.url ?? '',
    headers,
    body: toBody(http.body, parsed.body),
  }
}

function toBody(rawType: string | undefined, body: BruBody | undefined): RequestBody | undefined {
  if (!rawType || rawType === 'none') return undefined
  // Normalize the parser's camelCase discriminator to our canonical name.
  const type = BODY_TYPE_ALIASES[rawType] ?? rawType

  if (type === 'form-urlencoded') {
    const params = (body?.formUrlEncoded ?? [])
      .filter((p) => p.enabled !== false)
      .map((p) => ({ name: p.name, value: p.value }))
    return { type, params }
  }
  if (type === 'graphql') {
    const gql = body?.graphql
    return { type, graphql: { query: gql?.query ?? '', variables: gql?.variables } }
  }
  if (type === 'multipart-form') {
    return { type, parts: toParts(body?.multipartForm ?? []) }
  }
  if (type === 'file') {
    const selected = (body?.file ?? []).find((f) => f.selected !== false) ?? body?.file?.[0]
    if (selected) {
      return { type, file: { filePath: selected.filePath, contentType: selected.contentType } }
    }
    return { type }
  }
  if (RAW_BODY_TYPES.has(type)) {
    const content = body?.[type as keyof BruBody]
    if (typeof content === 'string') return { type, content }
  }
  // Recognized but with no payload to materialize.
  return { type }
}

function toParts(parts: BruMultipartPart[]): MultipartPart[] {
  return parts
    .filter((p) => p.enabled !== false)
    .map((p) => {
      if (p.type === 'file') {
        const filePaths = Array.isArray(p.value) ? p.value : [p.value]
        return {
          name: p.name,
          kind: 'file' as const,
          filePaths,
          contentType: p.contentType || undefined,
        }
      }
      const value = Array.isArray(p.value) ? (p.value[0] ?? '') : p.value
      return { name: p.name, kind: 'text' as const, value }
    })
}
