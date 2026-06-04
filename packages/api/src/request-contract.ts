/**
 * OpenAPI 3.1 (and 3.0-compat) REQUEST-side contract validation — the sibling of
 * `validateOpenApiResponse` (see ADR 0005; this milestone's design = the
 * request-contract-validation-design fan-out). It validates the request half of an
 * exchange against the declared operation: the request body against `requestBody`,
 * and parameters against `parameters` (path/query/header). It reuses the response
 * validator's extracted seams (`resolveOpenApiOperation`, `normalizeOpenApiSchema`)
 * so operation resolution and schema treatment (3.0 `nullable` shim, local +
 * external-local-file `$ref` deref) are identical across both halves.
 *
 * **Authority + the `unverified` channel (load-bearing, ADR 0013 absence-is-never-
 * a-pass):** some request facts cannot be verified from every source. A captured HAR
 * cannot distinguish "no body" from "a non-JSON body the bridge dropped", and cannot
 * always supply query/header params. So callers declare what they KNOW:
 * `bodyPresenceAuthoritative` / `paramsAuthoritative` (true for direct MCP/CLI
 * surfaces that hold the real request; false/omitted for the capture path). When a
 * required-but-absent body/param CANNOT be asserted as a breach (caller not
 * authoritative), or a present body could not be schema-checked, the result carries
 * `unverified: true` — NOT a finding — which the capture bridge folds into `noSignal`
 * so it can never be laundered into a pass.
 */
import {
  normalizeOpenApiSchema,
  type OpenApiDoc,
  type OpenApiValidateOptions,
  resolveOpenApiOperation,
} from './contract.js'
import type { ContractFinding, ContractResult } from './model.js'
import { validateSchema } from './schema.js'

/** The request facts a validator reads. `path` is the pathname only (matches
 * `CaptureEntry.req.path`); `body` is the already-parsed JSON body. */
export interface RequestFacts {
  method: string
  path: string
  body?: unknown
  query?: Record<string, string | string[]>
  /** Lower-cased header names → value. */
  headers?: Record<string, string>
}

export interface OpenApiRequestValidateOptions extends OpenApiValidateOptions {
  /** Caller KNOWS body presence/absence is authoritative (direct surfaces). Default
   * false: an absent required body is `unverified`, not `missing-required-body`. */
  bodyPresenceAuthoritative?: boolean
  /** Caller KNOWS query/header facts are complete (direct surfaces). Default false:
   * an absent required query/header param is `unverified`, not a finding. */
  paramsAuthoritative?: boolean
}

export interface RequestValidationResult extends ContractResult {
  /** A body/param the validator could not verify and the caller is not authoritative
   * about. The capture bridge folds this into `noSignal` (never a finding, never a
   * pass). Omitted when everything relevant was verifiable. */
  unverified?: boolean
}

/** True when a parsed body looks like a GraphQL-over-HTTP envelope (`{query: string,
 * …}`). A direct surface uses this to refuse running OpenAPI body validation on a
 * GraphQL request (which has no REST requestBody shape) — H4. */
export function isGraphqlEnvelope(body: unknown): boolean {
  return (
    !!body && typeof body === 'object' && typeof (body as { query?: unknown }).query === 'string'
  )
}

/** Lower-cased media-type base (sans parameters), e.g. `application/json`. */
function mediaBase(ct: string): string {
  return (ct.split(';')[0] ?? '').trim().toLowerCase()
}

/** JSON-family media type: `application/json` or any `*+json` (e.g. `application/ld+json`). */
function isJsonMediaType(ct: string): boolean {
  const base = mediaBase(ct)
  return base === 'application/json' || base.endsWith('+json')
}

interface RequestBodyObject {
  required?: boolean
  content?: Record<string, { schema?: unknown }>
}

interface ParamObject {
  name?: string
  in?: string
  required?: boolean
  schema?: unknown
  style?: string
  explode?: boolean
  content?: unknown
  $ref?: string
  [key: string]: unknown
}

/** Merge path-item-level + operation-level `parameters`, operation winning on
 * `(name, in)`. Returns raw params (a `$ref` param is handled by the caller). */
