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
  /** Decoded fields of a `form`-style body (`application/x-www-form-urlencoded` or the
   * text parts of `multipart/form-data`); repeated keys → array. The AUTHORITATIVE
   * structured channel for non-JSON body validation (ADR 0016 addendum 4) — populated at
   * prepare time from the structured parts, NEVER by re-parsing the serialized string.
   * File-part bytes never enter this map. */
  form?: Record<string, string | string[]>
  /** Field NAMES of `multipart/form-data` FILE parts (bytes never inlined — redaction).
   * A declared schema property satisfied by a file part is `unverified`-skipped. */
  formFileFields?: string[]
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

/** `'array'`/`'object'` for a (normalized) non-scalar schema, else `undefined`. A
 * `'null'`-augmented union (3.0 nullable shim) is tolerated; a union mixing
 * array/object with a scalar (or with each other) is ambiguous → `undefined`
 * (handled as a typeless skip, never a false validation). */
function nonScalarType(schema: Record<string, unknown>): 'array' | 'object' | undefined {
  const t = schema.type
  if (typeof t === 'string') return t === 'array' || t === 'object' ? t : undefined
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null')
    if (nonNull.length > 0 && nonNull.every((x) => x === 'array')) return 'array'
    if (nonNull.length > 0 && nonNull.every((x) => x === 'object')) return 'object'
  }
  return undefined
}

/** A serialized array param cannot soundly prove its element COUNT from a single
 * wire occurrence (it might be an explode-disagreement). When the array schema
 * constrains cardinality, a single-occurrence value is `unverified`-skipped. */
function hasCardinalityConstraint(schema: Record<string, unknown>): boolean {
  return (
    schema.minItems !== undefined || schema.maxItems !== undefined || schema.uniqueItems === true
  )
}

/** The delimiter joining elements of a non-exploded QUERY array for this style, or
 * `undefined` when the query style isn't a supported array serialization. */
function queryArrayDelimiter(param: ParamObject): string | undefined {
  if (param.style === undefined || param.style === 'form') return ','
  if (param.style === 'spaceDelimited') return ' '
  if (param.style === 'pipeDelimited') return '|'
  return undefined
}

/** Whether this param's (location, style, type) is a supported ARRAY serialization
 * (query form/space/pipe-delimited, path simple/label/matrix, header simple). Explode +
 * item-type soundness are resolved in the handler. */
function arraySerializationSupported(param: ParamObject): boolean {
  switch (param.in) {
    case 'query':
      return queryArrayDelimiter(param) !== undefined
    case 'header':
      return param.style === undefined || param.style === 'simple'
    case 'path':
      return (
        param.style === undefined ||
        param.style === 'simple' ||
        param.style === 'label' ||
        param.style === 'matrix'
      )
    default:
      return false // cookie + anything unknown
  }
}

/** A PATH array's split delimiter is `.` only for `label` + `explode` (RFC 6570
 * `{.list*}` → `.a.b.c`). `.` is the one delimiter that occurs inside a JSON `number`
 * (decimal point), so a `number`-typed label-explode array would over-split. */
function arraySplitUsesDot(param: ParamObject): boolean {
  return param.in === 'path' && param.style === 'label' && (param.explode ?? false) === true
}

/** Decompose a serialized array value into its raw string elements, or `undefined`
 * when the serialization can't be soundly reversed (malformed prefix / unsupported
 * style) — the caller then `unverified`-skips. Query splits on the style delimiter;
 * header `simple` splits on `,` and trims; PATH handles simple/label/matrix × explode
 * (stripping the RFC 6570 `.`/`;name=` prefixes). */
function splitArrayValue(param: ParamObject, value: string): string[] | undefined {
  if (param.in === 'query') {
    const d = queryArrayDelimiter(param)
    return d === undefined ? undefined : value.split(d)
  }
  if (param.in === 'header') return value.split(',').map((s) => s.trim())
  if (param.in === 'path') {
    const style = param.style ?? 'simple'
    if (style === 'simple') return value.split(',') // explode irrelevant for arrays
    if (style === 'label') {
      if (!value.startsWith('.')) return undefined
      const body = value.slice(1)
      return (param.explode ?? false) ? body.split('.') : body.split(',')
    }
    if (style === 'matrix') {
      const name = param.name as string
      if (param.explode ?? false) {
        if (!value.startsWith(';')) return undefined
        const out: string[] = []
        for (const part of value.slice(1).split(';')) {
          const pre = `${name}=`
          if (!part.startsWith(pre)) return undefined
          out.push(part.slice(pre.length))
        }
        return out
      }
      const pre = `;${name}=`
      return value.startsWith(pre) ? value.slice(pre.length).split(',') : undefined
    }
  }
  return undefined
}

