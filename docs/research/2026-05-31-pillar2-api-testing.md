# Pillar 2 design research — 2026-05-31

Raw output of the 4-stream API-testing research workflow + synthesis. Distilled into ARCHITECTURE.md.

## Synthesis

This is a synthesis/architecture task — no tools needed. I'll produce the milestone plan directly.

# Sackville Pillar 2 (`@sackville-mcp/api`) — Milestone Plan

## 1. Package layout

New leaf package `@sackville-mcp/api` (pure TS, agent-agnostic). It owns the domain model, file IO, HTTP runner, assertions, secret resolution, and contract validation. `mcp` and `cli` are thin adapters that depend on it; they contain no HTTP/assertion logic.

```
packages/
  core/            # existing shared types/utils
  api/             # NEW @sackville-mcp/api — the engine
    src/
      collection/  # .bru <-> domain model (wraps @usebruno/lang), on-disk layout
      runner/      # undici dispatcher, request execution, timing capture
      assert/      # declarative assertion engine + ajv/jsonpath
      vars/        # layered scope resolver, {{var}} interpolation, captures
      secrets/     # SecretStore interface + keyring/env backends + Redactor
      contract/    # OpenAPI 3.1 (openapi-backend) + GraphQL validation
      artifacts/   # resource-handle store for bodies/HAR (sackville://run/<id>/body)
      index.ts     # public API surface
    test/
      fixtures/    # .bru sample collections, sample OpenAPI specs
  embed/
  mcp/             # adds run_request/list_requests/... tools -> calls @sackville-mcp/api
  cli/             # `sackville run`, `sackville list` -> calls @sackville-mcp/api
```

Consumption contract: `@sackville-mcp/api` exposes a `Runner` facade returning **structured results + an artifact handle** (never inlined large bodies). `mcp` maps that 1:1 onto MCP `structuredContent` + `resource_link`; `cli` renders the same struct to a terminal table and writes artifacts to disk. The **safety gate (deny-by-default mutation) lives in `@sackville-mcp/api`**, not in mcp/cli, so both adapters and any future embed get identical enforcement.

## 2. DECISION — Collection format: **ADOPT Bruno `.bru` + `@usebruno/lang`**

Rationale (decisive, not close):
- Instant ecosystem interop — Sackville collections open in Bruno's GUI and run under `@usebruno/cli`; we can open any existing Bruno repo. We avoid building and forever maintaining a parser + a Bruno import/export bridge.
- `@usebruno/lang` is MIT, pure JS/WASM-free (ohm-js/arcsecond/lodash, no native bindings) → builds identically on the Linux aarch64 dev container and the macOS target. No platform fallback.
- One-file-per-request + plain folders is the most diff-friendly and LLM-authorable candidate — exactly the agent-first thesis.
- `@usebruno/converters` gives Postman/Insomnia/OpenAPI import for free.

Guardrails on the dependency: pin `@usebruno/lang` to the **published 0.36.x** (the repo's package.json may understate the version) and use the **V2** functions only (`bruToJsonV2`/`jsonToBruV2`, `collectionBruToJson`/`jsonToCollectionBru`, `bruToEnvJsonV2`/`envJsonToBruV2`). Use the **`.bru` DSL, not** the OpenCollection `.yml` variant, and never mix the two in one collection. Map `.bru`-JSON into a **thin internal domain model** so a future format swap is contained. Build our own small **HAR 1.2 → .bru** generator (converters don't cover HAR) and scrub secrets before writing.

On-disk layout = mirror Bruno exactly (`bruno.json`, `collection.bru`, per-folder `folder.bru`, one `.bru` per request, `environments/<Env>.bru`, gitignored `.env`). We do **not** invent a YAML/TOML format. We add our own assertion/capture blocks (below) only where `.bru` can't already express them, preferring its native `assert` block first.

## 3. Secret resolution + storage

Three layers: references in git, pluggable store, value-based redactor.

- **References (committed):** collections contain `{{secret:NAME}}` (distinct from ordinary `{{var}}`). A lint step rejects committing a high-entropy literal in a secret-typed field.
- **Store interface:** `interface SecretStore { get(name): Promise<string|undefined>; set(name,value); delete(name); list(): Promise<string[]> }`.
- **Backends, selected by `explicit config > keyring > env`:**
  - `keyring` (primary, macOS/Windows/Linux-desktop): **`@napi-rs/keyring` ^1.3.0** (prebuilt binaries for macos-arm64, linux-arm64-gnu, linux-x64-musl, win32-arm64-msvc; no node-gyp). Service name `sackville`, account = secret NAME. Wrap `get/set` in try/catch — Secret Service needs dbus + an unlocked daemon and throws at **runtime** (not install) in headless containers.
  - `env` (required Linux dev/CI fallback, zero native deps): read `SACKVILLE_SECRET_<NAME>`, optionally from a gitignored `.sackville/secrets.env` kept **separate from the collection dir**.
  - `security-cli` (optional, later, macOS-only): `find-generic-password -w` via stdout, write via stdin/temp — **never** secret in argv.
- **Redactor (value-based, per run):** resolve `{{secret:NAME}}` only at the transport boundary, inside the runner; register the cleartext in a per-run set; before any artifact crosses back to the agent (body, headers incl. `Authorization`, error text, redirect URLs, logs, resource-handle reads) do exact-substring replacement with `[redacted:NAME]`. Also redact common encodings (base64/url-encoded) of registered values. `get_request` reports **required secret names** without resolving them.

Do **not** use keytar (archived). Do **not** rely on the global proxy/`security` argv path.

## 4. HTTP runner + assertion model

