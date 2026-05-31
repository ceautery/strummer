/**
 * OpenAPI 3.1 response-contract validation. OpenAPI 3.1's Schema Object *is*
 * JSON Schema 2020-12, so response bodies are validated with the same ajv
 * validator as the `schema` assertion (see ADR 0005 for why we validate
 * directly rather than via openapi-backend). Surfaces drift: requests to
 * undocumented operations, undocumented status codes, and bodies that violate
 * the declared response schema.
 *
 * Scope for v1: local `#/components/schemas/...` `$ref`s are resolved (rewritten
 * into `$defs` so ajv handles recursion natively); external/remote `$ref`s and
 * non-schema `$ref`s (parameters, shared responses) are out of scope.
 */
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
export function validateOpenApiResponse(
  spec: OpenApiDoc,
  req: { method: string; path: string },
  res: ResponseFacts,
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
    const componentDefs = Object.fromEntries(
      Object.entries(spec.components?.schemas ?? {}).map(([name, sub]) => [name, rewriteRefs(sub)]),
    )
    const rewritten = rewriteRefs(schema) as Record<string, unknown>
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