/** Whether every non-null item type is a scalar whose value space cannot contain the
 * split delimiter — making a delimited split EXACT (element coercion AND cardinality
 * sound). `integer`/`boolean` never contain any of our delimiters; `number` contains
 * `.`, so it is excluded only when the dot delimiter is used (label-explode). String/
 * typeless items always over-split, so they stay `unverified`. */
function itemTypesSplittable(itemTypes: string[], usesDotDelimiter: boolean): boolean {
  const nonNull = itemTypes.filter((t) => t !== 'null')
  if (nonNull.length === 0) return false
  return nonNull.every(
    (t) => t === 'integer' || t === 'boolean' || (t === 'number' && !usesDotDelimiter),
  )
}

/** A FRACTIONAL `multipleOf` is the IEEE-754 false-positive trap: coercing a wire
 * string to a JS float then ajv-checking e.g. `multipleOf: 0.1` reports a
 * spec-conformant value like `0.3` as invalid (0.3/0.1 ≠ an integer in binary). We
 * can't soundly assert conformance, so a scalar schema carrying one is `unverified`-
 * skipped (an INTEGER `multipleOf` divides exactly and stays validated). */
function hasFractionalMultipleOf(schema: Record<string, unknown>): boolean {
  const m = schema.multipleOf
  return typeof m === 'number' && !Number.isInteger(m)
}

/** Which query OBJECT serializations the validator reconstructs. deepObject
 * (`name[prop]` discrete keys) and form/`explode=false` (`name=k,v,k,v` single string)
 * are checkable; form/`explode=true` objects merge into the shared top-level namespace
 * (irreducibly ambiguous — only their undoc-param SUPPRESSION is supported), and
 * path/header/cookie objects are STAGED. */
function objectSerializationSupported(param: ParamObject): boolean {
  if (param.in !== 'query') return false
  if (param.style === 'deepObject') return true
  return (param.style === undefined || param.style === 'form') && param.explode === false
}

/**
 * Which (location, style, type) serializations the validator can soundly check.
 * SCALARS: the default per location (path/header `simple`, query `form`). ARRAYS: any
 * `arraySerializationSupported` location/style (query form/space/pipe-delimited, path
 * simple/label/matrix, header simple); explode + item-type soundness are resolved in the
 * handler. OBJECTS and every other style/location (deepObject/cookie/content-typed) are
 * OBJECTS: query deepObject + form/`explode=false` (`objectSerializationSupported`).
 * Everything else (path/header/cookie objects, form/`explode=true` objects, content-
 * typed) is STAGED → inconclusive-skip. `schema` is the NORMALIZED param schema (so the
 * array/scalar decision sees the 3.0 nullable shim). */
function styleSupported(param: ParamObject, schema: Record<string, unknown> | undefined): boolean {
  if (param.content) return false
  const nonScalar = schema ? nonScalarType(schema) : undefined
  if (nonScalar === 'array') return arraySerializationSupported(param)
  if (nonScalar === 'object') return objectSerializationSupported(param)
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

type ParamLookup =
  | { state: 'present'; value: string }
  | { state: 'absent' }
  | { state: 'array-values'; values: string[] } // ≥2 query occurrences (an exploded array)
  | { state: 'multi' } // composite path segment / unsupported repetition → STAGED skip

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
        : { state: 'array-values', values: q } // ≥2 occurrences (queryRecord only arrays >1)
    return { state: 'present', value: q }
  }
  if (param.in === 'header') {
    const h = req.headers?.[name.toLowerCase()]
    return h === undefined ? { state: 'absent' } : { state: 'present', value: h }
  }
  return { state: 'absent' }
}

