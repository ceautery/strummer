# ADR 0015 — GraphQL request-variable validation

- **Status:** Accepted
- **Date:** 2026-06-04
- **Extends:** ADR 0005 (contract validation) + ADR 0013 (cross-pillar verification
  invariants) + ADR 0014 (the request-half authority / `unverified` / redaction model).
- **Design:** forged via a design fan-out — 3 parallel research streams (graphql-js
  variable-validation mechanics; threading through the pillar + surfaces; an adversarial
  invariant/edge scope) → synthesis → 1 adversarial critic (which found 4 holes, all
  folded in below). Both open forks human-ratified.

## Context

The contract pillar validated a GraphQL operation's **query** against the SDL
(`validateGraphqlOperation` — drift) and the response `errors[]`, but never the runtime
**`variables`** payload against the operation's declared variable types. That is the
GraphQL analogue of the OpenAPI request-body/param validation landed in ADR 0014: a
request whose variables are missing/mistyped is request-side drift the cross-pillar
verdict should catch.

## Decision

**Placement (fork 1, ratified): EXTEND `validateGraphqlOperation`, do NOT add a
`validateGraphqlRequest` sibling.** This contrasts with ADR 0014's OpenAPI request/response
*split* — and the contrast is the point. For OpenAPI the two halves share nothing, so a
unified `validateOpenApiExchange` over-promised. For GraphQL the single
`validateGraphqlOperation` ALREADY spans both halves (query-vs-SDL drift is request-side;
`errors[]` is response-side), and variable validation reuses the EXACT same built schema,
parsed document, and already-selected operation node. A separate function would re-parse +
re-build the schema and risk diverging from the operation-selection logic. So variable
validation is folded in as the completion of the request half the function already
partially does.

The function gains `opts.variables?: unknown` + `opts.variablesAuthoritative?: boolean`, and
its return type becomes **`GraphqlValidationResult extends ContractResult { unverified?:
boolean }`** — an ADDITIVE optional field on a SUBTYPE, never a widening of the shared
`ContractResult` (the critic's load-bearing correction; exactly the `RequestValidationResult`
pattern from ADR 0014). Existing callers that treat the result as `ContractResult` are
unaffected.

**Variable validation runs iff `opts.variables !== undefined`** — an explicit opt-in, so
the existing query-vs-SDL-only callers (`api validate --graphql`, `validate_response`
without variables) are behavior-preserved. When no variables payload is captured at all,
the response `errors[]` check is the backstop for a truly-missing required variable.

**The per-variable attribution loop (the redaction-safety mechanism).** graphql-js
`getVariableValues` error messages **echo the raw input values verbatim** (whole input
objects, nested secrets, plus `e.toString()` appends the query source) — so we must NEVER
surface `e.message`/`e.toString()`/`e.originalError`. Instead we iterate the operation's
`variableDefinitions` ONE AT A TIME, calling `getVariableValues(schema, [varDef], vars)`
per variable, so each error is **structurally attributable** to a known variable (its
`name.value` + `print(varDef.type)` — both value-free, operator-authored). The finding
message is RECONSTRUCTED from name + printed type + a category. (The critic confirmed
single-element isolation is sound: variable defaults cannot reference other variables —
graphql-js rejects that at parse — so there is no cross-variable coercion dependency.)

**Categories (reconstructed, never echoing a value):**
- `graphql-variable-missing` (error) — a required variable (non-null **and** no default)
  whose key is absent. Default-aware: a non-null variable WITH a default that is omitted is
  NOT missing (graphql-js coerces the default). Emitted only when authoritative; else
  `unverified`.
- `graphql-variable-invalid` (error) — a present variable whose value fails coercion
  (type mismatch, bad enum, list/input-object error) OR an explicit `null` against a
  non-null type (a distinct sub-case the message notes as "null for non-null"). Always a
  finding — the value is present, authority is irrelevant.
- `graphql-undocumented-variable` (warning, fork 2 ratified) — a `variables` key the
  operation does not declare (graphql-js silently ignores these; we diff the keys
  ourselves). Mirrors `undocumented-param`.

**Authority.** `variablesAuthoritative` is set true by the DIRECT surfaces (CLI `api run
--graphql` / `api validate --graphql --variables`, MCP `validate_response.variables`) which
hold the real request; the capture bridge omits it. An absent required variable is a
`graphql-variable-missing` finding only when authoritative; otherwise `unverified`.