- **Engine: `undici` 7.x directly** (not bare global fetch — fetch hides the dispatcher, ignores env proxy on Node 22, and can't reliably attach mTLS or measure timing). Use undici's lower-level `request()` so we control body consumption and measure TTFB vs full-body. Per-run dispatcher: `new Agent({connect:{cert,key,ca,rejectUnauthorized}}).compose(retry, redirect, dump)` — remember **compose order is reversed** (last listed runs first). Layer `EnvHttpProxyAgent`/`ProxyAgent` when configured. **Integration-test mTLS on the real macOS target** (undici #4034 divergence from `https.Agent`).
- **Declarative assertions are the first-class surface** (JS scripts are an opt-in sandboxed escape hatch only — and only QuickJS-WASM via `quickjs-emscripten`, never `node:vm`/`vm2`).

Assertion + capture shape (per request):
```yaml
assertions:
  - { source: status,       op: equals,   value: 200 }
  - { source: header, name: content-type, op: contains, value: application/json }
  - { source: jsonpath, path: "$.data.id", op: exists }
  - { source: jsonpath, path: "$.items.length", op: gt, value: 0 }
  - { source: responseTime, op: lt, value: 800 }     # ms
  - { source: schema, ref: ./schemas/user.json }      # ajv 2020-12
captures:
  - { var: authToken, source: jsonpath, path: "$.token" }
  - { var: userId,    source: jsonpath, path: "$.user.id" }
  - { var: reqId,     source: header, name: x-request-id }
```
- `source`: `status|statusText|header|body|jsonpath|responseTime|schema`. `op`: `equals/notEquals, gt/gte/lt/lte, contains/notContains, matches, exists/notExists, oneOf, type, isEmpty`.
- **JSONPath:** `jsonpath-plus` pinned **10.4.0** with **eval/script-expression disabled** (unmaintained + historical eval CVEs — pin and isolate). **Schema:** `ajv` 8.20.x with the **2020-12 dialect** (`ajv/dist/2020`), compile-and-cache validators.
- Results returned as structured rows `{source, path, op, expected, actual, pass}` — small, agent-facing. Large bodies returned by **resource handle**, never inlined.
- **Variables/chaining:** layered resolver precedence `runtime/captured > request > folder > collection > environment`; interpolate URL/headers/query/body before dispatch; `captures` write into the runtime scope so later requests use `{{authToken}}`. `{{$env.NAME}}` sources from `process.env` for redaction-friendly env values.

## 5. MCP tool set + default safety posture

Small, workflow-shaped (not a 1:1 REST wrapper), each with `outputSchema` and accurate (but advisory) annotations:
1. `list_requests` — paginated, concise (`readOnlyHint`).
2. `get_request` — resolved request incl. **which `{{secret:NAME}}` it needs, never values** (`readOnlyHint`).
3. `run_request {requestId|inline, dryRun?, confirm?, idempotent?, responseFormat?}` — the workhorse. Returns `structuredContent {status, latencyMs, assertions[], bodyHandle}` + emits body as `resource_link sackville://run/<id>/body`. Inline only under ~2k tokens, always offer the handle.
4. `run_collection {collectionId, stopOnFailure?, dryRun?}` — `readOnlyHint` only if every member is safe, else `destructiveHint`.
5. `validate_response` — response handle + spec ref → structured drift report (`readOnlyHint`).

**DEFAULT SAFETY POSTURE = deny-by-default for mutation, enforced server-side in `@sackville-mcp/api`:**
- GET/HEAD/OPTIONS execute freely.
- POST/PUT/PATCH/DELETE are by default **(a) dry-run only** — resolve, apply secrets, return what *would* be sent (method, URL, redacted headers, body shape) without firing — and **(b)** require the run to be in an **unlocked** state to actually send.
- Unlock = explicit auditable gate: run-scoped `allowUnsafe:true` (`--unsafe`) **plus** a host+method allowlist, optionally a `confirm` token echoing a server-issued challenge.
- `idempotent:true` permits auto-retry/backoff; non-idempotent unsafe calls never auto-retry and require an `Idempotency-Key`. Keep **destructive and idempotent as independent axes** (DELETE is idempotent yet destructive).
- Validate **post-redirect** final host+method against the allowlist (block private/link-local/metadata ranges — SSRF). Rate-limit + exponential backoff. Treat annotations as UI hints only — the spec says clients may not trust them.

**Contract validation:** `openapi-backend` (framework-agnostic, Ajv-**2020-12**) for OpenAPI 3.1 response validation → structured drift `{missingRequired[], typeMismatch[], unexpectedField[], statusMismatch, contentTypeMismatch}`. GraphQL: `graphql-js` `validate`/`buildClientSchema` against introspection for response-vs-schema (note GraphQL returns 200 with an `errors` array — don't assert on status alone); `graphql-inspector` only for schema-vs-schema diffing. Wired as opt-in `specRef` on `run_request` and as the dedicated `validate_response` tool.

## 6. Exact library/version picks

| Concern | Pick | Version | Confidence |
|---|---|---|---|
| .bru parse/serialize | `@usebruno/lang` (V2 fns) | 0.36.x (pin) | High; **flag: repo may understate version, verify installed exports** |
| Import Postman/Insomnia/OpenAPI | `@usebruno/converters` | 0.20.x | High |
| HTTP engine | `undici` | 7.x | High |
| JSONPath | `jsonpath-plus` | **10.4.0 (pin, eval off)** | Med — **unmaintained, CVE history; isolate/budget replacement** |
| JSON Schema | `ajv` + `ajv/dist/2020` | 8.20.x | High |
| OpenAPI 3.1 validation | `openapi-backend` | 5.x | Med-High — confirm standalone `validateResponse` ergonomics |
| GraphQL contract | `graphql-js` (+ `graphql-inspector` for diffs) | 16.x | High |
| Secret store | `@napi-rs/keyring` | **1.3.0** | High; **flag: Linux Secret Service runtime failure → env fallback mandatory** |
| JS sandbox (escape hatch only) | `quickjs-emscripten` (RELEASE_SYNC) | current | High |
| MCP SDK | (existing) | 1.29 | High |
| **AVOID** | `keytar`, `vm2`, `node:vm` as sandbox, bare global fetch | — | High |

Low-confidence / verify-before-coding: `@usebruno/lang` exact published version + V2 export names; `jsonpath-plus` maintenance risk; `openapi-backend` non-Express response-validation API surface; undici mTLS parity on macOS.

## 7. UNKNOWNS (prioritized) and human DECISIONS

**Unknowns to resolve early:**
1. Does `@usebruno/lang` 0.36.x round-trip our *added* assertion/capture blocks losslessly, or do we need a sidecar file? (Bruno's native `assert` may not cover schema/responseTime sources.)
2. `openapi-backend` `validateResponse` usability outside Express + its Ajv-2020 wiring for OAS 3.1.
3. undici mTLS client-cert behavior on the actual macOS target (#4034).
4. `jsonpath-plus` longevity — do we vendor or pick an alternative now?
5. Headless-container reliability of `@napi-rs/keyring` Secret Service path (assume it fails → env fallback is the real Linux path).

**Decisions a human should weigh in on before coding (3–4):**
1. **Format lock-in:** Accept the `@usebruno/lang`/Ohm grammar dependency and Bruno's format-churn risk (v2→v3 precedent), or keep a thin domain model + own serializer as insurance? (Recommendation: adopt + thin model.)
2. **Assertion extension strategy:** Extend `.bru` with new blocks (risking Bruno-GUI incompatibility on those blocks) vs. a sidecar `*.sackville.yml` per request for Sackville-only assertions/captures.
3. **Default mutation posture strictness:** Is dry-run-by-default + allowlist + `--unsafe` acceptable as the *only* path to send mutations, or do we also need a global read-only mode and an audit log requirement for v1?
4. **JS-script escape hatch in v1 or deferred:** Ship declarative-only first (recommended) vs. include QuickJS sandbox now (adds ~1.3MB + a curated `bru`/`expect` API surface to design).

## 8. Smallest first red→green TDD slice

Goal: prove the core spine — **load a request from a `.bru` collection on disk, execute it against a local server, evaluate one declarative assertion, return a structured result** — with **zero external network** in tests.

- **Fixture:** `packages/api/test/fixtures/sample/` containing `bruno.json`, `collection.bru`, and `get-health.bru` (method GET, `url: {{baseUrl}}/health`, one assertion `{source: status, op: equals, value: 200}` and `{source: jsonpath, path: "$.ok", op: equals, value: true}`).
- **Test harness server:** spin an in-process `node:http` server bound to `127.0.0.1:0` (ephemeral port) inside the Vitest `beforeAll`, responding `200 {"ok":true}` on `/health`. Set `baseUrl` env to its address. No outbound network; deterministic.
- **Red:** write `runner.runRequest(loadCollection(dir), 'get-health')` returning `{status, latencyMs, assertions[]}`; assert `result.status === 200`, both assertion rows `pass: true`, and `result.bodyHandle` is a `sackville://` URI (not inlined). Initially fails (functions unimplemented).
- **Green path implemented in order:** (1) `collection/` load via `@usebruno/lang` `bruToJsonV2` → domain model; (2) `vars/` interpolate `{{baseUrl}}`; (3) `runner/` undici `request()` against the local server with `performance.now()` timing; (4) `assert/` evaluate status + jsonpath rows; (5) `artifacts/` store body, return handle.
- **Why this slice:** exercises file format, var interpolation, undici, declarative assertions, and the resource-handle discipline in one vertical, while staying fully offline. Secrets, mutation gating, contract validation, and MCP wiring are deliberately out of this first slice and layered on next.

Relevant target paths (all under the new package): `/workspace/packages/api/src/{collection,vars,runner,assert,artifacts}/`, fixtures at `/workspace/packages/api/test/fixtures/sample/`.

## Findings by stream

### 2026 API-request collection formats for a git-friendly, agent-editable web API testing tool (Sackville Pillar 2)
**Confidence:** high

**Recommendation:** ADOPT Bruno `.bru` as Sackville's native on-disk format and depend on @usebruno/lang for parse/serialize rather than inventing a YAML/TOML format. Rationale: (1) instant ecosystem compatibility — collections authored in/by Sackville open directly in Bruno's GUI and run under @usebruno/cli, and Sackville can open any existing Bruno repo; (2) @usebruno/lang is MIT, pure-JS, no native deps, so it builds identically in your Linux aarch64 dev container and on the macOS target — no platform fallback needed; (3) `.bru`'s one-file-per-request + plain-folder layout is the most diff-friendly and LLM-authorable of all the candidates, which is exactly Sackville's agent-first thesis; (4) you avoid maintaining a parser, a Bruno importer/exporter, AND fighting users who already have Bruno collections.

Concrete plan:
- Add `@usebruno/lang` (0.36.x) for round-tripping .bru<->JSON, and `@usebruno/converters` (0.20.x) for import. Optionally `@usebruno/schema` (0.26.x) to validate before serialize. Consider `@usebruno/filestore` (0.9.x) if you want one API that abstracts .bru vs .yml file IO.
- Define a thin Sackville TS domain model and map it to @usebruno/lang's JSON shape (bruToJsonV2/jsonToBruV2 for requests, collectionBruToJson/jsonToCollectionBru for collection.bru, bruToEnvJsonV2/envJsonToBruV2 for environments). Keep your agent-first 'return large artifacts by resource handle' rule for big response bodies / HAR captures.
- Import: Postman v2.1, Insomnia v4/v5, and OpenAPI all go through @usebruno/converters -> .bru on disk. Treat HAR 1.2 as a 'record traffic' source and write your own small HAR->.bru generator (HAR is trivial JSON; converters don't cover it).
- Use Bruno's own `.env`/secret handling pattern so secrets stay out of git.

Recommended on-disk layout (mirror Bruno exactly so files are interoperable):
```
my-api-tests/
  bruno.json                 # {"version":"1","name":"my-api-tests","type":"collection"}
  collection.bru             # collection-level auth/headers/vars/scripts/docs
  .env                       # secrets, gitignored
  .gitignore
  auth/
    folder.bru               # folder-level settings (auth:inherit, shared headers)
    login.bru                # one request per file
    refresh.bru
  users/
    folder.bru
    list-users.bru
    create-user.bru
  environments/
    Local.bru
    Staging.bru
    Production.bru
```
Each request `.bru` uses the standard blocks: meta / <method> / params:query / params:path / headers / auth:<mode> / body:<type> / vars:pre-request / vars:post-response / assert / script:pre-request / script:post-response / tests / docs.

Only define a native format if you hit a hard limitation of .bru (e.g. a test construct it can't express). Even then, prefer extending via the `docs`/script blocks or a sidecar file over forking the format.

**Versions:**
- @usebruno/lang 0.36.0 (MIT)
- @usebruno/converters 0.20.0 (MIT)
- @usebruno/schema 0.26.0 (MIT)
- @usebruno/filestore 0.9.0
- @usebruno/cli 3.4.2
- Postman Collection Format v2.1.0 (draft-07 JSON Schema)
- Insomnia format v5 (collection.insomnia.rest/5.0, YAML)
- HAR 1.2
- openapi-to-postmanv2 6.x
- ohm-js ^16.6 / arcsecond ^5 (transitive deps of @usebruno/lang)

**Gotchas:**
- @usebruno/lang versions matter: package.json on main may show an older version (0.12.0) than what is published to npm (0.36.0). Pin to the current published 0.36.x and verify the exact exports against the installed version — the v1 vs v2 grammar split means you want the V2 functions (bruToJsonV2/jsonToBruV2).
- .bru is a custom DSL, NOT YAML/JSON — you cannot hand it to a generic YAML parser. You are taking a dependency on @usebruno/lang's Ohm.js grammar and its evolution. Bruno had a v2->v3 breaking-change cycle, so expect occasional format/parser churn and pin versions.
- @usebruno/lang depends on both arcsecond and ohm-js (two parser libs) plus lodash; it's pure JS so no aarch64/macOS native-build issue, but it does pull lodash into your bundle.
- Bruno offers TWO on-disk formats: the default .bru DSL and a YAML 'OpenCollection' (opencollection.yml + .yml files). Don't mix them in one collection — the format is chosen at the collection level and tooling routes by extension. Pick .bru for best diff/hand-edit ergonomics.
- Postman v2.1 stores scripts as arrays of code-line strings inside event[] objects and uses a nested url object (raw + host[] + path[] + query[]) — a naive importer that only reads url.raw will lose structured query/path data. Use @usebruno/converters rather than hand-rolling.
- Insomnia v5 YAML import has had reported breakage ('No importers found for file', Kong/insomnia #8504); validate round-trips and keep v4 JSON import as a fallback path.
- HAR is NOT covered by @usebruno/converters — you must build HAR->.bru yourself. Also HAR entries embed response bodies/cookies/auth headers (secrets); scrub sensitive fields before committing generated artifacts to git.
- Bruno's `tests` block uses a Chai/expect runtime executed inside Bruno/@usebruno/cli. If Sackville runs tests itself, you must reimplement or embed that JS runtime; the .bru file only stores the script text, it doesn't execute anything.

**Citations:**
- [Bru Tag Reference - Bruno Docs](https://docs.usebruno.com/bru-lang/tag-reference)
- [BRU Language Format - DeepWiki (usebruno/bruno)](https://deepwiki.com/usebruno/bruno/5.1-bru-language-format)
- [@usebruno/lang - npm](https://www.npmjs.com/package/@usebruno/lang)
- [bruno-lang v2 request.bru fixture (block syntax source of truth)](https://github.com/usebruno/bruno/blob/main/packages/bruno-lang/v2/tests/fixtures/request.bru)
- [Bruno Converters - Bruno Docs](https://docs.usebruno.com/converters/overview)
- [@usebruno/converters - npm](https://www.npmjs.com/package/@usebruno/converters)
- [Programmatically Convert Postman, Insomnia, OpenAPI to Bruno - Bruno Blog](https://blog.usebruno.com/programmatically-convert-postman-insomnia-openapi-to-bruno-format)
- [Postman Collection Format v2.1.0 Schema Documentation](https://schema.postman.com/collection/json/v2.1.0/draft-07/docs/index.html)
- [Insomnia Format v5 (PR #8209) - Kong/insomnia](https://github.com/Kong/insomnia/pull/8209)
- [Import and export reference for Insomnia - Kong Docs](https://developer.konghq.com/insomnia/import-export/)
- [HAR 1.2 Spec - Software is hard](http://www.softwareishard.com/blog/har-12-spec/)
- [openapi-to-postman - postmanlabs (GitHub)](https://github.com/postmanlabs/openapi-to-postman)
- [Bruno v2 -> v3: Breaking Changes - Bruno Blog](https://blog.usebruno.com/bruno-v2-v3-breaking-changes)

### Secrets handling for Sackville Pillar 2 (web API testing): keep secrets out of git-tracked collections, never expose raw values to the LLM agent, OS-native storage with a Linux dev fallback
**Confidence:** high

**Recommendation:** Adopt a three-layer design.\n\n1) REFERENCES IN COLLECTIONS (git-friendly): Use the syntax {{secret:NAME}} (distinct from ordinary {{var}} interpolation) in the .bru/.yaml/.json collection files. These files are committed; only the names are. Add a lint/scan step that rejects committing a literal that matches a known-high-entropy/token pattern in a field that should be a secret ref.\n\n2) STORAGE via a SecretStore interface. Define `interface SecretStore { get(name): Promise<string|undefined>; set(name,value); delete(name); list(): Promise<string[]> }`. Implement backends and pick at runtime by availability/config:\n - `keyring` backend: @napi-rs/keyring ^1.3.0 — primary on macOS (Keychain) and Windows, and on Linux desktops with a keyring daemon. Use a fixed service name e.g. `sackville` and the secret NAME as the account. Prefer this over the `security` CLI everywhere because it avoids argv leakage and is cross-platform with one dependency.\n - `env` backend (Linux dev container / CI fallback): read SACKVILLE_SECRET_<NAME> from the environment, optionally loaded from a gitignored .sackville/secrets.env. Zero native deps; works headless where Secret Service/dbus is unavailable. This is your required Linux dev fallback.\n - (optional, later) `security-cli` backend for macOS-only zero-native-dependency installs: use `find-generic-password -w` reading stdout, and write via add-generic-password with the value passed over a temp/stdin path — never put the secret in argv.\n Select order: explicit config > keyring (if the native module loads AND store is reachable) > env. Catch the keyring load/Secret-Service error and transparently degrade to env in the container.\n\n3) RESOLUTION + REDACTION in the runner (the agent never sees values). The MCP/CLI runner resolves {{secret:NAME}} immediately before issuing the HTTP request, keeps the cleartext only inside the request execution scope, and registers each resolved value in a per-run Redactor. Before ANY artifact crosses back to the agent (response body, headers, captured request, errors, logs, and especially your by-resource-handle large-artifact reads), run it through the Redactor which does exact-substring replacement of every registered secret with `[redacted:NAME]`. Also auto-redact common auth headers. Never log the cleartext, never return it in tool output, and scrub it from saved run artifacts.\n\nNet: one runtime dependency (@napi-rs/keyring ^1.3.0) plus an env-var fallback backend and a value-based redactor. This satisfies (a) no secrets in git and (b) the agent only ever handles names, never values.

**Versions:**
- @napi-rs/keyring 1.3.0 (published ~April 30 2026) — primary recommendation
- @napi-rs/keyring platform packages confirmed published: linux-arm64-gnu, linux-x64-musl, win32-arm64-msvc (prebuilt, no native build)
- keytar — AVOID: Atom org archived 2022-12-15, keytar repo archived ~March 2026, unmaintained
- Node.js 22 (matches Sackville's existing toolchain; @napi-rs/keyring prebuilds target current Node ABIs)
- Bruno secret management (reference peer) — current docs as of 2026; OS-level encryption with AES-256 fallback, external secret-manager integrations in Ultimate/paid tier

**Gotchas:**
- Do NOT pass secret values as CLI arguments to the macOS `security` tool — they appear in the process list (ps aux). If you implement a security-CLI backend, read with find-generic-password -w (stdout only) and write via stdin/temp, never argv.
- @napi-rs/keyring on Linux uses Secret Service, which generally needs a dbus session and an unlocked keyring daemon. In your headless aarch64 container this can throw at runtime, not install time — wrap get/set in try/catch and degrade to the env backend; don't let the keyring backend be the only path on Linux.
- keytar's `findCredentials` and some edge behaviors aren't always 1:1 across libraries; if you ever need keytar API compat, validate findCredentials specifically. Prefer designing to your own SecretStore interface rather than to keytar's surface.
- Redaction must operate on VALUES, not on the {{secret:NAME}} token. After resolution the cleartext can appear anywhere the upstream API echoes it (JSON body, Set-Cookie, error text, redirects). Reference-only masking will leak. Register the resolved value and do exact-substring scrubbing on all outbound artifacts.
- Beware partial/encoded leakage: a token may appear base64-encoded inside an Authorization header or URL-encoded in a query string. At minimum redact the raw value and the Authorization header; consider redacting common encodings of registered secrets.
- macOS Keychain auto-allows /usr/bin/security access once an item is created with the right ACL — convenient but means any process invoking `security` can read it. Native @napi-rs/keyring scoping by service+account is cleaner; pick one consistent service name and document it.
- Don't store secrets in the same file as the collection even if gitignored-by-default; a future `git add -A` or export feature can leak them. Keep the env/.env fallback file in a separate, clearly gitignored location (e.g. .sackville/) and add it to the tool's own .gitignore template.
- Electron safeStorage shows up in search results as a keytar replacement but is Electron-only — not applicable to a Node CLI/MCP server. Ignore it for Sackville.

**Citations:**
- [@napi-rs/keyring - npm](https://www.npmjs.com/package/@napi-rs/keyring?activeTab=readme)
- [Brooooooklyn/keyring-node (GitHub)](https://github.com/Brooooooklyn/keyring-node)
- [@napi-rs/keyring-linux-arm64-gnu - npm](https://www.npmjs.com/package/@napi-rs/keyring-linux-arm64-gnu)
- [@napi-rs/keyring-win32-arm64-msvc - npm](https://www.npmjs.com/package/@napi-rs/keyring-win32-arm64-msvc)
- [Migrate msal-node-extensions to use @napi-rs/keyring instead of keytar (Issue #7170)](https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170)
- [atom/node-keytar (archived)](https://github.com/atom/node-keytar)
- [keytar - npm](https://www.npmjs.com/package/keytar)
- [Bruno Docs — Secret Management Overview](https://docs.usebruno.com/secrets-management/overview)
- [Managing Secrets in Bruno: A Secure and Simple Approach](https://blog.usebruno.com/managing-secrets)
- [secret-tool: support headless environments (GNOME/libsecret #27)](https://gitlab.gnome.org/GNOME/libsecret/-/issues/27)
- [Configuring secure credential storage on headless Linux — Zowe Docs](https://docs.zowe.org/stable/user-guide/cli-configure-scs-on-headless-linux-os/)
- [Get Password from Keychain in Shell Scripts — Scripting OS X](https://scriptingosx.com/2021/04/get-password-from-keychain-in-shell-scripts/)
- [cross-keychain - npm](https://www.npmjs.com/package/cross-keychain)

### HTTP request runner + assertions for Sackville Pillar 2 (web API testing, all-TypeScript, Node 22, agent-first)
**Confidence:** high

**Recommendation:** Adopt undici directly as the HTTP engine (add `undici` as an explicit dependency; do not rely on the global fetch). Wrap each request in a thin runner that builds a per-run dispatcher via `new Agent({connect:{...mTLS}}).compose(retryInterceptor, redirectInterceptor, dumpInterceptor)` and, when a proxy is configured, layer ProxyAgent/EnvHttpProxyAgent. Use undici's lower-level `request()` (not `fetch()`) so you control body consumption and can record status, all headers, redirect chain, and timing (wrap with performance.now()/hrtime for total + TTFB). This gives deterministic, fully-captured responses — exactly what an agent needs to assert against.

Make the declarative assertion schema the primary, first-class surface. Proposed shape (per request, in the collection file):
  assertions:
    - { source: status, op: equals, value: 200 }
    - { source: header, name: content-type, op: contains, value: application/json }
    - { source: jsonpath, path: "$.data.id", op: exists }
    - { source: jsonpath, path: "$.items.length", op: gt, value: 0 }
    - { source: responseTime, op: lt, value: 800 }   # ms budget
    - { source: schema, ref: ./schemas/user.json }   # ajv-validated
Operators: equals/notEquals, gt/gte/lt/lte, contains/notContains, matches (regex), exists/notExists, oneOf, type (typeof), isEmpty. `source` is one of status|statusText|header|body|jsonpath|responseTime|schema. JSONPath via jsonpath-plus (pinned 10.4.0, eval disabled); schema via ajv (compile-and-cache, draft 2020-12). Return assertion results as structured pass/fail rows (path, op, expected, actual) — agent-readable, and large response bodies returned by resource handle per your agent-first design, not inlined.

Request-chaining/capture model: after a response, evaluate a declarative `captures` (a.k.a. post-response vars) block that writes named variables into a runtime scope:
  captures:
    - { var: authToken, source: jsonpath, path: "$.token" }
    - { var: userId,    source: jsonpath, path: "$.user.id" }
    - { var: reqId,     source: header, name: x-request-id }
Subsequent requests reference them via {{authToken}}. Implement a layered variable resolver with precedence runtime/captured > request > folder > collection > environment, and an interpolation pass over URL, headers, query, and body before dispatch. Keep environments as separate git-friendly files (e.g. environments/*.env.json or .bru-style) so they diff cleanly and secrets can be redacted/sourced from process.env via {{$env.NAME}}.

Security / JS scripts: ship declarative-only for v1. If/when you add scriptable tests, do NOT use node:vm and NEVER vm2. For an agent-driven, cross-platform (Linux-aarch64 dev / macOS target) tool, default to quickjs-emscripten (WASM, no native build, easy on both platforms) with a curated `bru`/`expect`-like API injected and strict time/memory/instruction limits and no host I/O. Reserve isolated-vm only if you later need near-native script perf and are willing to maintain native builds for both architectures. This keeps the safe, agent-generatable path declarative while making the escape hatch genuinely sandboxed.

**Versions:**
- Node.js 22 (LTS) — runtime target
- undici 7.x (current major; same engine as Node 22 built-in fetch)
- jsonpath-plus 10.4.0 (current, but unmaintained — pin and isolate)
- ajv 8.20.0 (JSON Schema draft-07/2019-09/2020-12 + JTD; ajv-draft-04 for draft-04)
- quickjs-emscripten (QuickJS vendored 2025-09-13, updated 2026-02; RELEASE_SYNC variant, quickjs-emscripten-core + @jitl/quickjs-wasmfile-release-sync ~1.3MB)
- isolated-vm (native V8-isolate addon — alternative, heavier sandbox option)
- vm2 — AVOID (dead, critical sandbox-escape CVE Jan 2026)

**Gotchas:**
- Do NOT depend on bare global fetch for a test runner: no per-call dispatcher ergonomics, no env-proxy on Node <24, and you cannot reliably attach mTLS client certs or measure timing. Use undici directly.
- Interceptor composition order is reversed: in dispatcher.compose(a, b, c) the LAST listed (c) runs first. Order retry/redirect/dump deliberately or you'll get surprising retry-after-redirect behavior.
- undici mTLS has reported divergence from native https.Agent (nodejs/undici#4034) — you MUST integration-test client-cert auth on the actual macOS target, not assume parity.
- Redirect handling in undici/fetch has had edge-case bugs (e.g. IPv6 / cross-host redirect URL resolution); if you need to assert on the redirect CHAIN (each hop's status/Location), use the redirect interceptor with maxRedirections and capture history rather than relying on fetch's opaque followed redirect.
- jsonpath-plus is unmaintained and has a history of eval/RCE CVEs through its script-expression syntax `[(...)]` and `[?(...)]`. Disable the eval/sandbox-script features (set its `eval` option off) since you'll be running it against untrusted server responses.
- node:vm and especially vm2 are NOT sandboxes (vm2 had a fresh critical escape CVE in Jan 2026). Never route untrusted/user JS test scripts through them.
- ajv: response schema validation needs the right draft and compiled-validator caching; recompiling per request is slow. Also enable `allErrors` only for reporting, not in hot paths, and beware that strict mode rejects some loose schemas users may write.
- QuickJS asyncified WASM build is 2x size and ~40% the speed of RELEASE_SYNC — only use asyncify if scripts must await host async; otherwise stick to RELEASE_SYNC.
- Storing environment files in git invites secret leakage — design {{$env.X}} / process.env sourcing and redaction from day one so tokens/certs never land in committed collection files.
- Don't inline large response bodies into agent output; per Sackville's agent-first design return them by resource handle. Assertion result rows (expected/actual/path) are the small, agent-facing payload.

**Citations:**
- [Node.js Undici (official site)](https://undici.nodejs.org/)
- [nodejs/undici — HTTP/1.1 client (GitHub)](https://github.com/nodejs/undici)
- [undici Dispatcher API (interceptors, compose)](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md)
- [undici RetryHandler API](https://github.com/nodejs/undici/blob/main/docs/docs/api/RetryHandler.md)
- [undici EnvHttpProxyAgent API](https://github.com/nodejs/undici/blob/main/docs/docs/api/EnvHttpProxyAgent.md)
- [undici / native fetch not working with mTLS (issue #4034)](https://github.com/nodejs/undici/issues/4034)
- [Node.js Fetch API: What Every Tutorial Skips (2026 Guide)](https://thunderbit.com/blog/nodejs-fetch-api-guide)
- [Bruno Docs — JavaScript API Reference (assert vs tests, bru API)](https://docs.usebruno.com/testing/script/javascript-reference)
- [Bruno Docs — Request Chaining](https://bruno-docs.vercel.app/testing/script/request-chaining)
- [Bruno — Post-Response Scripts and Tests (DeepWiki)](https://deepwiki.com/usebruno/bruno/4.3-post-response-scripts-and-tests)
- [jsonpath-plus — npm (10.4.0)](https://www.npmjs.com/package/jsonpath-plus)
- [jsonpath-plus — Snyk (security/maintenance)](https://security.snyk.io/package/npm/jsonpath-plus)
- [Ajv JSON schema validator (official)](https://ajv.js.org/)
- [ajv-validator/ajv (GitHub)](https://github.com/ajv-validator/ajv)
- [node:vm Is Not a Sandbox. Stop Using It Like One.](https://dev.to/dendrite_soup/nodevm-is-not-a-sandbox-stop-using-it-like-one-2f74)
- [Node.js vm Module Is Not a Security Mechanism (Offensive360)](https://offensive360.com/blog/nodejs-vm-module-security-risks/)
- [Critical vm2 Node.js Flaw Allows Sandbox Escape (Jan 2026)](https://thehackernews.com/2026/01/critical-vm2-nodejs-flaw-allows-sandbox.html)
- [laverdet/isolated-vm (GitHub)](https://github.com/laverdet/isolated-vm)
- [justjake/quickjs-emscripten (GitHub)](https://github.com/justjake/quickjs-emscripten)
- [quickjs-emscripten — npm](https://www.npmjs.com/package/quickjs-emscripten)
- [Simon Willison — JavaScript Sandboxing Research (2026)](https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/)

### Exposing web API testing to an LLM agent over MCP with safety (Sackville Pillar 2)
**Confidence:** high

**Recommendation:** Ship a deliberately small MCP tool surface, workflow-shaped: (1) list_requests (collection-scoped, paginated, concise) — readOnlyHint; (2) get_request (resolved request incl. which {{secret:NAME}} it needs, never values) — readOnlyHint; (3) run_request {requestId|inline, dryRun?, confirm?, idempotent?, responseFormat?} — the workhorse; (4) run_collection {collectionId, stopOnFailure?, dryRun?} — readOnlyHint only if every member is safe, else destructive; (5) validate_response / assert (response handle + spec ref -> structured drift report) — readOnlyHint. run_request returns structuredContent {status, latencyMs, assertions[], bodyHandle} and emits the body as a resource_link sackville://run/<id>/body; only inline bodies under a small threshold (~2k tokens) and always offer the handle. Tag tools with accurate annotations but treat them as UI hints only.

DEFAULT SAFETY POSTURE = deny-by-default for mutation. Concretely: safe methods (GET/HEAD/OPTIONS) execute normally; any unsafe method (POST/PUT/PATCH/DELETE) is, by default, (a) dry-run only — Sackville resolves the request, applies secrets, and returns exactly what WOULD be sent (method, URL, redacted headers, body shape) without firing; and (b) requires the run to be in an unlocked state to actually send. Unlock via an explicit, auditable gate: a session/run-scoped --unsafe (or allowUnsafe:true) flag PLUS a host+method allowlist (e.g. only POST to api.staging.example.com), and optionally a per-call confirm token echoing a server-issued challenge so confirmation can't be blind. Mark requests idempotent:true to permit auto-retry/backoff; non-idempotent unsafe calls never auto-retry and inject/require an Idempotency-Key. Rate-limit and exponential-backoff all sends. Enforce ALL of this in the server, independent of client annotations.

SECRETS: agent only ever emits {{secret:NAME}} tokens. The server resolves them against a secret provider (env/keychain/secret-manager) immediately before transport, after the value has left the LLM-visible argument path. Maintain a secret-value set and redact it from every result, header echo, error message, log line, and resource body (replace with {{secret:NAME}} or [REDACTED]). Log argument shapes, not values. get_request must report required secret names without resolving them.

CONTRACT VALIDATION: use openapi-backend (framework-agnostic, Ajv-2020-12) for OpenAPI 3.1 response validation — point it at the spec, match the live response to an operation, validate status/headers/body, and return a structured drift report (missingRequired[], typeMismatch[], unexpectedField[], statusMismatch, contentTypeMismatch) rather than prose so the agent can act on it. Prefer it over express-openapi-validator because Sackville is not an Express app, though express-openapi-validator >=5.4.0 confirms 3.1 is mainstream. For GraphQL, validate operations and responses against the introspected schema with graphql-js and use graphql-inspector for schema-diff/coverage. Wire spec validation as an opt-in assertion on run_request (specRef param) and as the dedicated validate_response tool operating on a stored response handle. Pure-TS, no Python/SQLite, Linux-dev-clean.

**Versions:**
- Node.js 22 LTS (Sackville baseline; libs below need >=20)
- MCP TypeScript SDK 1.29 (Sackville baseline); MCP spec revision 2025-06-18 for tools/resources/annotations
- openapi-backend (framework-agnostic OAS 3.0/3.1 request+response validation via Ajv) — current 5.x line
- express-openapi-validator >=5.4.0 (first version with OAS 3.1 support; response validation JSON-only)
- Ajv with JSON Schema 2020-12 dialect (ajv/dist/2020), required for OpenAPI 3.1
- openapi-typescript 7.x (type generation from 3.0/3.1 specs; runtime-free types)
- graphql-js 16.x (validate, buildClientSchema, introspection utilities)
- graphql-inspector (graphql-hive) — schema diff / breaking-change / coverage
- Zod 3.x + zod-to-openapi as an alternative single-source-of-truth schema path for assertions

**Gotchas:**
- MCP tool annotations (readOnlyHint/destructiveHint/idempotentHint) are NOT a security boundary — the spec says clients must treat them as untrusted. If Sackville relies on them for safety instead of server-side enforcement, a misconfigured or malicious client can bypass mutation gating.
- OpenAPI 3.1 uses JSON Schema 2020-12; using a draft-07-default Ajv (the common mistake) silently mis-validates 3.1 specs. Must import the Ajv 2020 build and register format/dialect support.
- express-openapi-validator's response validation is JSON-only and its public API is Express middleware — extracting standalone response validation means reaching into internals; openapi-backend is the cleaner non-Express path, so don't pick the validator off search-result popularity alone.
- Inlining a response body 'just this once' defeats the resource-handle design and can blow the ~25k-token Claude Code cap on a single large API response; always default to the handle and gate inlining on a small token/byte threshold.
- Redaction must cover MORE than the body: secret values commonly leak via echoed request headers (Authorization), error/exception messages, redirect URLs with query-string tokens, and verbose logs. A body-only redactor is insufficient.
- DELETE is idempotent but still destructive — idempotentHint:true must not be conflated with 'safe to auto-fire'. Keep destructive and idempotent as independent axes in the gating logic.
- Allowlists keyed only on host are bypassable via redirects (an allowed host 302s to a disallowed one) and SSRF to internal/metadata endpoints; validate the final post-redirect host+method and block private/link-local ranges.
- GraphQL returns HTTP 200 with an `errors` array on failure, so status-code-based assertions are misleading; contract checks must inspect the GraphQL errors/data shape, and disabled introspection means you cannot fetch the schema at runtime for spec-to-reality validation.
- graphql-inspector / the-guild tooling is oriented at schema-vs-schema diffing (breaking changes), not response-vs-schema validation — don't assume it validates a runtime response payload; that path is graphql-js validate against a buildClientSchema'd introspection result.

**Citations:**
- [MCP spec — Tools (annotations, resource_link, structuredContent, outputSchema, security)](https://modelcontextprotocol.io/docs/concepts/tools)
- [Anthropic — Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic — Code execution with MCP: building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [MCP Server Patterns for Enterprise AI Agents (2026)](https://www.digitalapplied.com/blog/mcp-server-patterns-enterprise-ai-agents)
- [MCP Server Anti-Patterns: Design Mistakes 2026 Guide](https://www.digitalapplied.com/blog/mcp-server-anti-patterns-design-mistakes-2026-developer-guide)
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [Idempotent AI Agents: Retry-Safe Patterns for Production](https://www.buildmvpfast.com/blog/idempotent-ai-agent-retry-safe-patterns-production-workflow-2026)
- [HTTP methods: Idempotency and Safety](https://www.mscharhag.com/api-design/http-idempotent-safe)
- [MDN — Idempotent](https://developer.mozilla.org/en-US/docs/Glossary/Idempotent)
- [MCP Server Security Best Practices: 2026 Engineering Guide](https://www.digitalapplied.com/blog/mcp-server-security-best-practices-2026-engineering-guide)
- [PII Redaction for MCP Servers](https://mcpmanager.ai/blog/pii-redaction-for-mcp-servers/)
- [express-openapi-validator (OAS 3.1 in >=5.4.0)](https://github.com/cdimascio/express-openapi-validator)
- [openapi-backend reference (framework-agnostic validation)](https://openapistack.co/docs/openapi-backend/api/)
- [openapi-typescript (npm)](https://www.npmjs.com/package/openapi-typescript)
- [GraphQL Inspector — validate schema / breaking changes / coverage](https://github.com/graphql-hive/graphql-inspector)
- [API Schema Drift Detection Tools Compared (2026)](https://dev.to/flarecanary/api-schema-drift-detection-tools-compared-2026-1ib4)
- [GraphQL — Introspection](https://graphql.org/learn/introspection/)