/**
 * Validate an ARRAY param (query form/space/pipe-delimited, path/header `simple`)
 * against its declared schema. Resolves the wire elements per (state, style, explode):
 *
 *  - `array-values` (≥2 query occurrences, explode=true) — the discrete elements, NO
 *    split, so any scalar item type is sound.
 *  - query `form` + explode=true, single occurrence — wrapped `[v]` ONLY when it carries
 *    no comma (no explode-disagreement) and the schema has no cardinality constraint
 *    (else `unverified`).
 *  - DELIMITED single string (query explode=false form/space/pipe, path simple/label/
 *    matrix, header simple) — decomposed by `splitArrayValue`, but ONLY for scalar items
 *    whose value space can't contain the delimiter (`integer`/`boolean` always; `number`
 *    unless the dot delimiter is used); string/typeless items, empty segments, and a
 *    malformed prefix are `unverified` (embedded-delimiter / serialization ambiguity).
 *
 * Appends `param-schema` findings; returns whether the param was `unverified`-skipped.
 */
function validateArrayParam(
  param: ParamObject,
  normSchema: Record<string, unknown>,
  lk: ParamLookup,
  findings: ContractFinding[],
): boolean {
  // Tuple/heterogeneous or non-scalar items carry no element splitter we can coerce.
  const itemSchema = normSchema.items
  const itemTypes =
    itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)
      ? scalarTypes(itemSchema as Record<string, unknown>)
      : undefined
  if (normSchema.prefixItems !== undefined || !itemTypes) return true
  // A fractional `multipleOf` on the items is the IEEE-754 false-positive trap — skip.
  if (hasFractionalMultipleOf(itemSchema as Record<string, unknown>)) return true

  const explodeTrue =
    param.in === 'query' &&
    (param.style === undefined || param.style === 'form') &&
    (param.explode ?? true) === true

  let elements: string[]
  if (lk.state === 'array-values') {
    elements = lk.values // discrete elements — no split, string items fine
  } else if (lk.state === 'present' && explodeTrue) {
    // Single occurrence: ambiguous unless it carries no delimiter AND no cardinality.
    if (lk.value.includes(',') || hasCardinalityConstraint(normSchema)) return true
    elements = [lk.value]
  } else if (lk.state === 'present') {
    // DELIMITED single string. Sound to split ONLY when the delimiter can't occur
    // inside an element and the serialization parses cleanly.
    if (!itemTypesSplittable(itemTypes, arraySplitUsesDot(param))) return true
    const parts = splitArrayValue(param, lk.value)
    if (parts === undefined || parts.some((s) => s === '')) return true
    elements = parts
  } else {
    return true // 'multi'/'absent' — handled upstream; skip defensively
  }

  const want = itemTypes.filter((t) => t !== 'null').join('|')
  const coerced: unknown[] = []
  let anyBad = false
  for (const el of elements) {
    const c = coerceScalar(el, itemTypes)
    if (!c.ok) {
      anyBad = true
      findings.push({
        kind: 'param-schema',
        severity: 'error',
        path: param.name as string,
        // Echo the RAW captured element, never the coerced value (redaction).
        message: `${param.in} parameter '${param.name}' value '${el}' is not a valid ${want}`,
      })
    } else {
      coerced.push(c.value)
    }
  }
  if (anyBad) return false // a finding was raised; the array can't be assembled for ajv
  const { valid, errors } = validateSchema(normSchema, coerced)
  if (!valid) {
    for (const err of errors) {
      findings.push({
        kind: 'param-schema',
        severity: 'error',
        path: param.name as string,
        message: `${param.in} parameter '${param.name}' ${err.message}`,
      })
    }
  }
  return false
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Validate a query OBJECT param against its declared schema. deepObject reconstructs
 * from discrete `name[prop]` keys (so STRING props are sound — no split); form/
 * `explode=false` splits the single `name=k,v,k,v` string (integer/boolean props ONLY —
 * a string value's comma cascades, a number's float mis-coerces). Declared scalar props
 * are coerced; undeclared keys pass through (ajv handles them per additionalProperties);
 * the assembled object is ajv-validated. Returns whether the param was `unverified`.
 *
 * REFUSE (→ unverified, never a false finding) when reconstruction can't be sound: no
 * flat scalar `properties`; an object-form `additionalProperties` (an undeclared key we
 * leave uncoerced could false-fail a typed schema); any prop with a fractional
 * `multipleOf` (float trap); a deepObject nested (`a[b]`) or repeated key; a form/
 * explode=false object with any non-(integer|boolean) prop, `additionalProperties !==
 * false`, or an odd/empty split.
 */
