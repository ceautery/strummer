# ADR 0016 — Non-scalar OpenAPI request-parameter serialization (v1: query arrays)

- **Status:** Accepted
- **Date:** 2026-06-04
- **Extends:** ADR 0005 (contract validation) + ADR 0013 (cross-pillar invariants) +
  ADR 0014 (the request-half authority / `unverified` / redaction model — this is a
  deepening of that exact surface).
- **Design:** forged via a design fan-out — 3 parallel research streams (the OpenAPI
  style/explode serialization matrix; the `request-contract.ts` code seams; prior-art
  false-positive traps) → synthesis into a CHECK-vs-SKIP decision matrix + TDD slice
  plan → 2 adversarial critics (both returned *ship-with-fixes*, converging on the same
  tightening; every blocker folded in below). The one scope fork (drop `explode=false`
  comma-arrays to staged) was human-ratified.

## Context

`validateOpenApiRequest` (ADR 0014) validated **scalar** path/query/header parameters,
but every **array/object** parameter was `unverified`-skipped (folding to `noSignal`).
Array and object query params are pervasive in real traffic, so a large class of
requests the capture/verify path sees was unverifiable. This ADR converts the
soundly-reversible subset into real validation.

## The cardinal constraint

OpenAPI's `style`/`explode` matrix is intricate and several cells are **irreducibly
ambiguous** on the wire — they cannot be reversed into the structured value without
guessing. A false positive (flagging a spec-conformant request) is the cardinal sin
here, strictly worse than a skip. So **every undecided or ambiguous cell resolves to
`unverified`-skip**, and v1 ships *only* the cells that are provably sound.

The representation we read (`RequestFacts.query: Record<string, string | string[]>`,
built identically by the live runner's `queryRecord` and the capture path's
`collectQuery` — repeated key → array, single → string) is what makes the sound subset
small but real.

## Decision — what v1 CHECKs

**Query `form` arrays, `explode=true` only:**

- **≥2 wire occurrences** (`?t=a&t=b` → `query.t=['a','b']`): the values *are* the
  array. Coerce each element to the item scalar type (`coerceScalar`), assemble, and
  validate the whole array against the normalized schema. `minItems`/`maxItems`/
  `uniqueItems` are all sound here because the true element count is known.
- **Single occurrence** (`?t=a`): wrapped to `['a']` and checked **only if** the value
  contains no `,` *and* the schema declares no cardinality constraint; otherwise
  `unverified`. (A single occurrence cannot disambiguate a genuine 1-element array from
  an `explode=false` disagreement, nor prove a cardinality bound — critics FP-1/FP-3.)
- Non-scalar `items`, `prefixItems` tuples, typeless/object schemas → `unverified`.

**Undocumented-param suppression (mandatory; lands now even though object *validation*
is staged).** Once any object query param exists, its serialized keys arrive on the
wire and would false-fire `undocumented-param`:

- A `form`/`explode=true` **object** param shares the *top-level* query namespace with
  real scalar params — irreducibly (critic FP-4). So its presence **suppresses the
  entire undocumented-param pass** for that operation and marks `unverified`. Closed
  `additionalProperties` does **not** restore the ability to tell a stray property from
  a stray param.
- A `deepObject` param uses a `name[prop]` *bracket* namespace, distinguishable from
  plain keys: its `name[...]` keys are excluded from the pass (sound for open or closed
  objects), while plain undeclared keys are still flagged.
- An unresolved non-local `$ref` param (dropped because we cannot deref it) might be an
  object, so it also suppresses the pass (critic H1).

## Decision — what stays STAGED (parseable, deliberately deferred)

Honest, not amputated — each ships later behind the same seams with its own tested
splitter and guards:

- Query `form`/`explode=false` **comma-arrays** — **dropped from v1** (human-ratified):
  a string element legitimately containing the delimiter over-splits and false-fails a
  per-item constraint (`minLength`/`pattern`/`enum`/`format`) — an irreducible
  false-positive class the critics proved (FP-2/FP-5/FP1).
