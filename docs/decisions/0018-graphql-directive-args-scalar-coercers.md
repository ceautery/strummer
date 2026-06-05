# ADR 0018 — GraphQL directive-arg validation + custom-scalar variable coercers

- **Status:** Accepted
- **Date:** 2026-06-05
- **Extends:** ADR 0005 (contract validation) + ADR 0015 (the GraphQL request-variable
  authority / `unverified` / redaction model this directly deepens).
- **Installed pin:** `graphql@16.14.0` (`^16.9.0` in `packages/api/package.json`).
- **Engine:** `packages/api/src/graphql.ts`. **Bridge:** `packages/api/src/har-capture.ts`.
  **Surfaces:** `packages/mcp/src/api.ts`, `packages/cli/src/api.ts`.
- **Design:** forged via a design fan-out — 3 parallel research streams (graphql-js
  directive-validation semantics; custom-scalar coercion mechanics; the existing Sackville
  seam + an adversarial false-positive sweep) → synthesis → 2 adversarial critics (both
  returned *ship-with-fixes*; 3 blockers + concerns all folded in below) → corrected design.
  All 5 open forks human-ratified (see "Resolved forks").

## Context

ADR 0015 validated a GraphQL operation's runtime **`variables`** against the operation's
declared variable types. Two things it explicitly staged remain:

1. **Directive arguments** (`@skip(if: $s)`, `@cacheControl(maxAge: 60)`,
   `@auth(token: "…")`) were never separately considered.
2. **Custom-scalar-typed variables** were folded to `unverified` because a custom scalar
   declared in SDL via `buildSchema()` gets an **identity `parseValue`** that validates
   nothing — there was no way to teach the validator what a `DateTime`/`URL`/`EmailAddress`
   actually accepts.

This ADR closes both.

## The decisive finding (reshapes Feature A)

graphql-js's `validate(schema, document)` — already run at `graphql.ts:199` with the default
rule set — **structurally checks directive args identically to field args** (TypeInfo
resolves the directive-arg type). So unknown-directive (`KnownDirectivesRule`), wrong-location
(`KnownDirectivesRule`), unknown-arg (`KnownArgumentNamesOnDirectivesRule`), missing-required
(`ProvidedRequiredArgumentsOnDirectivesRule`), and literal-type-shape (`ValuesOfCorrectTypeRule`)
are **already authoritative** and surface as `graphql-validation` findings.

And `getVariableValues`/`coerceVariableValues` is **usage-agnostic**: it coerces each variable
against its *declared* type, keyed only off `operation.variableDefinitions`, with **zero**
knowledge of where the variable is used. Therefore the ADR-0015 per-`variableDefinition` loop
**already validates the value of any variable feeding a directive arg** — for free, and
**exactly once** even when the same variable also feeds a field arg.

> **Cardinal rule:** anything `validate()` already covers is **SKIP-by-us** — reuse its
> finding, never re-check, to avoid divergent/double findings.

So **Feature A is mostly negative**: prove (regression-lock) that directive-arg variables are
already covered, and close the one genuine residual — a **custom-scalar-typed directive-arg
*literal*** carries no validation (identity `parseLiteral`) and must fold to `unverified`,
never silently pass and never become a finding.

## Decision

### Feature A — directive-arg validation

- **D3/D7 (variable-fed directive args, incl. `@skip`/`@include`):** already covered by the
  ADR-0015 variable loop. **No new code** — slice 1 is a tests-only regression lock,
  including the case of a variable feeding *both* a field arg and a directive arg (must yield
  exactly one finding).
- **D1/D4/D5/D6 (literal known-scalar; required-missing; unknown-arg; wrong-location/unknown
  directive):** **SKIP — reuse `validate()`'s `graphql-validation` finding.**
- **D2 (custom-scalar directive-arg *literal*, incl. list/input-object literals with a nested
  custom scalar):** **CHECK → `unverified`, coercer-INDEPENDENT.** A `visitWithTypeInfo` pass
  **confined to directive-arg position** (parent is a `DirectiveNode`), skipping `Variable`
  value nodes, reusing the **transitive `typeInvolvesCustomScalar`** helper (not a flat
  `isScalarType`) so nested custom scalars in list/object literals fold correctly. Emits **no
  finding** (the literal may carry an inline secret) and is gated on `queryClean` (don't run
  if `validate()` already errored).