function validateObjectParam(
  param: ParamObject,
  normSchema: Record<string, unknown>,
  req: RequestFacts,
  opts: OpenApiRequestValidateOptions,
  method: string,
  template: string,
  findings: ContractFinding[],
): boolean {
  const props = normSchema.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return true
  const propEntries = Object.entries(props as Record<string, unknown>)
  if (propEntries.length === 0) return true
  const propTypes = new Map<string, string[]>()
  for (const [propName, sub] of propEntries) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return true
    const s = sub as Record<string, unknown>
    const t = scalarTypes(s)
    if (!t || hasFractionalMultipleOf(s)) return true // non-scalar prop / float trap
    propTypes.set(propName, t)
  }
  // Only literal true/false/absent additionalProperties can be reasoned about; an
  // object-form (typed/empty) schema means an undeclared key we'd leave uncoerced could
  // false-fail — refuse.
  const ap = normSchema.additionalProperties
  if (ap !== undefined && typeof ap !== 'boolean') return true

  const name = param.name as string
  const collected: Array<[string, string]> = []
  let present = false

  if (param.style === 'deepObject') {
    const prefix = `${name}[`
    const flat = new RegExp(`^${escapeRegExp(name)}\\[([^\\]]+)\\]$`)
    for (const [key, val] of Object.entries(req.query ?? {})) {
      if (!key.startsWith(prefix)) continue
      present = true
      const m = flat.exec(key)
      if (!m || m[1] === undefined) return true // nested / malformed bracket key
      if (Array.isArray(val)) return true // repeated deepObject key
      collected.push([m[1], val])
    }
  } else {
    // form/explode=false: under the single key `name`; sound only for integer/boolean
    // props (string → comma cascade, number → float) with additionalProperties:false.
    if (ap !== false) return true
    for (const t of propTypes.values()) {
      if (!t.filter((x) => x !== 'null').every((x) => x === 'integer' || x === 'boolean')) {
        return true
      }
    }
    const raw = req.query?.[name]
    if (raw === undefined) {
      present = false
    } else if (Array.isArray(raw) || raw === '') {
      return true // repeated / empty → ambiguous
    } else {
      present = true
      const segs = raw.split(',')
      if (segs.length % 2 !== 0 || segs.some((s) => s === '')) return true
      for (let i = 0; i < segs.length; i += 2) {
        collected.push([segs[i] as string, segs[i + 1] as string])
      }
    }
  }

  if (!present) {
    if (param.required === true) {
      if (opts.paramsAuthoritative) {
        findings.push({
          kind: 'missing-required-param',
          severity: 'error',
          path: name,
          message: `required ${param.in} parameter '${name}' missing for ${method.toUpperCase()} ${template}`,
        })
      } else {
        return true
      }
    }
    return false
  }

  const obj: Record<string, unknown> = {}
  let anyBad = false
  for (const [prop, value] of collected) {
    const types = propTypes.get(prop)
    if (types) {
      const c = coerceScalar(value, types)
      if (!c.ok) {
        anyBad = true
        findings.push({
          kind: 'param-schema',
          severity: 'error',
          path: `${name}[${prop}]`,
          // Echo only the RAW captured value (redaction).
          message: `${param.in} parameter '${name}[${prop}]' value '${value}' is not a valid ${types.filter((t) => t !== 'null').join('|')}`,
        })
      } else {
        obj[prop] = c.value
      }
    } else {
      obj[prop] = value // undeclared — ajv decides per additionalProperties
    }
  }
  if (anyBad) return false
  const { valid, errors } = validateSchema(normSchema, obj)
  if (!valid) {
    for (const err of errors) {
      findings.push({
        kind: 'param-schema',
        severity: 'error',
        path: name,
        message: `${param.in} parameter '${name}' ${err.message}`,
      })
    }
  }
  return false
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

type ContentMap = Record<string, { schema?: unknown; encoding?: unknown }>

/** `'urlencoded'`/`'multipart'` for the two form media bases, else `undefined`. Form
 * bodies are validated by reconstructing the field map (ADR 0016 addendum 4). */
function formBase(mb: string): 'urlencoded' | 'multipart' | undefined {
  if (mb === 'application/x-www-form-urlencoded') return 'urlencoded'
  if (mb === 'multipart/form-data') return 'multipart'
  return undefined
}

type SelectedContent =
  | { matched: true; schema: unknown; json: boolean; mediaBase: string; encoding: unknown }
  | { matched: false }

