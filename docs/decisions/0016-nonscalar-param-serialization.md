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

## Addendum 2 — path `label` + `matrix` array styles (2026-06-04)

Slice 7 un-stages the remaining path array styles, same soundness rule, one new wrinkle:

- **CHECKed:** path `label` (`{.ids}` → `.a,b,c` explode=false / `{.ids*}` → `.a.b.c`
  explode=true) and `matrix` (`{;ids}` → `;ids=a,b,c` / `{;ids*}` → `;ids=a;ids=b`). The
  serialized segment is decomposed by `splitArrayValue` — strip the RFC 6570 prefix
  (`.` / `;name=`), then split on the per-explode delimiter — and validated like any
  other delimited array.
- **The label-explode wrinkle:** label-explode joins elements with `.`, which is the one
  delimiter that occurs *inside* a JSON `number` (the decimal point), so a `number`-typed
  label-explode array would over-split. The soundness gate `itemTypesSplittable(types,
  usesDot)` therefore excludes `number` (allowing only `integer`/`boolean`) when the dot
  delimiter is used; every other delimiter (`,` `;` `=` ` ` `|`) admits all non-string
  scalars. `arraySplitUsesDot` flags the label-explode case.
- **Malformed serialization → `unverified`:** a segment that doesn't start with the
  expected `.` (label) or `;name=` (matrix) prefix returns `undefined` from
  `splitArrayValue` and is skipped — never a false finding.

Seams: `arrayDelimiter` generalized into `queryArrayDelimiter` + the location-aware
`arraySerializationSupported` (the array half of `styleSupported`), `splitArrayValue`
(query/header/path-simple/label/matrix decomposition), `arraySplitUsesDot`. Signature,
result shape, and finding kinds still unchanged.

**Still STAGED after this:** object reconstruction (`form`/`explode=false` + `deepObject`);
non-JSON request **body** schemas.

## Addendum 3 — object reconstruction + the `multipleOf` float guard (2026-06-04)

Slice 8 lands the last param-array-matrix cell (objects) and a cross-cutting soundness
fix the adversarial critics surfaced. Design = a 2-critic adversarial fan-out over a
drafted design (both *ship-with-fixes*; every blocker folded in). Completes the non-scalar
param matrix except `form`/`explode=true` objects (permanently out — shared namespace).

**CHECKed objects (query only):**
- **`deepObject`** (`?color[R]=100&color[G]=200`): collect `^name\[prop\]$` keys (each a
  *discrete* URL-decoded query value, so **string props are sound** — no split), coerce
  declared scalar props via the normalized per-prop type, ajv-validate the assembled
  object. Refuse → `unverified`: no flat scalar `properties`; an object-form
  `additionalProperties` (only literal `true`/`false`/absent proceed — an undeclared key
  left uncoerced would false-fail a typed schema, critic FP-5/H1); a nested (`a[b]`) or
  repeated (`string[]`) key.
- **`form`/`explode=false`** (`?color=R,100,G,200`): split on `,`, pair, coerce, ajv —
  **integer/boolean props ONLY** + `additionalProperties:false`. String props comma-cascade
  (one comma in a value misaligns every pair); number props hit the float trap below; so
  both are refused. Odd/empty split → `unverified`.

