/**
 * OpenAPI 3.1 response-contract validation. OpenAPI 3.1's Schema Object *is*
 * JSON Schema 2020-12, so response bodies are validated with the same ajv
 * validator as the `schema` assertion (see ADR 0005 for why we validate
 * directly rather than via openapi-backend). Surfaces drift: requests to
 * undocumented operations, undocumented status codes, and bodies that violate
 * the declared response schema.
 *
 * Scope: local `#/components/schemas/...` `$ref`s are resolved (rewritten into
 * `$defs` so ajv handles recursion natively); **external local-file** `$ref`s
 * are inlined when a `baseDir` is supplied (JSON + YAML, incl. the file's own
 * internal refs, cycle-guarded). OpenAPI 3.0 `nullable` is shimmed to a 3.1 type
 * union. Still out of scope: **remote (http) `$ref`s** (SSRF) and non-schema
 * `$ref`s (parameters, shared `responses`).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ContractFinding, ContractResult } from './model.js'
import { validateSchema } from './schema.js'

// Open interfaces: a parsed OpenAPI document carries far more than we read, so
// each shape allows arbitrary extra keys rather than fighting the type checker.
interface OpenApiResponse {
  content?: Record<string, { schema?: unknown }>
  [key: string]: unknown
}
interface OpenApiOperation {
  responses?: Record<string, OpenApiResponse>
  [key: string]: unknown
}
interface OpenApiDoc {
  paths?: Record<string, Record<string, OpenApiOperation> | undefined>
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}

export interface ResponseFacts {
  status: number
  headers?: Record<string, string>
  body: unknown
}

const COMPONENT_PREFIX = '#/components/schemas/'

/** Build a regex matching a path template (`/users/{id}`) against a concrete path. */
function pathToRegex(template: string): RegExp {
  const literals = template.split(/\{[^}]+\}/)
  const escaped = literals.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')
  return new RegExp(`^${escaped}/?$`)
}

function matchPath(
  paths: NonNullable<OpenApiDoc['paths']>,
  reqPath: string,
): { template: string; item: Record<string, OpenApiOperation> } | undefined {
  const clean = reqPath.split('?')[0] ?? reqPath
  const exact = paths[clean]
  if (exact) return { template: clean, item: exact }
  for (const [template, item] of Object.entries(paths)) {
    if (item && pathToRegex(template).test(clean)) return { template, item }
  }
  return undefined
}

/** Find the response object for a status, honoring `2XX` ranges and `default`. */
function findResponse(
  responses: Record<string, OpenApiResponse>,
  status: number,
): OpenApiResponse | undefined {
  const exact = responses[String(status)]
  if (exact) return exact
  // Range keys appear as both `2XX` (spec) and `2xx` (common in the wild).
  const digit = Math.floor(status / 100)
  const range = responses[`${digit}XX`] ?? responses[`${digit}xx`]
  if (range) return range
  return responses.default
}

/** Pick the JSON response schema (prefers application/json, then *​/*, then first). */
function pickJsonSchema(response: OpenApiResponse): unknown {
  const content = response.content
  if (!content) return undefined
  const entry = content['application/json'] ?? content['*/*'] ?? Object.values(content)[0]
  return entry?.schema
}

/** Navigate a JSON Pointer (`#/A/B`) within a document. */
function navigatePointer(doc: unknown, pointer: string): unknown {
  const path = pointer.replace(/^#/, '').split('/').filter(Boolean)
  let node: unknown = doc
  for (const raw of path) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Load + parse a referenced file (JSON or YAML by extension), cached by path. */
function loadRefDoc(absPath: string, cache: Map<string, unknown>): unknown {
  const cached = cache.get(absPath)
  if (cached !== undefined) return cached
  const text = readFileSync(absPath, 'utf8')
  const doc = /\.ya?ml$/i.test(absPath) ? parseYaml(text) : JSON.parse(text)
  cache.set(absPath, doc)
  return doc
}

/**
 * Inline external local-file `$ref`s into a self-contained schema. A `$ref`
 * pointing at `file#/pointer` is loaded from disk (relative to `baseDir`),
 * navigated, and FULLY dereferenced — the external file's own internal (`#/…`)
 * and nested external refs are inlined too, relative to that file. Internal
 * refs of the MAIN document (`#/components/schemas/…`) are left intact (handled
 * by the `$defs` rewrite). Remote (http) refs remain out of scope (SSRF). A
 * cycle guard caps recursion on self-referential external schemas.
 */
function inlineExternalRefs(
  node: unknown,
  baseDir: string,
  cache: Map<string, unknown>,
  // When set, `#/…` refs resolve within `doc` (an external file) and are inlined;
  // when undefined, the node is the MAIN doc and internal refs are left as-is.
  doc: unknown,
  stack: Set<string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => inlineExternalRefs(n, baseDir, cache, doc, stack))
  }
  if (!node || typeof node !== 'object') return node

  const ref = (node as Record<string, unknown>).$ref
  if (typeof ref === 'string') {
    const external = !ref.startsWith('#')
    if (external) {
      const [filePart, pointer = ''] = ref.split('#')
      const absPath = resolve(baseDir, filePart as string)
      const key = `${absPath}#${pointer}`
      if (stack.has(key)) return {} // cycle: stop inlining (permissive)
      const refDoc = loadRefDoc(absPath, cache)
      const subtree = navigatePointer(refDoc, `#${pointer}`)
      return inlineExternalRefs(subtree, dirname(absPath), cache, refDoc, new Set([...stack, key]))
    }
    if (doc !== undefined) {
      // Internal ref WITHIN an external file → resolve against that file + inline.
      if (stack.has(ref)) return {} // cycle guard
      const subtree = navigatePointer(doc, ref)
      return inlineExternalRefs(subtree, baseDir, cache, doc, new Set([...stack, ref]))
    }
    // Internal ref of the MAIN doc — leave for the $defs rewrite.
    return node
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = inlineExternalRefs(v, baseDir, cache, doc, stack)
  }
  return out
}

