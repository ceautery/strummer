# ADR 0005 — Contract validation: ajv-direct, not openapi-backend

- **Status:** Accepted
- **Date:** 2026-05-31
- **Amends:** ADR 0004 (which named `openapi-backend` 5.x for OpenAPI contract
  validation).

## Context

Pillar 2's last pure-engine piece is response **contract validation**: given a
response and a contract (OpenAPI document or GraphQL schema), detect *drift* —
requests to undocumented operations, undocumented status codes, response bodies
that violate the declared schema, and saved GraphQL queries that no longer
conform to the server's current schema.

ADR 0004 picked `openapi-backend` 5.x. On implementation that choice was wrong
for our target:

1. **OpenAPI 3.1's Schema Object *is* JSON Schema 2020-12.** We already pull in
   **ajv 8.20** for the declarative `schema` assertion source, and ajv has
   first-class 2020-12 support (`ajv/dist/2020`). `openapi-backend` is a
   request-routing/mocking framework whose 3.1 / 2020-12 dialect support has
   been partial and trails ajv.
2. **We need precise, structured drift findings** (kind + JSON-Pointer location
   + severity), not a framework's boolean/throw. Driving ajv directly gives us
   exactly the finding shape the MCP/CLI surface will report.
3. **Fewer, lighter dependencies.** Reusing the ajv we already ship avoids a
   heavy framework whose routing/mocking features we don't use.

## Decision

Validate contracts **directly**, in a small in-house `contract.ts` / `graphql.ts`:

- **OpenAPI 3.1 (`validateOpenApiResponse`):** match the request path against the
  document's path templates (exact match wins; `{param}` → `[^/]+`), resolve the
  operation + the response object for the status (honoring `2XX`/`2xx` ranges and
  `default`), pull the JSON response schema, and validate the body with the
  shared ajv-2020 validator (`schema.ts`). Local `#/components/schemas/...`
  `$ref`s are rewritten into `$defs` so ajv resolves recursion natively.
- **GraphQL (`validateGraphqlOperation`):** `graphql-js` `buildSchema` + `parse` +
  `validate` for query-vs-schema drift, plus an explicit check that each
  operation's root type (`Mutation`/`Subscription`/`Query`) exists — `validate()`
  alone treats a missing root type as an execution-time error and would miss it.
  Inspects the response payload's top-level `errors` array.

Both return a shared `ContractResult` (`{ valid, findings[], operation? }`) with
`ContractFinding { kind, message, path?, severity }`. `valid` is true only when
no `error`-severity finding is present.

## Scope & known limitations (v1)

Documented deliberately; these are scheduled, not hidden:

- **Local `$ref`s only.** External/remote `$ref`s and non-schema `$ref`s
  (parameters, shared `responses`) are not resolved. A future deref step
  (e.g. `@apidevtools/json-schema-ref-parser`) can lift this.
- **OpenAPI 3.1 only.** 3.0's `nullable: true` is *not* honored (3.1 uses
  `type: ['string','null']`). Validating a 3.0 doc may give a false pass on
  nullable fields. An `openapi` version check / 3.0→3.1 shim is future work.
- **ajv `strict: false`.** Required so real-world specs (vendor `x-*` keywords,
  `example`, `discriminator`) compile. Trade-off: a *misspelled* schema keyword
  (e.g. `requried`) is silently ignored rather than erroring — a possible false
  pass on a malformed user schema. Acceptable for v1; revisit with a meta-schema
  lint pass if it bites.
- **GraphQL** validation is operation-kind aware but not `operationName`-scoped
  for multi-operation documents.

### Update (2026-06-01) — reach items lifted

Three of the limitations above are now resolved (TDD, see
`contract.ts`/`graphql.ts`). `@apidevtools/json-schema-ref-parser` was *not*
needed (and is unavailable offline in the dev container); a small in-repo
deref/shim is enough and keeps the "we own the small logic" stance:

- **External local-file `$ref` deref.** `validateOpenApiResponse(..., {baseDir})`
  inlines `./file.json#/Ptr` and `.yaml` refs, fully dereferencing the external
  file's own internal + nested-external refs (cycle-guarded) before the
  `$defs` rewrite. Main-document internal refs still flow through `$defs`.
  **Still out of scope: remote (http/https) `$ref`s** — deliberately, to avoid an
  SSRF vector in the validator — and non-schema `$ref`s.
- **OpenAPI 3.0 `nullable` shim.** When `openapi` is `3.0.x`, `{type:'X',
  nullable:true}` is rewritten to `{type:['X','null']}` (and the non-2020
  `nullable` keyword dropped) so ajv no longer gives a false *failure* on an
  explicit null. 3.1 docs are untouched.
- **`operationName`-scoped GraphQL.** `validateGraphqlOperation(sdl, query,
  {operationName})` scopes the root-type drift check to one operation of a
  multi-operation document (and flags an absent name).

## Consequences

- One validation engine (ajv 2020) serves both the `schema` assertion and
  OpenAPI bodies — less surface area, consistent error reporting.
- We own the path/status/$ref-rewrite logic (small, fully unit-tested) instead
  of a framework's. The limitations above are explicit roadmap items.
- `openapi-backend` is dropped from the dependency set; `graphql` 16.x added.