**The `multipleOf` float guard (cross-cutting):** a fractional `multipleOf` (e.g. `0.1`)
is an IEEE-754 false-positive trap — coercing a wire string to a JS float then ajv-checking
reports spec-conformant values like `0.3` as invalid (empirically confirmed:
`validateSchema({type:number,multipleOf:0.1}, 0.3)` ⇒ `valid:false`). This was **pre-existing**
in the shipped scalar (slice 2) + array (slices 4–7) number paths, not just objects. Fix
(comprehensive, human-ratified): `hasFractionalMultipleOf(schema)` → `unverified` for any
number-typed scalar carrying a fractional `multipleOf`, applied uniformly at scalar, array-
item, and object-prop coercion. An INTEGER `multipleOf` divides exactly and stays validated.
(The response-body ajv path is unchanged — that's a separate ajv-wide concern.)

**Undoc-param refinement:** the metadata branch is now a three-way EXPLICIT-explode test
(query object explode defaults to true): `deepObject` → exclude `name[...]` keys; form/
`explode===false` → declare its single `name`; else (explode true/default) → suppress the
whole pass. All in the pre-validation metadata step, so a REFUSED object still declares its
name / excludes its keys (no undoc false positive — critic H2/H3). The slice-5 deepObject
tests were updated (deepObject now validates rather than skipping).

Seams: `objectSerializationSupported` (the object half of `styleSupported`),
`validateObjectParam`, `hasFractionalMultipleOf`, `escapeRegExp`. Signature, result shape,
and finding kinds still unchanged. **Only remaining ADR 0016 tail: non-JSON request body
schemas.**

## Addendum 4 — non-JSON request BODY schemas (2026-06-04, Accepted)

Closes the last ADR 0016 tail: validate `application/x-www-form-urlencoded` and
`multipart/form-data` request bodies against the declared `requestBody.content[ct].schema`,
converting the prior presence-only `unverified` skip (request-contract.ts body block) into
real findings. Designed via a 2-stream research fan-out (OpenAPI form/multipart serialization
+ the `encoding` object; an adversarial false-positive-trap sweep); the human ratified the
scope: **urlencoded + multipart text fields over the LIVE run + direct MCP/CLI**, with
HAR-capture form bodies and per-property `encoding` handling explicitly STAGED.

**The key insight — form bodies are MORE tractable than form *params*.** A form body is a
flat field-name → string-value(s) map delivered by *discrete keys*. Under the default
serialization (`style:form`, `explode:true`) an array property arrives as **repeated keys**
(`tags=a&tags=b` → `["a","b"]`) — so even **string array items are sound** (there is no
delimiter to over-split, unlike the param world's comma/space/pipe-joined arrays). The
validation logic is therefore a near-clone of `validateObjectParam`'s coerce-declared-scalar-
props-then-ajv pattern, plus sound scalar-item arrays.

**The representation decision (load-bearing).** The highest-leverage mistake the adversarial
sweep flagged is re-parsing the already-serialized body string (lossy on percent-encoding;
impossible for multipart, which only carries a redaction-safe preview). Instead, a NEW
authoritative structured channel on `RequestFacts` — `form?: Record<string, string | string[]>`
(repeated keys → array) + `formFileFields?: string[]` (multipart file-part NAMES only, never
bytes) — is populated at PREPARE time by the runner from the structured parts. File bytes
never enter the channel; the `RequestValidationResult` shape and finding kinds are unchanged
(reuse `request-body-schema`). This is the one intentional `RequestFacts` widening (the param
work kept that shape fixed; body work legitimately needs the channel).

**CHECKed (assemble + ajv) — only when soundly reversible:**
- Scalar fields → `coerceScalar` to the declared type, ajv the assembled object.
- Array props arriving as repeated keys → the discrete elements (string items included, no
  split); a single occurrence wraps to `[v]` only when the schema carries NO cardinality
  constraint (`minItems`/`maxItems`/`uniqueItems`).
- Undeclared fields pass through as raw strings ONLY when `additionalProperties` is literal
  `true`/`false`/absent (ajv then enforces `false` as an undocumented-field violation).
- `required` is enforced via ajv on the assembled object when the caller is authoritative
  about body presence; a required field absent from a NON-authoritative source ⇒ `unverified`.

**REFUSE → `unverified` (never a false finding):**
- ANY per-property `encoding` on the matched media type (re-introduces the full style/explode
  ambiguity matrix inside the body — v1 permanently-out, staged).
- The schema isn't a flat object with `properties`; a typed (object-form)
  `additionalProperties`; a declared property that is a nested object, array-of-object, or
  typeless (in multipart the default `contentType` for a non-scalar prop is `application/json`,
  so it arrives as a JSON part, not a flat field).
- A fractional `multipleOf` on any declared scalar prop / array item (the IEEE-754 float trap).
- A scalar property arriving with repeated keys (an array on the wire).
- A single-occurrence array prop carrying a cardinality constraint (count unprovable from one
  occurrence).
- An ambiguous empty value (`field=`) for a non-string, non-null scalar prop (the wire can't
  distinguish empty / null / valueless-key).
- A declared property satisfied by a multipart FILE part (bytes never inlined, unvalidatable).
- A declared non-UTF-8 charset (the bytes→string decode may already be wrong).

**Permanently out of scope:** per-property `encoding` overrides (delimited/JSON-encoded
properties — the embedded-delimiter false-positive class); nested-object / array-of-object /
binary-array properties; object/array properties serialized as a JSON string field.

**Mechanics & invariants held.** New internal seams only (`validateFormBody`, a `formBase`
helper distinguishing the two form media types; `selectContentSchema` now also surfaces the
matched media base + its `encoding`). `validateOpenApiRequest`'s signature and
`RequestValidationResult` shape are unchanged; ZERO new `ContractFindingKind` (reuse
`request-body-schema`). Redaction: a coercion/schema finding echoes only the RAW field value
(the run-resolved secrets are registered with the redactor before the structured channel is
built, so a secret field value is scrubbed at the surface; the bridge already redacts
message+path). Absence-is-never-a-pass: every refusal sets `unverified`, folded to `noSignal`
by the capture bridge; the body block always ends in exactly one of {finding(s)} or
{`unverified`}, never examined-found-nothing-clean. No real fetch in `pnpm gate` (pure
validator + the existing in-process live-run test).

**STAGED (honest, not amputated):** HAR-capture form bodies (`harEntriesToFacts` resolving
`postData.params[]` — non-authoritative, redaction-incomplete, currently safely `unverified`);
per-property `encoding` handling (would reuse the param splitter seams). With this addendum
the ADR 0016 tail list is EMPTY.
