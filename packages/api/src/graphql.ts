/**
 * GraphQL operation + response validation via graphql-js. The high-value check
 * is **drift**: validate a saved query against the server's *current* schema
 * (SDL), so a field removed or renamed upstream surfaces as a finding rather
 * than a silent `null`. Also inspects the response payload for a non-empty
 * top-level `errors` array.
 */
import { buildSchema, GraphQLError, type OperationDefinitionNode, parse, validate } from 'graphql'
import type { ContractFinding, ContractResult } from './model.js'

interface GraphqlPayload {
  data?: unknown
  errors?: { message?: string }[]
}

export interface GraphqlValidateOptions {
  /** Response payload to inspect for a top-level `errors` array. */
  json?: unknown
  /** For a multi-operation document, scope the root-type drift check to this
   * operation (and require it to exist). Without it, every operation is checked. */
  operationName?: string
}

/**
 * Validate a GraphQL `query` against a schema `sdl`; if `opts.json` is supplied,
 * also check the response payload for returned `errors`. With `opts.operationName`
 * the root-type drift check is scoped to that operation (which must exist).
 * `valid` is true only when no `error`-severity finding is present.
 */
export function validateGraphqlOperation(
  sdl: string,
  query: string,
  opts: GraphqlValidateOptions = {},
): ContractResult {
  const findings: ContractFinding[] = []

  // The schema is the contract; a malformed SDL means we can't validate at all.
  let schema: ReturnType<typeof buildSchema>
  try {
    schema = buildSchema(sdl)
  } catch (err) {
    findings.push({
      kind: 'graphql-validation',
      severity: 'error',
      message: `invalid schema SDL: ${(err as Error).message}`,
    })
    return { valid: false, findings }
  }

  // Parse (syntax) then validate (semantics: unknown fields/args = drift).
  let document: ReturnType<typeof parse>
  try {
    document = parse(query)
  } catch (err) {
    const message = err instanceof GraphQLError ? err.message : (err as Error).message
    findings.push({ kind: 'graphql-syntax', severity: 'error', message })
    return { valid: false, findings }
  }

  for (const err of validate(schema, document)) {
    findings.push({ kind: 'graphql-validation', severity: 'error', message: err.message })
  }

  // Collect operation definitions; optionally scope to a named one.
  const operations = document.definitions.filter(
    (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition',
  )
  let targets = operations
  if (opts.operationName !== undefined) {
    targets = operations.filter((d) => d.name?.value === opts.operationName)
    if (targets.length === 0) {
      findings.push({
        kind: 'graphql-validation',
        severity: 'error',
        message: `no operation named "${opts.operationName}" in the document`,
      })
    }
  }

  // graphql-js `validate()` does not flag a mutation/subscription whose root
  // type is absent from the schema (it's an execution-time error). For drift
  // detection that's exactly the case we care about, so check it explicitly.
  for (const def of targets) {
    const op = def.operation
    const rootType =
      op === 'mutation'
        ? schema.getMutationType()
        : op === 'subscription'
          ? schema.getSubscriptionType()
          : schema.getQueryType()
    if (!rootType) {
      findings.push({
        kind: 'graphql-validation',
        severity: 'error',
        message: `schema declares no root type for ${op} operations`,
      })
    }
  }

  const payload = opts.json as GraphqlPayload | undefined
  if (payload?.errors && payload.errors.length > 0) {
    const messages = payload.errors.map((e) => e.message ?? '(no message)').join('; ')
    findings.push({
      kind: 'graphql-errors',
      severity: 'error',
      message: `response returned ${payload.errors.length} GraphQL error(s): ${messages}`,
    })
  }

  return { valid: findings.every((f) => f.severity !== 'error'), findings }
}