function mergeParameters(pathItem: Record<string, unknown>, operation: object): ParamObject[] {
  const collect = (x: unknown): ParamObject[] => {
    const ps = (x as { parameters?: unknown })?.parameters
    return Array.isArray(ps) ? (ps as ParamObject[]) : []
  }
  const map = new Map<string, ParamObject>()
  let i = 0
  for (const p of [...collect(pathItem), ...collect(operation)]) {
    if (!p || typeof p !== 'object') continue
    // $ref params (slice 1/2: not deref'd) get a unique key so they survive the merge.
    const key =
      typeof p.name === 'string' && typeof p.in === 'string' ? `${p.in}:${p.name}` : `#ref${i++}`
    map.set(key, p)
  }
  return [...map.values()]
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

/** The scalar JSON types of a (normalized) schema, or `undefined` when the schema
 * is non-scalar / typeless (array/object params are STAGED → inconclusive-skip). */
function scalarTypes(schema: Record<string, unknown>): string[] | undefined {
  const t = schema.type
  if (typeof t === 'string') return SCALAR_TYPES.has(t) ? [t] : undefined
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null')
    return nonNull.length > 0 && nonNull.every((x) => SCALAR_TYPES.has(x as string))
      ? (t as string[])
      : undefined
  }
  return undefined
}

/** v1 supports only the DEFAULT scalar serialization per location (path/header
 * `simple`, query `form`); anything else (deepObject/pipeDelimited/cookie/
 * content-typed) is STAGED → inconclusive-skip. */
function styleSupported(param: ParamObject): boolean {
  if (param.content) return false
  switch (param.in) {
    case 'query':
      return param.style === undefined || param.style === 'form'
    case 'header':
    case 'path':
      return param.style === undefined || param.style === 'simple'
    default:
      return false // cookie + anything unknown
  }
}

/** Strict scalar coercion of a captured string value to a declared scalar type.
 * Numeric/boolean must match the WHOLE string (no residue); an empty value coerces
 * to `null` only when the type union allows it. Never touches the shared ajv. */
function coerceScalar(raw: string, types: string[]): { ok: true; value: unknown } | { ok: false } {
  if (raw === '' && types.includes('null')) return { ok: true, value: null }
  for (const t of types) {
    if (t === 'string') return { ok: true, value: raw }
    if (t === 'integer' && /^[+-]?\d+$/.test(raw)) return { ok: true, value: Number(raw) }
    if (t === 'number' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)) {
      return { ok: true, value: Number(raw) }
    }
    if (t === 'boolean') {
      if (raw === 'true') return { ok: true, value: true }
      if (raw === 'false') return { ok: true, value: false }
    }
  }
  return { ok: false }
}

/** Positionally extract path-template params from the concrete path. A segment that
 * embeds a param but is not EXACTLY `{name}` (e.g. `{name}.{ext}`) cannot be split
 * positionally → its params are `skipped` (inconclusive, never a false-fail). */
function extractPathParams(
  template: string,
  concrete: string,
): { values: Map<string, string>; skipped: Set<string> } {
  const tSegs = template.split('/')
  const cSegs = (concrete.split('?')[0] ?? '').split('/')
  const values = new Map<string, string>()
  const skipped = new Set<string>()
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i] ?? ''
    const exact = t.match(/^\{([^}]+)\}$/)
    if (exact?.[1]) {
      const raw = cSegs[i]
      if (raw !== undefined) {
        let decoded = raw
        try {
          decoded = decodeURIComponent(raw)
        } catch {
          /* keep raw on malformed encoding */
        }
        values.set(exact[1], decoded)
      }
    } else if (t.includes('{')) {
      for (const m of t.matchAll(/\{([^}]+)\}/g)) if (m[1]) skipped.add(m[1])
    }
  }
  return { values, skipped }
}

type ParamLookup = { state: 'present'; value: string } | { state: 'absent' } | { state: 'multi' } // array/repeated/embedded → STAGED skip

function lookupParamValue(
  param: ParamObject,
  req: RequestFacts,
  pathVals: { values: Map<string, string>; skipped: Set<string> },
): ParamLookup {
  const name = param.name as string
  if (param.in === 'path') {
    if (pathVals.skipped.has(name)) return { state: 'multi' }
    const v = pathVals.values.get(name)
    return v === undefined ? { state: 'absent' } : { state: 'present', value: v }
  }
  if (param.in === 'query') {
    const q = req.query?.[name]
    if (q === undefined) return { state: 'absent' }
    if (Array.isArray(q))
      return q.length === 1 && q[0] !== undefined
        ? { state: 'present', value: q[0] }
        : { state: 'multi' }
    return { state: 'present', value: q }
  }
  if (param.in === 'header') {
    const h = req.headers?.[name.toLowerCase()]
    return h === undefined ? { state: 'absent' } : { state: 'present', value: h }
  }
  return { state: 'absent' }
}

