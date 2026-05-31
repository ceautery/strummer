import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bruToEnvJsonV2, bruToJsonV2 } from '@usebruno/lang'
import { parse as parseYaml } from 'yaml'
import type {
  ApiRequest,
  AssertionSpec,
  CaptureSpec,
  Collection,
  RequestBody,
  RequestEntry,
} from './model.js'

// Collection/folder-level .bru files are settings, not requests.
const NON_REQUEST = new Set(['collection.bru', 'folder.bru'])
// Body types stored as a raw string under body.<key>.
const RAW_BODY_TYPES = new Set(['json', 'text', 'xml', 'sparql', 'graphql'])

interface BruBody {
  json?: string
  text?: string
  xml?: string
  sparql?: string
  graphql?: string
  formUrlEncoded?: { name: string; value: string; enabled?: boolean }[]
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
}

interface EnvJson {
  variables?: { name: string; value: string; enabled?: boolean; secret?: boolean }[]
}

/**
 * Load a Bruno collection directory: each `<name>.bru` request (+ optional
 * `<name>.strummer.yml` sidecar), plus any `environments/<Env>.bru` files.
 */
export function loadCollection(dir: string): Collection {
  const requests = new Map<string, RequestEntry>()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.bru') || NON_REQUEST.has(file)) continue
    const stem = basename(file, '.bru')
    const parsed = bruToJsonV2(readFileSync(join(dir, file), 'utf8')) as BruJson
    const request = toRequest(stem, parsed)

    let assertions: AssertionSpec[] = []
    let captures: CaptureSpec[] = []
    const sidecar = join(dir, `${stem}.strummer.yml`)
    if (existsSync(sidecar)) {
      const yaml = (parseYaml(readFileSync(sidecar, 'utf8')) ?? {}) as Sidecar
      assertions = yaml.assertions ?? []
      captures = yaml.captures ?? []
    }
    requests.set(stem, { request, assertions, captures })
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

function toBody(type: string | undefined, body: BruBody | undefined): RequestBody | undefined {
  if (!type || type === 'none') return undefined
  if (type === 'form-urlencoded') {
    const params = (body?.formUrlEncoded ?? [])
      .filter((p) => p.enabled !== false)
      .map((p) => ({ name: p.name, value: p.value }))
    return { type, params }
  }
  if (RAW_BODY_TYPES.has(type)) {
    const content = body?.[type as keyof BruBody]
    if (typeof content === 'string') return { type, content }
  }
  // Recognized but not yet materialized (multipart-form, file, …).
  return { type }
}