/**
 * OpenAPI 3.0 used `nullable: true` instead of 3.1's `type: ['string', 'null']`.
 * ajv (JSON Schema 2020-12) ignores `nullable`, so without this shim a 3.0 doc
 * gives a false failure on an explicit null. Rewrite `{type:'X', nullable:true}`
 * → `{type:['X','null']}` and drop the (non-2020) `nullable` keyword everywhere.
 */
function shimNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shimNullable)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  const src = node as Record<string, unknown>
  for (const [key, value] of Object.entries(src)) {
    if (key === 'nullable') continue // dropped (handled below)
    out[key] = shimNullable(value)
  }
  if (src.nullable === true) {
    if (typeof src.type === 'string') out.type = [src.type, 'null']
    else if (Array.isArray(src.type) && !src.type.includes('null')) out.type = [...src.type, 'null']
  }
  return out
}

/** Recursively rewrite `#/components/schemas/X` $refs to `#/$defs/X`. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs)
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT_PREFIX)) {
        out.$ref = `#/$defs/${value.slice(COMPONENT_PREFIX.length)}`
      } else {
        out[key] = rewriteRefs(value)
      }
    }
    return out
  }
  return node
}

/**
 * Validate a response against an OpenAPI 3.1 document. Returns structured
 * findings; `valid` is true only when no `error`-severity finding is present.
 */
export interface OpenApiValidateOptions {
  /** Directory the spec was loaded from — enables external local-file `$ref`
   * resolution (relative refs resolve against it). Omit to disable. */
  baseDir?: string
}

export function validateOpenApiResponse(
  spec: OpenApiDoc,
  req: { method: string; path: string },
  res: ResponseFacts,
  opts: OpenApiValidateOptions = {},
): ContractResult {
  const findings: ContractFinding[] = []
  const method = req.method.toLowerCase()

  const matched = spec.paths ? matchPath(spec.paths, req.path) : undefined
  const operation = matched?.item[method]
  if (!matched || !operation) {
    findings.push({
      kind: 'missing-operation',
      severity: 'error',
      message: `no operation ${req.method.toUpperCase()} ${req.path} in the OpenAPI document`,
    })
    return { valid: false, findings }
  }

  const op = { method, path: matched.template }
  const responses = operation.responses ?? {}
  const response = findResponse(responses, res.status)
  if (!response) {
    findings.push({
      kind: 'undocumented-status',
      severity: 'error',
      message: `status ${res.status} is not documented for ${method.toUpperCase()} ${matched.template}`,
    })
    return { valid: false, findings, operation: op }
  }

  const schema = pickJsonSchema(response)
  if (schema !== undefined) {
    // OpenAPI 3.0 needs the nullable→type-union shim before ajv (2020-12) sees it;
    // external local-file $refs are inlined first (when a baseDir is supplied).
    const is30 = String(spec.openapi ?? '').startsWith('3.0')
    const cache = new Map<string, unknown>()
    const normalize = (sub: unknown) => {
      const inlined = opts.baseDir
        ? inlineExternalRefs(sub, opts.baseDir, cache, undefined, new Set())
        : sub
      return rewriteRefs(is30 ? shimNullable(inlined) : inlined)
    }
    const componentDefs = Object.fromEntries(
      Object.entries(spec.components?.schemas ?? {}).map(([name, sub]) => [name, normalize(sub)]),
    )
    const rewritten = normalize(schema) as Record<string, unknown>
    // Merge component schemas into `$defs` without clobbering any the response
    // schema already declares (its own local `$defs` win on a name clash).
    const localDefs = (rewritten.$defs as Record<string, unknown> | undefined) ?? {}
    const compiled = { ...rewritten, $defs: { ...componentDefs, ...localDefs } }
    const { valid, errors } = validateSchema(compiled, res.body)
    if (!valid) {
      for (const err of errors) {
        findings.push({
          kind: 'response-schema',
          severity: 'error',
          path: err.instancePath,
          message: err.message,
        })
      }
    }
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
    operation: op,
  }
}