/**
 * Resolve a LOCAL in-document `$ref` (`#/components/{requestBodies,parameters,…}/*`)
 * one level. A non-`#/`-local `$ref` (external file / remote) returns `undefined` →
 * the caller treats it as inconclusive-skip (never fabricates a finding). A node
 * without a `$ref` is returned as-is.
 */
function derefLocalComponent<T>(spec: OpenApiDoc, node: unknown): T | undefined {
  if (!node || typeof node !== 'object') return node as T
  const ref = (node as { $ref?: unknown }).$ref
  if (typeof ref !== 'string') return node as T
  if (!ref.startsWith('#/')) return undefined // external/remote — out of v1 scope
  let cur: unknown = spec
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur as T
}

type ContentMap = Record<string, { schema?: unknown }>

/**
 * Select the declared request-body schema for a concrete Content-Type. When a CT is
 * present, match the spec's `content` keys by specificity: exact `type/subtype`, then
 * the subtype range, then the catch-all range. When the CT is ABSENT (the capture
 * path), fall back to a JSON-family key (the bridge only resolves JSON bodies) — and
 * `matched:false` there must NEVER become `unsupported-media-type` (C1).
 */
function selectContentSchema(
  content: ContentMap | undefined,
  ct: string | undefined,
): { matched: true; schema: unknown; json: boolean } | { matched: false } {
  if (!content) return { matched: false }
  const keys = Object.keys(content)
  if (ct) {
    const type = ct.split('/')[0] ?? ''
    const key =
      keys.find((k) => mediaBase(k) === ct) ??
      keys.find((k) => mediaBase(k) === `${type}/*`) ??
      keys.find((k) => mediaBase(k) === '*/*')
    if (!key) return { matched: false }
    return { matched: true, schema: content[key]?.schema, json: isJsonMediaType(key) }
  }
  const jsonKey = keys.find(isJsonMediaType)
  if (!jsonKey) return { matched: false }
  return { matched: true, schema: content[jsonKey]?.schema, json: true }
}

