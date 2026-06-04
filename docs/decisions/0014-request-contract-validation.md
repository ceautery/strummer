# ADR 0014 — Request-body & parameter contract validation

- **Status:** Accepted
- **Date:** 2026-06-04
- **Extends:** ADR 0005 (contract validation, ajv-direct) + ADR 0013 (cross-pillar
  verification; the absence-is-never-a-pass and redaction-before-verdict invariants).
- **Design:** forged via the `request-contract-validation-design` fan-out (4 research
  streams → synthesis → 3 adversarial critics → corrected design); the human ratified
  all four open forks.

## Context

The contract pillar validated only the **response** half of an exchange
(`validateOpenApiResponse` / `validateGraphqlOperation`). The request half — does the
request **body** conform to `requestBody`, are required path/query/header **parameters**
present and well-typed — was unchecked. Adding it deepens the cross-pillar verdict
directly: `verify_change` / `strummer verify run` (via the capture→contract bridge) and
the direct `validate_request` surface now catch request-side drift, not just response
drift.

## Decision

**Placement (fork 1, ratified):** a new sibling **`validateOpenApiRequest(spec, req,
opts)`**, parallel to `validateOpenApiResponse` — NOT a unified
`validateOpenApiExchange`, NOT an extension of the response validator. All three critics
independently failed to break this: GraphQL has no parameter/header model (an `Exchange`
name over-promises a REST-only concept), the bridge resolves the operation *inside* the
response validator and never exposes it at the call site (a unified call buys nothing the
per-entry merge doesn't), and a unified function would force `undefined`-request-facts on
every response-only caller. **Reuse is achieved by extracting shared helpers, not by
collapsing public functions:** `resolveOpenApiOperation` (path-template + method) and
`normalizeOpenApiSchema` (3.0 `nullable` shim + local/external-local-file `$ref` deref +
`$defs` merge) were lifted out of the response validator (Slice 0, behavior-preserving),
so request **body and param** schemas get identical treatment — notably the 3.0
`nullable` shim now applies to param schemas too.

**The `unverified` channel (fork 3, ratified — the load-bearing invariant fix).** The
first-pass synthesis claimed "just more findings, no new accumulator." The Invariants
critic proved that wrong against the live `clean` formula: a *warning* (e.g. a present
body to an operation that declares none, an unmatched media type, a required query param
the capture can't supply) does not touch `noSignal`, so it would launder an unverifiable
request into a **pass**. Fix: `validateOpenApiRequest` returns an out-of-band
`unverified` flag (on `RequestValidationResult`, additive/optional — the verdict shape is
UNCHANGED); the capture bridge folds `unverified` into `noSignal++` (bumped as
`request-unverified`, kept OUT of `results[]` so it never double-counts as a warning).
Since `clean` requires `noSignal === 0`, a present-but-uncheckable body / uncapturable
required param now forces `clean: false` ⇒ `fromCaptureVerdict` returns `no-signal`,
never `pass`. This is the absence-is-never-a-pass rule, holding for the request half.

**Authority.** Some request facts cannot be verified from every source. A captured HAR
cannot distinguish "no body" from "a non-JSON body the bridge dropped", and may not have
captured every param. So callers declare what they KNOW via
`bodyPresenceAuthoritative` / `paramsAuthoritative`: the direct MCP/CLI surfaces hold the
real request and set both `true` (so a required-but-absent body/param is a hard
`missing-*` finding); the capture path omits both (so the same absence is `unverified`,
never a false finding). This is what prevents the bridge from flipping prior-green
fixtures while still never passing on absence.

**Path redaction (fork 2, ratified).** Request bodies and query/header params are
secret-bearing, and a finding's `path` can carry a captured key name. So `pushResult` (the
single capture-bridge redaction chokepoint) now redacts `f.path` in addition to
`f.message`, for request AND response findings — a cheap, one-place fix that closes the
whole leak class. The `validate_request` surface applies the same message+path redaction.

**Scope (fork 4, ratified — scalars only in v1).** v1 validates: requestBody JSON-family
schemas (media-type-aware selection by Content-Type specificity); required-body presence;
scalar path/query/header params (default serializations — path/header `simple`, query
`form`) with strict whole-string coercion then ajv; undocumented **query** params
(warning; headers excluded — infra/trace headers saturate captures); local `$ref` deref
for requestBody/parameters. Everything not in scope is an **explicit inconclusive-skip**
(`unverified`), never a finding and never a false pass.

New `ContractFindingKind`s: `request-body-schema`, `missing-required-body`,
`undocumented-body` (warning), `unsupported-media-type` (warning), `missing-required-param`,
`param-schema`, `undocumented-param` (warning). No new `ContractResult`/verdict structure.

## Surfaces

- MCP `validate_request` (sibling of `validate_response`, always registered; authoritative;
  refuses a GraphQL envelope via `isGraphqlEnvelope`).
- CLI `api validate-request --openapi --method --path [--body] [--query] [--header]`.
- `validate_capture` / `verify_change` / `strummer verify run` pick up request validation
  through the bridge transparently (no input change).

## Invariants held

Absence-is-never-a-pass (the `unverified`→`noSignal` fold), redaction-before-verdict
(message + path through `pushResult`; coerced values never echoed — only the raw captured
substring), compose-never-widen (more finding kinds inside existing `ContractResult`s plus
an internal-only `noSignal` bump; verdict shape, `fromCaptureVerdict`, and `orchestrate`
untouched), and no-real-fetch-in-gate (the validator is pure; the bridge reads a stored
HAR; surfaces inject runners).

## Consequences / staged (scheduled, not amputated)

- **Live `api run --openapi` request validation — DONE (2026-06-04).** `RunResult` still
  exposes only the REDACTED `PreparedRequest` by design, so a new out-of-band channel —
  `runRequestForContract` → `{ result, capture: { request: RequestFacts, registeredSecrets } }`
  (sibling of `runRequestForHar`, populated at PREPARE time so it works even on a withheld
  dry-run) — surfaces the un-redacted request facts WITHOUT widening `RunResult`. The CLI
  `api run --openapi` drives `validateOpenApiRequest` (authoritative — it holds the real
  request) over those facts, redacts findings (message+path) via a `Redactor` rebuilt from
  `registeredSecrets`, and folds request-contract validity into the exit code alongside the
  existing response check. A GraphQL request envelope skips OpenAPI request validation
  (consistent with `validate_request`). Decided forks (human-ratified): request validation
  runs even on a dry-run (the request is fully known at prepare time — catches drift before
  unlocking `--unsafe`; exit code unchanged — a dry-run still exits non-zero); CLI-only
  (the MCP `run_request` does no inline validation at all — it keeps run/validate as
  separate tools, so an inline-validating MCP `run_request` would be a different shape, left
  unstaged here). A non-JSON / binary request body (multipart/file/urlencoded/xml) is routed
  to the validator's presence-only `unverified` path, never a false `missing-required-body`.
- Non-scalar / advanced serializations (`deepObject`, `pipeDelimited`, CSV/explode arrays,
  object-valued, content-typed, cookie params), `label`/`matrix` and multi-param-per-segment
  path templates, non-local/cross-document `$ref`, non-JSON body schemas (XML/multipart/
  urlencoded — presence-only in v1), and GraphQL-request variable validation against SDL.
