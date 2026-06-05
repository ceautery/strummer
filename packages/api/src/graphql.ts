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
  type DocumentNode,
  GraphQLError,
  type GraphQLSchema,
  type GraphQLType,
  getNamedType,
  getVariableValues,
  isInputObjectType,
  isNonNullType,
  isScalarType,
  Kind,
  type OperationDefinitionNode,
  parse,
  print,
  TypeInfo,
  typeFromAST,
  validate,
  visit,
  visitWithTypeInfo,
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
  /** Operator-supplied custom-scalar coercers, keyed by scalar name (ADR 0018). A registered
   * scalar's VARIABLE values become checkable (the coercer throws on definite invalidity);
   * document literals are NEVER routed through coercers (the `parseLiteral` leak guard, §3).
   * Built-in scalar names are silently ignored (§8.5). Operator-set — never an agent input;
   * the MCP surface selects coercers by NAME against an operator-bound registry. */
  scalarCoercers?: Record<string, ScalarCoercer>
}

/**
 * A custom-scalar coercer (ADR 0018). Throws (any error) to reject a value as definitely
 * invalid; the return value is IGNORED — only throw/no-throw is the signal. MUST throw ONLY on
 * definite invalidity (indeterminate ⇒ do not throw, so an uncertain value never false-fires).
 * Applies to VARIABLE values only — document literals are never routed through a coercer.
 */
export type ScalarCoercer = (value: unknown) => unknown

export interface GraphqlValidationResult extends ContractResult {
  /** A variable set the validator could not check (custom-scalar-typed variables, a
   * non-object `variables`, an ambiguous multi-operation target, or an absent required
   * variable the caller is not authoritative about) — OR a custom-scalar directive-arg
   * literal (ADR 0018 D2). Additive/optional — the verdict shape is UNCHANGED; the capture
   * bridge folds this into `noSignal` so it can never become a pass (absence-is-never-a-pass).
   * Omitted when everything relevant was verifiable. */
  unverified?: boolean
  /** The `unverified` flag was (at least partly) caused by a custom-scalar directive-arg
   * LITERAL (ADR 0018 D2), as distinct from an unverifiable variable. Additive/optional; lets
   * the capture bridge bump the distinct `graphql-directive-unverified` summary key (ADR 0018
   * §8.4) instead of mislabeling it `graphql-variable-unverified`. Omitted otherwise. */
  directiveUnverified?: boolean
}

/** The five built-in scalars graphql-js can actually coerce. A custom scalar declared in
 * SDL via `buildSchema` uses an identity `parseValue` (validates nothing), so a variable
 * typed over one carries no signal and must be `unverified`-skipped — UNLESS the operator
 * registered a coercer for it (ADR 0018), making its `parseValue` actually validate. */
const BUILTIN_SCALARS = new Set(['Int', 'Float', 'String', 'Boolean', 'ID'])

/**
 * Does this resolved type (unwrapping NonNull/List, and transitively through input-object
 * fields) bottom out in a scalar that carries NO validation signal — i.e. a custom
 * (non-built-in) scalar WITHOUT a registered coercer? Cycle-guarded by `seen` keyed on the
 * input-object type name. Uses the schema-RESOLVED `GraphQLType` (via `typeFromAST`), never
 * the AST node. `registered` is the set of custom scalars with an operator coercer (ADR 0018);
 * pass an empty set for a coercer-INDEPENDENT check (e.g. the D2 directive-literal pass).
 */
function typeInvolvesCustomScalar(
  type: GraphQLType,
  seen: Set<string>,
  registered: Set<string>,
): boolean {
  const named = getNamedType(type)
  if (isScalarType(named)) return !BUILTIN_SCALARS.has(named.name) && !registered.has(named.name)
  if (isInputObjectType(named)) {
    if (seen.has(named.name)) return false
    seen.add(named.name)
    return Object.values(named.getFields()).some((f) =>
      typeInvolvesCustomScalar(f.type, seen, registered),
    )
  }
  return false // enums (and anything else) carry signal / are handled by validate()
}

/**
 * Patch the operator-registered custom-scalar coercers onto the freshly-built schema (ADR
 * 0018). Overwrites `parseValue` ONLY — NEVER `parseLiteral` (the redaction-leak guard, §3:
 * `validate()` invokes `parseLiteral` on every custom-scalar LITERAL, and a coercer throw
 * there would land the raw value + message into a finding). Variables traverse `parseValue`
 * via `getVariableValues`, so that is all Feature B needs. Built-in scalar names are silently
 * ignored (§8.5 — a built-in shadow could false-fire on a valid `@skip` Boolean variable).
 * Returns the set of scalar names actually patched (the `registered` set). Safe to mutate the
 * schema in place: `validateGraphqlOperation` builds a fresh, never-shared schema per call.
 */