**`unverified`-skip cases (no finding; the capture bridge folds each into `noSignal` as
`graphql-variable-unverified` so a present-but-uncheckable variable set can NEVER be
laundered into a pass — absence-is-never-a-pass):**
- No SDL supplied (already a bridge-level no-signal: `graphql-sdl-not-supplied`).
- `variables` present but not a plain JSON object (array/string/etc.) — rejected before the
  loop (an array makes every declared var look absent; `null` throws). 
- A multi-operation document with no `operationName` (or an unresolvable one) — the variable
  payload targets one operation and we cannot attribute it. Variable validation runs only
  when a SINGLE target operation resolves.
- **Custom-scalar-typed variables.** A scalar declared in SDL via `buildSchema` gets the
  default identity `parseValue` — it validates NOTHING and green-lights any value. So a
  variable whose type, resolved via `typeFromAST` and walked through NonNull/List wrappers
  AND transitively through input-object fields (cycle-guarded by a `seen` set keyed on the
  input-object type name), bottoms out in a non-built-in scalar is `unverified`-skipped (not
  passed to `getVariableValues`). Built-ins (Int/Float/String/Boolean/ID), enums, and
  input-objects composed only of those ARE validated. The walk uses the schema-RESOLVED type,
  not the AST node (`print(varDef.type)` is only for the message).

**Bridge fold (the load-bearing wiring the critic caught).** The capture→contract bridge's
GraphQL branch passes `variables` (extracted by extending `graphqlOperationOf` to also
return them) NON-authoritatively, and then — mirroring the REST branch's `request-unverified`
fold — does `if (raw.unverified) { noSignal++; bump('graphql-variable-unverified') }`. Since
`clean` requires `noSignal === 0`, an uncheckable variable set forces `clean: false` ⇒
`fromCaptureVerdict` returns no-signal, never pass.

**Does NOT duplicate `validate()`.** The existing `validate(schema, document)` call stays —
it covers the query-STATIC variable rules (`NoUndefinedVariables`, `VariablesAreInputTypes`,
`VariablesInAllowedPosition`, `NoUnusedVariables`). The new work is purely the runtime
VALUES.

## Surfaces (fork: full parity, ratified)

- **Engine:** `validateGraphqlOperation` (extended, above).
- **Capture→contract bridge:** `graphqlOperationOf` extracts `variables`; the GraphQL branch
  drives variable validation (non-authoritative) + the `noSignal` fold. Reachable from
  `validate_capture` / `verify_change` / `strummer verify run` with no input change.
- **MCP `validate_response`:** gains an optional `variables` input (authoritative; findings
  message+path redacted via the operator redactor, as today).
- **CLI `api validate --graphql`:** gains `--variables <file|inline-json>` (authoritative).
- **Live `api run --graphql <schema>`:** the symmetric parallel to `api run --openapi` (ADR
  0014). A run whose body is a GraphQL envelope is validated (query + variables) against the
  supplied SDL via the existing `runRequestForContract` un-redacted channel; findings
  redacted via a `Redactor` rebuilt from `registeredSecrets`; request-contract validity
  folds into the exit code. (`api run --openapi` continues to skip GraphQL envelopes; the
  two flags are independent and may both be supplied.)

## Invariants held

Absence-is-never-a-pass (the `unverified`→`noSignal` fold, wired in the bridge — the critic's
HOLE 1), redaction-before-verdict (findings reconstructed from value-free tokens — name +
printed type + category — never from graphql-js messages that echo values; the bridge's
single message+path chokepoint still applies), compose-never-widen (`unverified` on a
`GraphqlValidationResult` SUBTYPE, never on `ContractResult`; verdict shape /
`fromCaptureVerdict` / `orchestrate` UNCHANGED), and no-real-fetch-in-gate (the validator is
pure; the bridge reads a stored HAR; the live-run path uses the existing in-process-server
test style).

## Consequences / staged (scheduled, not amputated)

- Custom-scalar variables are `unverified`-skipped, not validated — we only hold the SDL, and
  SDL scalars have no real coercion. A custom-scalar validation hook (operator-supplied
  coercers) is future.
- GraphQL **directive** argument validation, and validating variables used only inside
  fragment spreads across multiple operations, stay out of v1 (the single-target-operation
  rule covers the common case).
- The fidelity loss of an input-object sub-field path in a finding message (e.g. `at
  "pt.x"`) is accepted — that sub-path can carry a value, so the reconstructed message names
  the variable + its declared type only.
