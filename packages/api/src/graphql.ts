/**
 * GraphQL operation + response validation via graphql-js. The high-value check
 * is **drift**: validate a saved query against the server's *current* schema
 * (SDL), so a field removed or renamed upstream surfaces as a finding rather
 * than a silent `null`. Also inspects the response payload for a non-empty
 * top-level `errors` array, and — when `variables` are supplied (ADR 0015) —
 * validates the runtime variable VALUES against the operation's declared types.
 */
import {
  buildSchema,
  GraphQLError,
  type GraphQLSchema,
  type GraphQLType,
  getNamedType,
  getVariableValues,
  isInputObjectType,
  isNonNullType,
  isScalarType,
  type OperationDefinitionNode,
  parse,
  print,
  typeFromAST,
  validate,
} from 'graphql'
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
  /** The runtime variable values to validate against the operation's declared variable
   * types (ADR 0015). Variable validation runs ONLY when this is provided (so existing
   * query-vs-SDL-only callers are behavior-preserved). */
  variables?: unknown
  /** Caller KNOWS the variable set is complete (direct surfaces hold the real request).
   * Default false: an absent required variable is `unverified`, not a finding. */
  variablesAuthoritative?: boolean
}

export interface GraphqlValidationResult extends ContractResult {
  /** A variable set the validator could not check (custom-scalar-typed variables, a
   * non-object `variables`, an ambiguous multi-operation target, or an absent required
   * variable the caller is not authoritative about). Additive/optional — the verdict shape
   * is UNCHANGED; the capture bridge folds this into `noSignal` so it can never become a
   * pass (absence-is-never-a-pass). Omitted when everything relevant was verifiable. */
  unverified?: boolean
}

/** The five built-in scalars graphql-js can actually coerce. A custom scalar declared in
 * SDL via `buildSchema` uses an identity `parseValue` (validates nothing), so a variable
 * typed over one carries no signal and must be `unverified`-skipped. */
const BUILTIN_SCALARS = new Set(['Int', 'Float', 'String', 'Boolean', 'ID'])

/**
 * Does this resolved type (unwrapping NonNull/List, and transitively through input-object
 * fields) bottom out in a custom (non-built-in) scalar? Cycle-guarded by `seen` keyed on
 * the input-object type name. Uses the schema-RESOLVED `GraphQLType` (via `typeFromAST`),
 * never the AST node.
 */
function typeInvolvesCustomScalar(type: GraphQLType, seen: Set<string>): boolean {
  const named = getNamedType(type)
  if (isScalarType(named)) return !BUILTIN_SCALARS.has(named.name)
  if (isInputObjectType(named)) {
    if (seen.has(named.name)) return false
    seen.add(named.name)
    return Object.values(named.getFields()).some((f) => typeInvolvesCustomScalar(f.type, seen))
  }
  return false // enums (and anything else) carry signal / are handled by validate()
}

/**
 * Validate the runtime `variables` of a SINGLE resolved operation against its declared
 * variable types. Appends findings (reconstructed from variable NAME + declared TYPE +
 * category — NEVER from graphql-js messages, which echo raw values) and returns whether
 * anything was `unverified`.
 */
function validateVariables(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  variables: unknown,
  authoritative: boolean,
  findings: ContractFinding[],
): boolean {
  // A `variables` that is not a plain JSON object (array/null/scalar) can't be interpreted
  // (an array makes every var look absent; null throws) → unverified, never a false finding.
  if (typeof variables !== 'object' || variables === null || Array.isArray(variables)) {
    return true
  }
  const vars = variables as Record<string, unknown>
  const varDefs = operation.variableDefinitions ?? []
  const declared = new Set<string>()
  let unverified = false

  for (const vd of varDefs) {
    const name = vd.variable.name.value
    declared.add(name)
    const resolved = typeFromAST(schema, vd.type)
    if (!resolved) continue // unknown type — already flagged by validate()
    const typeStr = print(vd.type)

    // Custom-scalar-typed variable: the SDL scalar can't validate it → no signal.
    if (typeInvolvesCustomScalar(resolved, new Set())) {
      unverified = true
      continue
    }

    // Validate JUST this variable, so any error is structurally attributable to it
    // (no parsing graphql-js messages, which echo the raw value).
    const result = getVariableValues(schema, [vd], vars)
    if (!('errors' in result) || !result.errors || result.errors.length === 0) continue

    const present = name in vars
    if (!present) {
      // Absent. graphql-js only errors here for a required (non-null, no-default) variable;
      // a non-null WITH a default coerces cleanly (no error), so this IS missing-required.
      if (authoritative) {
        findings.push({
          kind: 'graphql-variable-missing',
          severity: 'error',
          message: `required variable "$${name}" of type "${typeStr}" was not provided`,
        })
      } else {
        unverified = true
      }
    } else if (vars[name] === null && isNonNullType(resolved)) {
      findings.push({
        kind: 'graphql-variable-invalid',
        severity: 'error',
        message: `variable "$${name}" of non-null type "${typeStr}" must not be null`,
      })
    } else {
      findings.push({
        kind: 'graphql-variable-invalid',
        severity: 'error',
        message: `variable "$${name}" got an invalid value for type "${typeStr}"`,
      })
    }
  }

  // Variables the operation never declares (graphql-js silently ignores them).
  for (const key of Object.keys(vars)) {
    if (!declared.has(key)) {
      findings.push({
        kind: 'graphql-undocumented-variable',
        severity: 'warning',
        message: `undocumented variable "$${key}" not declared by the operation`,
      })
    }
  }

  return unverified
}

/**
 * Validate a GraphQL `query` against a schema `sdl`; if `opts.json` is supplied,
 * also check the response payload for returned `errors`. With `opts.operationName`
 * the root-type drift check is scoped to that operation (which must exist). When
 * `opts.variables` is supplied, the runtime variable values are validated against the
 * operation's declared types (ADR 0015). `valid` is true only when no `error`-severity
 * finding is present.
 */
export function validateGraphqlOperation(
  sdl: string,
  query: string,
  opts: GraphqlValidateOptions = {},
): GraphqlValidationResult {
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

  // --- Request-variable validation (ADR 0015) ---
  let unverified = false
  if (opts.variables !== undefined) {
    // Only run on a structurally-clean query (validate() found nothing) and a SINGLE
    // resolved target operation — otherwise a variable payload can't be attributed.
    const queryClean = findings.every((f) => f.severity !== 'error')
    const targetOp = targets.length === 1 ? targets[0] : undefined
    if (queryClean) {
      if (!targetOp) {
        unverified = true // ambiguous (multi-op, no operationName) or unresolved
      } else {
        unverified = validateVariables(
          schema,
          targetOp,
          opts.variables,
          opts.variablesAuthoritative === true,
          findings,
        )
      }
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

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
    ...(unverified ? { unverified: true } : {}),
  }
}
