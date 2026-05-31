import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { bruToJsonV2 } from '@usebruno/lang'
import { parse as parseYaml } from 'yaml'
import type { ApiRequest, AssertionSpec, CaptureSpec, Collection, RequestEntry } from './model.js'

// Collection/folder-level .bru files are settings, not requests.
const NON_REQUEST = new Set(['collection.bru', 'folder.bru'])

interface BruJson {
  meta?: { name?: string }
  http?: { method?: string; url?: string }
  headers?: { name: string; value: string; enabled?: boolean }[]
}

interface Sidecar {
  assertions?: AssertionSpec[]
  captures?: CaptureSpec[]
}

/**
 * Load a Bruno collection directory into the domain model. Each `<name>.bru`
 * request is paired with its optional `<name>.strummer.yml` sidecar (Strummer's
 * declarative assertions/captures). Requests are keyed by file stem.
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
  return { dir, requests }
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
  }
}