### Feature B — custom-scalar variable coercers

An **operator-supplied registry of coercer functions keyed by scalar name** that throw on
definite invalidity:

```ts
/** Throws (any error) to reject the value as definitely invalid. Return value is
 *  ignored — only throw/no-throw is the signal. MUST throw ONLY on definite invalidity;
 *  indeterminate ⇒ do not throw. Applies to VARIABLE values only; document literals are
 *  never routed through coercers. */
export type ScalarCoercer = (value: unknown) => unknown
```

- **Mechanism (fork §8.3, ratified in-place):** after `buildSchema(sdl)` (fresh per call —
  never cached/shared), `patchRegisteredScalars` overwrites the scalar's **`parseValue` ONLY**.
- **`parseLiteral` is NEVER patched (BLOCKER-1).** `validate()` invokes `parseLiteral` on every
  custom-scalar *literal*; a coercer throwing there would land its **raw-value-and-message** into
  a `graphql-validation` finding at `graphql.ts:200` — a redaction leak that also contradicts D2.
  Variables traverse `parseValue` (via `getVariableValues`), never `parseLiteral`, so patching
  `parseValue` only fully preserves Feature B while making a literal-leak structurally impossible.
- **Built-in shadow guard (safety-critical, fork §8.5):** a coercer registered for a built-in
  (`Int`/`Float`/`String`/`Boolean`/`ID`) is **silently ignored** (filtered out of `registered`),
  never patched onto the built-in's `parseValue`. Otherwise a valid `@skip(if: $b)` Boolean
  variable could be routed through operator logic and false-fire — an invariant-1 violation.
- **Soundness:** `registered = keys(coercers)` filtered to *non-built-in, present-in-schema,
  `isScalarType`*. `typeInvolvesCustomScalar(type, seen, registered)` now treats a **registered**
  scalar as checkable; an **unregistered** custom scalar (or an input object transitively
  containing one) stays `unverified`. A registered coercer's variable failure surfaces as a
  reconstructed `graphql-variable-invalid` (value-free).

### Threading (engine → MCP → CLI → live-run)

- **Engine:** additive optional `scalarCoercers?: Record<string, ScalarCoercer>` on
  `GraphqlValidateOptions`. `registered` threaded into `typeInvolvesCustomScalar`,
  `validateVariables`, and the D2 pass. The `getVariableValues` call site is **unchanged** — the
  patched `parseValue` makes it actually validate.
- **MCP `validate_response` (fork §8.1, ratified operator-set):** functions can't cross the JSON
  tool boundary, so the server is constructed with an **operator-bound registry**; the tool gains
  `enableScalarCoercers?: string[]` (names resolved against the registry; unknown names ignored).
  Agents may only **select** by name, never define. **`validate_response` has NO `verifyRedact`
  backstop** — the engine's value-free reconstruction is the **sole** redaction guard, so any
  finding ever added to the GraphQL path MUST be value-free by construction (tested end-to-end
  through MCP in slice 5).
- **CLI (human = operator):** `api validate --graphql` and live `api run --graphql` gain
  `--coercers <file.js>` (module exporting `Record<string, ScalarCoercer>`; path absolute or
  cwd-relative). **Load failure / throwing module fails LOUDLY (non-zero exit)** — never a silent
  drop to no-coercer `unverified` (which would look clean — an absence-laundering hazard).
- **Capture bridge:** does **not** thread coercers (non-authoritative, server-truth-agnostic);
  custom scalars stay `unverified` there. D2 *can* occur on the capture path, and its `unverified`
  rides the existing fold to `noSignal`.

### Finding kinds

**Reuse only — add NO new `ContractFindingKind`.** Directive structural failures →
`graphql-validation` (from `validate()`). Variable-fed directive arg / registered-coercer failure
→ `graphql-variable-invalid`. D2 literal / unregistered custom scalar → `unverified` (no finding).

**Observability (fork §8.4, ratified distinct):** a distinct `findingsByKind` `bump()` summary
string **`graphql-directive-unverified`** for D2 — a free additive string (NOT a
`ContractFindingKind`), updated in **both** the engine surfaces **and** the bridge fold
(`har-capture.ts`), so D2-on-capture is not mis-bucketed as `graphql-variable-unverified`.