function patchRegisteredScalars(
  schema: GraphQLSchema,
  coercers: Record<string, ScalarCoercer> | undefined,
): Set<string> {
  const registered = new Set<string>()
  if (!coercers) return registered
  for (const [name, coercer] of Object.entries(coercers)) {
    if (BUILTIN_SCALARS.has(name)) continue // built-in shadow ignored (safety-critical)
    const t = schema.getType(name)
    if (t && isScalarType(t)) {
      t.parseValue = coercer // parseValue ONLY — parseLiteral deliberately untouched (§3)
      registered.add(name)
    }
  }
  return registered
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
  registered: Set<string>,
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

    // A variable bottoming out in a custom scalar WITHOUT a registered coercer can't be
    // validated → no signal. A registered coercer (patched onto `parseValue`) makes
    // `getVariableValues` below actually validate it (ADR 0018).
    if (typeInvolvesCustomScalar(resolved, new Set(), registered)) {
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
 * D2 (ADR 0018): does the document attach a directive-arg LITERAL whose type bottoms out in a
 * custom (non-built-in) scalar? Such a literal is validated by NOTHING — a `buildSchema` custom
 * scalar has an identity `parseLiteral` which we DELIBERATELY never patch (the redaction-leak
 * guard, ADR 0018 §3) — so it carries no signal and must fold to `unverified`, never a finding
 * (the literal may carry an inline secret) and never a silent pass.
 *
 * COERCER-INDEPENDENT (ADR 0018 BLOCKER-2): a registered variable coercer validates VARIABLE
 * values via `parseValue`, never document literals, so this check passes NO `registered` set —
 * a registered scalar's literal stays `unverified` all the same.
 *
 * Confined to DIRECTIVE-arg position (field-arg literals are out of scope, ADR 0018 S1); a
 * variable-valued directive arg is handled by the variable loop, so it is skipped here. Reuses
 * the transitive `typeInvolvesCustomScalar` so a list/input-object directive-arg literal with a
 * nested custom scalar folds correctly. Caller must gate on a structurally-clean query.
 */
function hasCustomScalarDirectiveLiteral(schema: GraphQLSchema, document: DocumentNode): boolean {
  const typeInfo = new TypeInfo(schema)
  let directiveDepth = 0
  let found = false
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Directive: {
        enter: () => {
          directiveDepth++
        },
        leave: () => {
          directiveDepth--
        },
      },
      Argument: (node) => {
        if (directiveDepth === 0) return // a FIELD arg — out of scope (S1)
        if (node.value.kind === Kind.VARIABLE) return // handled by the variable loop (D3)
        const t = typeInfo.getInputType()
        // Empty `registered` set: D2 is COERCER-INDEPENDENT (coercers validate variables via
        // `parseValue`, never document literals — so a registered scalar's literal stays
        // unverified all the same, ADR 0018 BLOCKER-2).
        if (t && typeInvolvesCustomScalar(t, new Set(), new Set())) found = true
      },
    }),
  )
  return found
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

  // Patch operator-registered custom-scalar coercers (parseValue only) onto the fresh schema;
  // `registered` then drives whether a custom-scalar variable is checkable (ADR 0018).
  const registered = patchRegisteredScalars(schema, opts.scalarCoercers)

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

  // D2 + variable validation both run only on a structurally-clean query (validate() found
  // nothing) — otherwise the TypeInfo walk / variable payload can't be trusted/attributed.
  const queryClean = findings.every((f) => f.severity !== 'error')

  // --- D2: custom-scalar directive-arg LITERALS (ADR 0018) ---
  // Independent of `opts.variables` — it inspects the query's directive literals.
  const directiveUnverified = queryClean && hasCustomScalarDirectiveLiteral(schema, document)

  // --- Request-variable validation (ADR 0015) ---
  let variableUnverified = false
  if (opts.variables !== undefined && queryClean) {
    // Require a SINGLE resolved target operation — otherwise a variable payload can't be attributed.
    const targetOp = targets.length === 1 ? targets[0] : undefined
    if (!targetOp) {
      variableUnverified = true // ambiguous (multi-op, no operationName) or unresolved
    } else {
      variableUnverified = validateVariables(
        schema,
        targetOp,
        opts.variables,
        opts.variablesAuthoritative === true,
        registered,
        findings,
      )
    }
  }

  const unverified = directiveUnverified || variableUnverified

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
    ...(directiveUnverified ? { directiveUnverified: true } : {}),
  }
}