/**
 * Select the declared request-body schema for a concrete Content-Type. When a CT is
 * present, match the spec's `content` keys by specificity: exact `type/subtype`, then
 * the subtype range, then the catch-all range. When the CT is ABSENT (the capture
 * path), fall back to a JSON-family key (the bridge only resolves JSON bodies) — and
 * `matched:false` there must NEVER become `unsupported-media-type` (C1). Also surfaces
 * the matched media base + its `encoding` object (form-body validation refuses any
 * per-property encoding — addendum 4).
 */
function selectContentSchema(
  content: ContentMap | undefined,
  ct: string | undefined,
): SelectedContent {
  if (!content) return { matched: false }
  const keys = Object.keys(content)
  if (ct) {
    const type = ct.split('/')[0] ?? ''
    const key =
      keys.find((k) => mediaBase(k) === ct) ??
      keys.find((k) => mediaBase(k) === `${type}/*`) ??
      keys.find((k) => mediaBase(k) === '*/*')
    if (!key) return { matched: false }
    return {
      matched: true,
      schema: content[key]?.schema,
      json: isJsonMediaType(key),
      mediaBase: mediaBase(key),
      encoding: content[key]?.encoding,
    }
  }
  const jsonKey = keys.find(isJsonMediaType)
  if (!jsonKey) return { matched: false }
  return {
    matched: true,
    schema: content[jsonKey]?.schema,
    json: true,
    mediaBase: 'application/json',
    encoding: content[jsonKey]?.encoding,
  }
}

/** A declared scalar/array form-body property after classification. */
type FormPropPlan =
  | { kind: 'scalar'; types: string[] }
  | { kind: 'array'; itemTypes: string[]; hasCard: boolean }

/** UTF-8 / ASCII charsets we can soundly assume the bytes→string decode preserved. */
const SOUND_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii'])

/**
 * Validate a `form`-style request body (`application/x-www-form-urlencoded` or the text
 * parts of `multipart/form-data`) against its declared object schema, reconstructing
 * typed values from the DISCRETE field map (`req.form`; repeated keys → array). Discrete
 * keys make even STRING array items sound (no delimiter to over-split) — form bodies are
 * more tractable than form *params*. Mirrors `validateObjectParam`'s coerce-then-ajv
 * logic. Declared scalar props are coerced to the declared type; sound scalar-item array
 * props are assembled from repeated keys; undeclared keys pass through as raw strings
 * (ajv then enforces `additionalProperties`); the assembled object is ajv-validated.
 *
 * Returns whether the body was `unverified`-skipped. REFUSE → unverified (never a false
 * finding) when reconstruction can't be sound: ANY per-property `encoding`; a non-UTF-8
 * charset; the schema isn't a flat object with `properties`; an object-form (typed)
 * `additionalProperties`; a non-scalar / typeless property, or an array property with
 * non-scalar items; a fractional `multipleOf` (float trap); a declared property satisfied
 * by a multipart FILE part; a scalar property arriving with repeated keys; a single-
 * occurrence array property carrying a cardinality constraint; an ambiguous empty value
 * for a non-string, non-null scalar property; or — when the caller is NOT authoritative —
 * any required field absent from the captured map.
 */