## Invariants

| Invariant | How it holds |
|-----------|--------------|
| **(1) Ambiguity ⇒ unverified, never a false finding** | D2 → `unverified` (coercer-independent). D3/D7 ride the sound variable loop. D1/D4/D5/D6 reuse `validate()`. C1 emits a finding only on a *definite* coercer throw; built-in shadow refused so a valid built-in variable never false-fires. |
| **(2) Absence is never a pass** | Every new `unverified` rides the existing bridge fold (`if (raw.unverified)` → `noSignal++` → `clean:false`). CLI coercer-module load failure exits non-zero (never a silent no-coercer pass). |
| **(3) Redaction before verdict** | Findings reconstructed from directive/arg/variable NAME + declared TYPE + category — never `print()` a value node, never surface graphql-js message text. `parseLiteral` never patched ⇒ no literal leak. Coercer throw consumed as a **boolean** only. |
| **(4) Compose, never widen** | No new `ContractFindingKind`. One additive optional `scalarCoercers?` + one extra `registered` param on private fns. `ContractResult`/`GraphqlValidationResult`/verdict shapes UNCHANGED. The summary string is a free `bump()`. |
| **(5) No real spawn/fetch in gate** | Pure in-process `buildSchema`/`parse`/`validate`/`visitWithTypeInfo`/`getVariableValues`; coercers are pure functions; tests register fakes in-process; CLI test uses an in-process fake module. |

## Resolved forks

1. **§8.1 — coercer trust boundary:** operator-set, agent-selects by name.
2. **§8.2 — scope:** one arc (this ADR), Feature A first.
3. **§8.3 — patch mechanism:** in-place `parseValue` patch on the fresh-per-call schema (a
   freshness test in slice 4 directly exercises identity restoration when a later call omits
   coercers).
4. **§8.4 — summary key:** distinct `graphql-directive-unverified`, updated in engine + bridge.
5. **§8.5 — built-in shadow:** silently ignore (kept + tested as defense-in-depth).

## Slice plan (TDD red → green → commit)

1. **(tests-only)** Directive-arg variable regression lock — incl. a variable feeding both a
   field arg and a directive arg → exactly one `graphql-variable-invalid`.
2. **(prod)** D2 custom-scalar directive-arg literal → `unverified` (directive-confined,
   transitive; field-arg literal unchanged).
3. **(prod)** `ScalarCoercer` + `patchRegisteredScalars` (parseValue only, built-in guard) +
   `scalarCoercers?` opt + `registered` threading.
4. **(prod/tests)** Coercer redaction + built-in-shadow refusal + D2 coercer-independence +
   variable-with-default silence + freshness (call-2-without-coercers restores identity).
5. **(prod)** MCP `validate_response` `enableScalarCoercers?: string[]` over the operator-bound
   registry + end-to-end MCP redaction test.
6. **(prod)** CLI `api validate --graphql --coercers <file.js>` (fail-loud on load error).
7. **(prod)** Live `api run --graphql` threads coercers (second wire point).
8. **(docs)** ADR final, STATUS/ROADMAP/memories, mark resolved ADR-0015 staged items.

## Explicitly staged / out of scope (deferred, not amputated)

- **S1 — custom-scalar FIELD-arg literals.** Same identity-`parseLiteral` gap for field-arg
  literals; slice 2 proves they are *unchanged* today. Fast follow-on.
- **S2 — coercers on the capture bridge.** Operator coercers vs captured-server truth risks
  false findings; capture stays custom-scalar-`unverified`.
- **S3 — inline-literal coercion surfacing findings.** We never patch `parseLiteral`, so this is
  not partially built. If ever wanted it MUST be a SEPARATE value-free pass with an explicit
  `catch` around `coerceInputValue` that never lets the throw escape into `validate()`'s message.
- **S4 — fragment-only / cross-operation variables.** Unchanged from ADR 0015 (single-target gate).
- **S5 — indeterminate-coercer sentinel.** Coercers are throw-only; no active `unverified` signal.
- **S6 — schema caching × coercer patching.** If a schema cache is ever added, the in-place
  `parseValue` patch must switch to clone-before-patch or a by-name side table.
