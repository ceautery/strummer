# ADR 0004 — Pillar 2 (web API testing) foundations

- **Status:** Accepted
- **Date:** 2026-05-31

## Context

Pillar 2 adds Postman/Insomnia/Bruno-class web API testing. It is all-TypeScript
(collections are git-friendly files; no Python/SQLite). Grounded by a 4-stream
design-research workflow (`docs/research/2026-05-31-pillar2-api-testing.md`).

## Decisions

### 1. New package `@sackville/api`

A pure-TS engine (collection IO, HTTP runner, assertions, var/secret resolution,
contract validation, JS sandbox) consumed by thin `mcp` + `cli` adapters. The
**safety gate lives in `@sackville/api`**, so every surface enforces it identically.

### 2. Collection format: **Bruno `.bru` + a thin domain model**

Adopt Bruno's `.bru` on disk via `@usebruno/lang` (MIT, pure-JS, V2 functions),
mirroring Bruno's layout (`bruno.json`, `collection.bru`, per-folder `folder.bru`,
one `.bru` per request, `environments/<Env>.bru`). Map `.bru`-JSON into a thin
internal model so a future format change is contained. Import Postman/Insomnia/
OpenAPI via `@usebruno/converters`; HAR→`.bru` is our own small generator.

> **Update (2026-06-01):** import shipped (`import.ts` + CLI `api import`), but
> **natively, not via `@usebruno/converters`** — that package is unavailable in
> the offline dev container, and writing the normalizers ourselves (one small
> intermediate shape per source → `@usebruno/lang` `jsonToBruV2`) keeps the
> dependency set lean and the output a real Bruno collection. Postman v2.1 /
> Insomnia v4 / OpenAPI 3.x / HAR all supported; multipart/file bodies +
> non-header auth deferred.

### 3. Sackville assertions/captures: **sidecar `*.sackville.yml`**

Sackville's richer assertion sources (jsonpath, JSON-schema, responseTime) and
captures exceed Bruno's native `assert` block, so they live in a sidecar
`<request>.sackville.yml` next to each `.bru`. The `.bru` stays 100% Bruno-GUI
compatible and round-trips losslessly.

### 4. Safety: **deny-by-default for mutations**

GET/HEAD/OPTIONS run freely. POST/PUT/PATCH/DELETE **dry-run** by default
(resolve + apply secrets, return what *would* be sent, redacted, without firing);
actually sending requires an explicit unlock: run-scoped `allowUnsafe` (`--unsafe`)
**plus** a host+method allowlist. Block private/link-local/metadata ranges (SSRF),
validate the post-redirect final host+method, no auto-retry for non-idempotent
calls. Enforced server-side in `@sackville/api`.

### 5. Secrets: references + pluggable store + value-redaction

Collections reference secrets as `{{secret:NAME}}` (never inline values).
`SecretStore` backends, selected `explicit > keyring > env`:
`@napi-rs/keyring` (macOS/Win/Linux-desktop; no node-gyp) with a **mandatory env
fallback** (`SACKVILLE_SECRET_<NAME>`) for the headless Linux container/CI. Values
resolve only at the transport boundary and are **redacted** (incl. common
encodings) from every artifact/result returned to the agent.

### 6. Scriptable JS tests: **included in v1, sandboxed**

Pre/post-request JS scripts run in a WASM-isolated **QuickJS** sandbox
(`quickjs-emscripten`), never `node:vm`/`vm2`, with a curated `bru`/`expect` API.
Declarative assertions remain the first-class surface; scripts are the power-user
escape hatch.

## Stack picks

`@usebruno/lang` 0.36.x (V2 fns) · `@usebruno/converters` 0.20.x · **undici 8.x**
(installed; research recommended 7.x) (not bare fetch) · `jsonpath-plus` 10.4.0
(pinned, eval off) · `ajv` 8.20.x
(2020-12) · `openapi-backend` 5.x + `graphql-js` 16.x (contract) ·
`@napi-rs/keyring` 1.3.x · `quickjs-emscripten` · `yaml` (sidecars). **Avoid:**
keytar, vm2, `node:vm`, bare global fetch.

## Consequences

- A dependency on Bruno's Ohm grammar (format-churn risk, mitigated by the thin
  model + pinned versions).
- macOS-specific bits (Keychain, undici mTLS) need the Linux dev fallback / target
  verification.
- Larger v1 surface than a declarative-only tool (JS sandbox), per decision 6.