export function validateOpenApiRequest(
  spec: OpenApiDoc,
  req: RequestFacts,
  opts: OpenApiRequestValidateOptions = {},
): RequestValidationResult {
  const findings: ContractFinding[] = []
  let unverified = false
  const method = req.method.toLowerCase()

  const resolved = resolveOpenApiOperation(spec, method, req.path)
  if (!resolved) {
    findings.push({
      kind: 'missing-operation',
      severity: 'error',
      message: `no operation ${req.method.toUpperCase()} ${req.path} in the OpenAPI document`,
    })
    return { valid: false, findings }
  }
  const { operation, template } = resolved
  const op = { method, path: template }

  // --- requestBody ---
  const requestBodyRaw = operation.requestBody
  const requestBodyDeclared = requestBodyRaw !== undefined
  const requestBody = derefLocalComponent<RequestBodyObject>(spec, requestBodyRaw)
  const hasBody = req.body !== undefined
  const reqCt = req.headers?.['content-type'] ? mediaBase(req.headers['content-type']) : undefined

  if (requestBodyDeclared && (!requestBody || typeof requestBody !== 'object')) {
    // requestBody is a non-local `$ref` we cannot resolve — never fabricate
    // `undocumented-body` (the body IS expected); just mark it unverifiable (C5).
    unverified = true
  } else if (requestBody && typeof requestBody === 'object') {
    if (!hasBody) {
      // A required body that is absent: a breach ONLY if the caller is authoritative
      // about presence; otherwise unverifiable (capture can't tell "no body" from
      // "dropped a non-JSON body"). A non-required absent body is simply fine.
      if (requestBody.required === true) {
        if (opts.bodyPresenceAuthoritative) {
          findings.push({
            kind: 'missing-required-body',
            severity: 'error',
            message: `required request body missing for ${method.toUpperCase()} ${template}`,
          })
        } else {
          unverified = true
        }
      }
    } else {
      const sel = selectContentSchema(requestBody.content as ContentMap | undefined, reqCt)
      if (!sel.matched) {
        if (reqCt) {
          // A Content-Type IS present but no declared media type matches it.
          findings.push({
            kind: 'unsupported-media-type',
            severity: 'warning',
            message: `content-type '${reqCt}' is not declared for ${method.toUpperCase()} ${template}`,
          })
        }
        // CT-absent + no JSON content key ⇒ unverified only, NEVER unsupported-media-type (C1).
        unverified = true
      } else if (!sel.json || sel.schema === undefined) {
        // Matched a non-JSON media type (or a media type with no schema) — v1 is
        // presence-only for non-JSON bodies.
        unverified = true
      } else {
        const compiled = normalizeOpenApiSchema(sel.schema, spec, opts)
        const { valid, errors } = validateSchema(compiled, req.body)
        if (!valid) {
          for (const err of errors) {
            findings.push({
              kind: 'request-body-schema',
              severity: 'error',
              path: err.instancePath,
              message: err.message,
            })
          }
        }
      }
    }
  } else if (hasBody) {
    // Body sent to an operation that declares no requestBody: a warning (often
    // client-side noise the server ignored), and the body was never schema-checked.
    findings.push({
      kind: 'undocumented-body',
      severity: 'warning',
      message: `request body sent to ${method.toUpperCase()} ${template} which declares no request body`,
    })
    unverified = true
  }

  // --- parameters (path / query / header; scalars only in v1) ---
  const pathVals = extractPathParams(template, req.path)
  // Deref `$ref` params first; a non-local ref we can't resolve ⇒ inconclusive-skip.
  const params: ParamObject[] = []
  for (const rp of mergeParameters(resolved.pathItem, operation)) {
    if (typeof rp.$ref === 'string') {
      const d = derefLocalComponent<ParamObject>(spec, rp)
      if (!d || typeof d.name !== 'string' || typeof d.in !== 'string') {
        unverified = true
        continue
      }
      params.push(d)
    } else if (typeof rp.name === 'string' && typeof rp.in === 'string') {
      params.push(rp)
    }
    // else malformed param object: ignore
  }

  for (const param of params) {
    if (typeof param.name !== 'string' || typeof param.in !== 'string') continue
    // Unsupported location / serialization / content-typed param → STAGED skip.
    if (!styleSupported(param)) {
      unverified = true
      continue
    }
    const normSchema =
      param.schema !== undefined ? normalizeOpenApiSchema(param.schema, spec, opts) : undefined
    const types = normSchema ? scalarTypes(normSchema) : undefined
    if (!normSchema || !types) {
      // No schema, or a non-scalar (array/object) param → STAGED skip.
      unverified = true
      continue
    }

    const lk = lookupParamValue(param, req, pathVals)
    if (lk.state === 'multi') {
      unverified = true // array/repeated/embedded value → STAGED skip
      continue
    }
    if (lk.state === 'absent') {
      const required = param.in === 'path' || param.required === true
      if (required) {
        if (opts.paramsAuthoritative) {
          findings.push({
            kind: 'missing-required-param',
            severity: 'error',
            path: param.name,
            message: `required ${param.in} parameter '${param.name}' missing for ${method.toUpperCase()} ${template}`,
          })
        } else {
          unverified = true
        }
      }
      continue
    }

    // Present: coerce the raw string to the declared scalar type, then schema-check.
    const coerced = coerceScalar(lk.value, types)
    if (!coerced.ok) {
      const want = types.filter((t) => t !== 'null').join('|')
      findings.push({
        kind: 'param-schema',
        severity: 'error',
        path: param.name,
        // Echo the RAW captured substring, never the coerced value (redaction).
        message: `${param.in} parameter '${param.name}' value '${lk.value}' is not a valid ${want}`,
      })
      continue
    }
    const { valid, errors } = validateSchema(normSchema, coerced.value)
    if (!valid) {
      for (const err of errors) {
        findings.push({
          kind: 'param-schema',
          severity: 'error',
          path: param.name,
          message: `${param.in} parameter '${param.name}' ${err.message}`,
        })
      }
    }
  }

  // Undocumented QUERY params (headers excluded — infra/trace headers saturate
  // captures). A declared-but-skipped param is still DECLARED (its name is in
  // `params`), so it is never flagged here (H3).
  if (req.query) {
    const declaredQuery = new Set(
      params.filter((p) => p.in === 'query' && typeof p.name === 'string').map((p) => p.name),
    )
    for (const key of Object.keys(req.query)) {
      if (!declaredQuery.has(key)) {
        findings.push({
          kind: 'undocumented-param',
          severity: 'warning',
          path: key,
          message: `undocumented query parameter '${key}' for ${method.toUpperCase()} ${template}`,
        })
      }
    }
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
    operation: op,
    ...(unverified ? { unverified: true } : {}),
  }
}