- Query `spaceDelimited` / `pipeDelimited` arrays.
- Path arrays (`simple`/`label`/`matrix`) and header arrays (`simple`).
- Object *reconstruction* for `form`/`explode=false` and `deepObject` (flat scalar
  props only; refuse array-typed / non-scalar / open-`additionalProperties` props).

## Permanently out of scope (unsound or unmodeled)

- `form`/`explode=true` **object** *validation* (shared-namespace collision — only its
  undoc-param *suppression* is supported).
- Cookie params (no channel in `RequestFacts`); composite path segments (not exactly
  `{name}`); nested deepObject; open-`additionalProperties` object validation; non-scalar
  array items / object property values.

## Mechanics & invariants held

- **New internal seams only** — `nonScalarType` (array/object detector, null-union
  tolerant), `hasCardinalityConstraint`, a `validateQueryArray` handler, a new
  `array-values` `ParamLookup` state for ≥2 query occurrences. `styleSupported` now
  takes the **normalized** schema and admits query-form arrays; `normSchema` is computed
  once per param (no double-deref). `validateOpenApiRequest`'s signature and
  `RequestValidationResult` shape are **unchanged**.
- **Wiring fix (the blocker both critics independently caught):** a *scalar* param that
  receives a repeated key now folds to `unverified` via an explicit `array-values`
  branch — never a fall-through into `coerceScalar` on an absent `.value`.
- **Zero new `ContractFindingKind`s** — reuse `param-schema` / `missing-required-param`
  / `undocumented-param`.
- **Redaction:** an element-coercion finding echoes only the RAW captured element,
  never the coerced value.
- **Absence-is-never-a-pass:** every skip sets `unverified`, which the capture bridge
  already folds to `noSignal`; the verdict shape and that fold are untouched.
- **No real fetch in `pnpm gate`:** pure validator; exercised through the existing
  capture-bridge and live-run tests unchanged.

## Consequences

The capture/verify path now validates exploded array query params it previously could
only skip, with no surface change (the engine is reached through the unchanged bridge +
live `api run --openapi`). The staged cells are recorded in `ROADMAP.md` Phase 2.

## Addendum 1 — delimited array serializations (2026-06-04)

Slice 6 un-stages the **delimited** (single-string) array serializations the v1 critics
had deferred, behind the soundness rule they established (no new fan-out — the v1
adversarial pass already mapped this exact matrix):

- **CHECKed:** query `form`/`explode=false` (split `,`), `spaceDelimited` (split ` `),
  `pipeDelimited` (split `|`); path `simple` (split `,`); header `simple` (split `,`,
  each segment trimmed) — **only when every item type is a NON-STRING scalar**
  (integer/number/boolean). The delimiter provably cannot occur inside such an element,
  so the split is exact and both element coercion **and** cardinality (minItems/maxItems/
  uniqueItems) are sound. A single delimiter-free value is a 1-element array.
- **Still `unverified` (the irreducible class):** delimited arrays with **string** or
  typeless items (an embedded delimiter is a legal data char that over-splits and would
  false-fail a per-item/cardinality constraint — critics FP-2/FP-5/FP1); any empty
  segment (trailing/internal delimiter — absence/empty-element ambiguity).
- The `explode=true` query-form paths (≥2 occurrences = the array; single-occurrence
  wrap) are unchanged from v1; `array-values` (discrete, no split) still admits string
  items because nothing is split.

New internal seams: `arrayDelimiter` (the location/style → delimiter predicate, now also
the array half of `styleSupported`), `itemTypesSplittable` (the non-string-scalar gate);
`validateQueryArray` became the location-agnostic `validateArrayParam`. Signature, result
shape, and finding kinds still unchanged.

**Still STAGED:** path `label`/`matrix` arrays; object reconstruction (`form`/`explode=false`
+ `deepObject` flat scalar props); non-JSON request **body** schemas; string-item delimited
arrays (permanently `unverified` — the unsound class).