function validateFormBody(
  normSchema: Record<string, unknown>,
  encoding: unknown,
  req: RequestFacts,
  opts: OpenApiRequestValidateOptions,
  findings: ContractFinding[],
): boolean {
  // Per-property `encoding` re-introduces the full style/explode ambiguity matrix inside
  // the body (delimited / JSON-encoded properties) — v1 permanently-out.
  if (encoding !== undefined && encoding !== null) return true
  // A non-UTF-8 declared charset means the bytes→string decode may already be wrong.
  const rawCt = req.headers?.['content-type']
  if (rawCt) {
    const m = /;\s*charset=([^;]+)/i.exec(rawCt)
    if (m?.[1] && !SOUND_CHARSETS.has(m[1].trim().toLowerCase())) return true
  }

  const props = normSchema.properties
  if (!props || typeof props !== 'object' || Array.isArray(props)) return true
  const propEntries = Object.entries(props as Record<string, unknown>)
  if (propEntries.length === 0) return true
  // Only a literal true/false/absent `additionalProperties` is reasoned about; a typed
  // one would false-fail an undeclared key we leave uncoerced.
  const ap = normSchema.additionalProperties
  if (ap !== undefined && typeof ap !== 'boolean') return true

  const plan = new Map<string, FormPropPlan>()
  for (const [name, sub] of propEntries) {
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return true
    const s = sub as Record<string, unknown>
    const st = scalarTypes(s)
    if (st) {
      if (hasFractionalMultipleOf(s)) return true
      plan.set(name, { kind: 'scalar', types: st })
      continue
    }
    const nst = nonScalarType(s)
    if (nst === 'array') {
      const items = s.items
      if (!items || typeof items !== 'object' || Array.isArray(items)) return true
      const it = scalarTypes(items as Record<string, unknown>)
      if (!it || hasFractionalMultipleOf(items as Record<string, unknown>)) return true
      plan.set(name, { kind: 'array', itemTypes: it, hasCard: hasCardinalityConstraint(s) })
      continue
    }
    return true // nested object / array-of-object / typeless property
  }

  const form = (req.form ?? {}) as Record<string, string | string[]>
  const fileFields = new Set(req.formFileFields ?? [])
  // A declared property satisfied by a multipart file part can't be schema-checked.
  for (const name of plan.keys()) if (fileFields.has(name)) return true

  const required = Array.isArray(normSchema.required) ? (normSchema.required as string[]) : []
  // Non-authoritative source: a required field absent from the captured map can't be
  // distinguished from a dropped field → unverified (absence is never a finding here).
  if (!opts.bodyPresenceAuthoritative) {
    for (const rq of required) if (form[rq] === undefined) return true
  }

  const obj: Record<string, unknown> = {}
  let anyBad = false
  for (const [name, p] of plan) {
    const raw = form[name]
    if (raw === undefined) continue // absent: ajv enforces `required` (authoritative path)
    if (p.kind === 'scalar') {
      if (Array.isArray(raw)) return true // scalar prop arriving as repeated keys (array)
      // `field=` can't be told apart from null / valueless-key; only string/null absorb it.
      if (raw === '' && !p.types.includes('string') && !p.types.includes('null')) return true
      const c = coerceScalar(raw, p.types)
      if (!c.ok) {
        anyBad = true
        findings.push({
          kind: 'request-body-schema',
          severity: 'error',
          path: name,
          // Echo only the RAW field value (redaction); never the coerced value.
          message: `request body field '${name}' value '${raw}' is not a valid ${p.types.filter((t) => t !== 'null').join('|')}`,
        })
      } else obj[name] = c.value
    } else {
      const occ = Array.isArray(raw) ? raw : [raw]
      // A single occurrence can't prove a count bound (it might be an explode-disagreement).
      if (occ.length === 1 && p.hasCard) return true
      const arr: unknown[] = []
      for (const el of occ) {
        if (el === '' && !p.itemTypes.includes('string') && !p.itemTypes.includes('null')) {
          return true // ambiguous empty element
        }
        const c = coerceScalar(el, p.itemTypes)
        if (!c.ok) {
          anyBad = true
          findings.push({
            kind: 'request-body-schema',
            severity: 'error',
            path: name,
            message: `request body field '${name}' value '${el}' is not a valid ${p.itemTypes.filter((t) => t !== 'null').join('|')}`,
          })
        } else arr.push(c.value)
      }
      if (!anyBad) obj[name] = arr
    }
  }
  // Undeclared fields pass through raw (ajv enforces `additionalProperties`); file parts
  // are never schema-checked, so they don't enter the assembled object.
  for (const [key, val] of Object.entries(form)) {
    if (plan.has(key) || fileFields.has(key)) continue
    obj[key] = val
  }
  if (anyBad) return false // a value-level finding was raised; don't double-report via ajv

  const { valid, errors } = validateSchema(normSchema, obj)
  if (!valid) {
    for (const err of errors) {
      findings.push({
        kind: 'request-body-schema',
        severity: 'error',
        ...(err.instancePath ? { path: err.instancePath } : {}),
        message: err.message,
      })
    }
  }
  return false
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
  const hasBody = req.body !== undefined || req.form !== undefined
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
      } else if (formBase(sel.mediaBase) && req.form !== undefined && sel.schema !== undefined) {
        // A `form`-style body with a structured field map (addendum 4): reconstruct +
        // validate the fields; any unsound case folds to `unverified`.
        const normSchema = normalizeOpenApiSchema(sel.schema, spec, opts)
        if (validateFormBody(normSchema, sel.encoding, req, opts, findings)) unverified = true
      } else if (!sel.json || sel.schema === undefined) {
        // Matched a non-JSON media type (or a media type with no schema) — presence-only
        // for non-form, non-JSON bodies (e.g. a form body with no structured field map).
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

  // --- parameters (path / query / header; scalars + query form arrays in v1) ---
  const pathVals = extractPathParams(template, req.path)
  // Metadata for the undocumented-param pass, collected during the param loop:
  const declaredQuery = new Set<string>() // scalar + array query param names
  const deepObjectPrefixes: string[] = [] // `name[` keys belonging to a deepObject param
  // When set, the whole undoc pass is unsound (an object's properties share the
  // top-level query namespace) and is suppressed.
  let suppressUndoc = false
  // Deref `$ref` params first; a non-local ref we can't resolve ⇒ inconclusive-skip.
  const params: ParamObject[] = []
  for (const rp of mergeParameters(resolved.pathItem, operation)) {
    if (typeof rp.$ref === 'string') {
      const d = derefLocalComponent<ParamObject>(spec, rp)
      if (!d || typeof d.name !== 'string' || typeof d.in !== 'string') {
        unverified = true
        // The dropped param could be a query OBJECT whose properties land as
        // top-level keys; suppress the undoc pass rather than risk a false positive.
        suppressUndoc = true
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
    const normSchema =
      param.schema !== undefined ? normalizeOpenApiSchema(param.schema, spec, opts) : undefined
    const types = normSchema ? scalarTypes(normSchema) : undefined
    const nonScalar = normSchema ? nonScalarType(normSchema) : undefined

    // Record query-param presence for the undoc pass BEFORE any validation skip, so a
    // STAGED object param still suppresses/excludes its keys (its properties are on the
    // wire regardless of whether we validate the object).
    if (param.in === 'query') {
      if (nonScalar === 'object') {
        // EXPLICIT explode test: query object explode DEFAULTS to true (shared namespace).
        if (param.style === 'deepObject') deepObjectPrefixes.push(`${param.name}[`)
        else if ((param.style === undefined || param.style === 'form') && param.explode === false)
          declaredQuery.add(param.name) // form/explode=false: serialized under one key
        else suppressUndoc = true // form/explode=true → shared top-level namespace
      } else {
        declaredQuery.add(param.name) // scalar + array params (the array key == its name)
      }
    }

    // Unsupported location / serialization / content-typed param → STAGED skip.
    if (!styleSupported(param, normSchema)) {
      unverified = true
      continue
    }
    if (!normSchema || (!types && nonScalar === undefined)) {
      // No schema, or a truly typeless param → STAGED skip. (Arrays/objects have no
      // scalar `types` but are handled below.)
      unverified = true
      continue
    }

    // Object param (query deepObject or form/explode=false) — its own presence logic
    // (deepObject has no `name` key; form/explode=false is under the single `name`).
    if (nonScalar === 'object' && normSchema) {
      if (validateObjectParam(param, normSchema, req, opts, method, template, findings)) {
        unverified = true
      }
      continue
    }

    const lk = lookupParamValue(param, req, pathVals)
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

    // Array param (query form/space/pipe-delimited, path/header simple).
    if (nonScalar === 'array' && normSchema) {
      if (validateArrayParam(param, normSchema, lk, findings)) unverified = true
      continue
    }

    // Scalar path. A repeated/composite value for a SCALAR param can't be coerced —
    // fold to unverified (never fall through to coerce an absent `.value`).
    if (lk.state === 'multi' || lk.state === 'array-values' || !types) {
      unverified = true
      continue
    }
    // A fractional `multipleOf` is the IEEE-754 false-positive trap — can't soundly
    // coerce-and-ajv this number; skip rather than risk flagging a conformant value.
    if (hasFractionalMultipleOf(normSchema)) {
      unverified = true
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
  // captures). Suppressed entirely when an object query param shares the top-level
  // namespace (or an unresolved $ref param might). A deepObject's `name[prop]` keys
  // are excluded (bracket namespace), and a declared-but-skipped param is still
  // DECLARED (its name is in `declaredQuery`), so neither is flagged.
  if (req.query && !suppressUndoc) {
    for (const key of Object.keys(req.query)) {
      if (declaredQuery.has(key)) continue
      if (deepObjectPrefixes.some((p) => key.startsWith(p))) continue
      findings.push({
        kind: 'undocumented-param',
        severity: 'warning',
        path: key,
        message: `undocumented query parameter '${key}' for ${method.toUpperCase()} ${template}`,
      })
    }
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
    operation: op,
    ...(unverified ? { unverified: true } : {}),
  }
}
