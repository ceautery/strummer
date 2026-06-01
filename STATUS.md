# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**Phase 3 — Browser/UI testing pillar: ENGINE + SAFETY + ARTIFACT PIPELINE + MCP
SURFACE COMPLETE; CLI deferred.** Design locked by a 5-stream
research workflow w/ adversarial verification (`docs/research/2026-05-31-pillar3-
browser-testing.md`); captured in **ADR 0006 (+ dated updates) + ARCHITECTURE §10
+ ROADMAP Phase 3**. A new pure-TS **`@strummer/browser`** built **thin on stable
`playwright-core` 1.60.0** (NOT a wrap of `@playwright/mcp`, which pins an alpha
core + inlines artifacts); ARIA-snapshot-first driving; artifacts by handle;
deny-by-default operator-set safety. Shipped slices (all TDD, real-chromium tested
against in-process fixtures):

1. a11y-audit summarizer + on-disk `ArtifactStore`.
2. `BrowserManager` (shared browser, ephemeral context/session, idle reaper, caps).
3. ARIA-snapshot capture + serializer — Strummer mints its own ref-ids over the
   public `ariaSnapshot()` YAML (1.60.0 lacks `_snapshotForAI`/snapshot-refs; ADR
   update 2026-06-01); token-capped diff + full-snapshot handle.
4. `PageDriver` step tools (navigate/click/fill/select/press/waitFor/snapshot +
   free reads) over generation-tagged refs.
5. `BrowserGate` deny-by-default action gate — navigation allowlist + mutation
   dry-run (one-shot route capture+abort) vs execute; operator-set.
6. Shared **`@strummer/safety`** (SSRF range classifier + `Redactor` moved from
   `api`) + Tier-1 `installSafetyRoutes` allowlist (allowlist-authoritative).
7. Tier-2 `createSsrfProxy` — loopback DNS-pinning forward proxy; `allowPrivate`
   opt-in for local-app testing (never link-local/metadata).
8. Dry-run preview redaction completeness (`url` + `postData`, slice 8a) + the
   **artifact-capture pipeline** `RunRecorder` (slice 8b): trace.zip / console /
   network by `strummer://browser/run/<id>/<kind>` handle with compact summaries;
   text channels redacted before write; per-channel enable flags.
9. **Engine hardening for the MCP surface (Milestone A, slices A1–A6)** — surfaced
   by a fan-out design+adversarial-review workflow (`browser-mcp-design`): snapshot
   redaction seam (secrets reflected in the DOM no longer leak into the snapshot/
   artifact), per-generation immutable artifact handles (no overwrite), bounded
   diff output, dry-run popup-block + `crossOriginEgress` flag, no-snapshot vs
   stale-ref error, `BrowserManager.onReap` flush hook.
10. **Browser MCP surface (Milestone B)** — `registerBrowserTools`/
   `createBrowserServer` (`packages/mcp/src/browser.ts`): 15 session-oriented tools
   over a surface session registry + per-session async mutex; server-minted UUID
   sessionId+runId (never agent input); reads redacted at the surface; reaper
   reconciliation via `manager.onReap` + `hasSession` eviction; the two-variable
   `strummer://browser/run/{runId}/{kind}` resource. No tool input can flip a
   safety flag.
11. **`strummer-browser-mcp` server bin (Milestone C)** — `bin-browser.ts`
   (`buildBrowserServerFromEnv`, exported + unit-tested): namespaced
   `STRUMMER_BROWSER_*` operator env with no api-var fallback; **mandatory**
   DNS-pinning SSRF proxy (no disable env) + Chromium `--proxy-bypass-list=
   <-loopback>` (loopback also traverses the proxy); trace-off-by-default; sandbox
   on by default (`--no-sandbox` opt-in); SIGINT/SIGTERM shutdown.

12. **Browser secret boundary — `{{secret:NAME}}` fill resolution** (`bffdf07`):
   `browser_fill`/`browser_fill_form` resolve `{{secret:NAME}}` to the operator
   secret server-side at the fill boundary (cleartext typed into the input, never
   in a tool arg or agent-visible result; redactor scrubs it everywhere); fails
   closed on an unknown name; the bin wires `resolveSecret` from the same
   `STRUMMER_BROWSER_SECRET_*` map as the redactor.
13. **Browser secret boundary — origin-scoped `httpCredentials`** (`4841fb2`):
   `BrowserManager` applies operator HTTP Basic creds (optionally origin-scoped) to
   every session context; bin parses `STRUMMER_BROWSER_HTTP_USERNAME/PASSWORD/
   ORIGIN`, registers the password with the redactor, and keeps it out of the
   config (config exposes `{username, origin}` only).
14. **Browser secret boundary — `storageState` by handle** (`24e47ff`):
   operator-gated `browser_save_storage_state` captures the context storageState to
   an operator-path artifact, returns a handle + cookie/origin counts (never
   inlined); the resource refuses the password-equivalent `storage-state` kind.
   Bin gates it behind `STRUMMER_BROWSER_ALLOW_STORAGE_STATE` (default off).
15. **Browser secret boundary — trace-internal redaction** (`acc6536`):
   `RunRecorder.stop` unzips the trace.zip (fflate), scrubs its text entries (JSONL
   metadata + DOM/sources snapshots), and re-zips before write; binary resources
   pass through. **ADR 0006 §6 secret boundary is now COMPLETE.**
16. **Browser hardening — `serviceWorkers:'block'` + WebRTC** (`9207224`):
   `BrowserManager` blocks service workers on every context (no SW cache/intercept
   bypassing the Tier-1 SSRF layer); the bin adds
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (WebRTC limited to
   proxied UDP — no P2P egress bypassing the SSRF proxy, no local-IP leak).
17. **Browser caps — session wall-clock + max-pages** (`f0fc419`):
   `BrowserManager` reaps a session past `maxSessionMs` (wall-clock, even when
   active) and closes pages opened beyond `maxPages` per context; bin-set via
   `STRUMMER_BROWSER_SESSION_MS`/`STRUMMER_BROWSER_MAX_PAGES`, default no cap.
18. **On-demand screenshot step tool — operator-gated:** `PageDriver.screenshot()`
   captures a PNG to the `ArtifactStore` under an immutable indexed handle
   (`screenshot-s<n>`), returns a summary (handle/byteSize/contentType/fullPage),
   never inlines the image, and does NOT re-snapshot (refs preserved). MCP
   `browser_screenshot` is **off by default** (`allowScreenshots`) — a screenshot
   is unredactable pixels, so it is gated like the trace.zip; the run-artifact
   resource serves PNGs as a base64 blob (`image/png` → binary). Bin-wired via
   `STRUMMER_BROWSER_ALLOW_SCREENSHOTS` (default off).
19. **Dialog gating — deny-by-default:** `PageDriver` installs a `page.on('dialog')`
   handler that **dismisses** alert/confirm/prompt/beforeunload by default (a
   `confirm` returns false, so a destructive flow gated behind it cannot proceed)
   and records each as a `DialogEvent {type, message(redacted), accepted}` drained
   onto the triggering step's `StepResult.dialogs`. Operator opt-in
   `BrowserGate.allowDialogs` flips to **accept**; bin-wired via
   `STRUMMER_BROWSER_ALLOW_DIALOGS` (default off). Registering the handler overrides
   Playwright's auto-dismiss, so the page never hangs.
20. **Download gating — deny + opt-in quarantine:** `BrowserManager` creates contexts
   with `acceptDownloads:false` by default (Playwright **cancels** every download —
   race-free deny). An operator quarantine dir (`STRUMMER_BROWSER_DOWNLOAD_DIR`)
   flips `acceptDownloads:true` and sets `PageDriver.downloadDir`; a started download
   is saved there under a **sanitized, indexed** name (`<n>-<basename>`, no traversal)
   and recorded as a `DownloadEvent {suggestedFilename(redacted), savedAs, byteSize,
   accepted}`. Surfaced by the race-free **`browser_downloads`** read tool
   (`collectDownloads(waitMs?)` awaits in-flight saves; optional bounded wait) —
   **metadata only, bytes never served** to the agent.
21. **Upload gating — confined to an operator allowlist dir:** `PageDriver.uploadFiles`
   (MCP `browser_upload`) sets files on a file-input ref but is **deny-by-default** —
   it requires an operator `uploadDir` and every requested path must resolve to
   within it (no `..` traversal, no absolute escape), throwing `GateError` otherwise.
   This is the exfiltration control: an agent cannot upload arbitrary local files
   (`~/.ssh/id_rsa`, `/etc/passwd`). Selecting a file makes no network request; the
   later submit is gated separately by the mutation gate. Bin-wired via
   `STRUMMER_BROWSER_UPLOAD_DIR` (unset ⇒ uploads denied). **The downloads/uploads/
   dialog/auth gating bundle is now COMPLETE** (auth = origin-scoped `httpCredentials`).

**245 TS + 45 Py tests green; committed to `main`.** **Next action:** the only
remaining Phase 3 item is the deferred human **`strummer browser` CLI**. See the
detailed "Next action" section below + ROADMAP Phase 3.

**Phase 2 — Web API testing pillar: core deliverables COMPLETE** (engine +
contract validation + MCP tools + CLI all shipped & CI-gated; only optional tail
items remain). **Pillar 1 (docs/idioms) is functionally complete _and all its
deferred polish is done_** (non-Node version detection, TOC-bleed/symbol
ingestion refinements, Dash docset adapter). Pillar 2 design is locked (ADR 0004
+ 0005 + ARCHITECTURE §9, grounded by a 4-stream research workflow archived in
`docs/research/2026-05-31-pillar2-api-testing.md`).

**`@strummer/api` so far (TDD, offline tests):**
- Loads Bruno `.bru` + `*.strummer.yml` sidecar; var interpolation; **undici**
  runner; declarative assertions (status/jsonpath/header); body by
  `strummer://run/<id>/body` handle.
- **Secrets:** `{{secret:NAME}}` resolved at the transport boundary from a
  `SecretStore` (`StaticSecretStore`/`EnvSecretStore`/`KeyringSecretStore`-lazy/
  `ChainedSecretStore`); **fails closed** on a missing secret; a `Redactor`
  scrubs values + base64/url encodings from request/headers/body before anything
  reaches the agent.
- **Mutation safety:** GET/HEAD/OPTIONS run; POST/PUT/PATCH/DELETE **dry-run** by
  default and only send with `allowUnsafe` + a host allowlist (`checkGate`).
- **Captures + chaining:** sidecar `captures` extract values from a response
  (`extractCaptures`); `runSequence` threads them into later requests' scope.
- **Request bodies:** `.bru` `body:json/text/xml/sparql` (raw) + `form-urlencoded`
  sent via undici with a default `Content-Type`; vars/secrets interpolated in the
  body; redacted body shown in the result. (multipart/file/graphql still TODO.)
- **Environments:** `environments/<Env>.bru` loaded into `collection.environments`;
  `runRequest`/`runSequence` take `env` (lowest precedence; runtime vars win).
- **Scripts (QuickJS sandbox):** sidecar `preScript`/`postScript` run in a WASM
  isolate (`quickjs-emscripten`, 1s interrupt) with a curated `bru`/`expect`/
  `test`/`console` API — data crosses the boundary only as JSON (no host
  bindings). Pre-script sets vars used in interpolation; post-script sees `res`,
  records `scriptTests` (redacted), and `bru.setVar` feeds captures/chaining.
- **Contract validation (ADR 0005, ajv-direct not openapi-backend):** the
  `schema` assertion source validates a body (or jsonpath subtree) against an
  inline JSON Schema via **ajv 2020-12** (`schema.ts`/`validateSchema`).
  `validateOpenApiResponse` matches path-template + status (incl. `2XX`/`2xx`
  ranges + `default`) and validates the body against the **OpenAPI 3.1** response
  schema (local `#/components/schemas` `$ref`s rewritten into `$defs`); surfaces
  drift as `missing-operation`/`undocumented-status`/`response-schema` findings.
  `validateGraphqlOperation` (graphql-js) catches query-vs-schema drift incl.
  missing root types, plus response `errors`. Shared `ContractResult`/
  `ContractFinding`. Adversarially verified (3 bugs found + fixed: lowercase
  `2xx`, `$defs` clobber, mutation/subscription drift miss).
- **MCP tools + CLI commands (fan-out, two independent surfaces over the
  engine):**
  - **MCP** (`@strummer/mcp` `registerApiTools`/`createApiServer`, new
    `strummer-api-mcp` bin): tools `list_requests`, `get_request` (reports
    required secret **names** only, never values), `run_request`, `run_collection`,
    `validate_response` (OpenAPI or GraphQL), + `strummer://run/{runId}/body`
    resource over a shared `ArtifactStore`. **`allowUnsafe`/`allowedHosts` are
    operator-set via `ApiToolsOptions` (env on the bin), never agent inputs** —
    the safety gate can't be self-authorized.
  - **CLI** (`strummer api …`): `list`, `get`, `run` (`--var k=v`, `--env`,
    `--unsafe`, `--allow-host`, `--openapi <spec>` for live response validation,
    `--json`), `run-collection` (`--stop-on-failure`), `validate --graphql
    <schema> --query <q>` (offline drift). Exit 0 only when sent + assertions
    pass (+ contract valid when checked).
- A runnable sample collection (`examples/api/jsonplaceholder`) + an API-testing
  quickstart in `packages/cli/README.md`; an offline guard test keeps the sample
  in sync with the `.bru` format.
- **127 TS + 45 Py tests** (1 skipped real-embed), all green. Contract validators
  adversarially verified; both API bins smoke-tested end-to-end.

**Next (Pillar 2 tail):** keyring secret-store wiring into CLI/MCP (opt-in),
SSRF/redirect re-checks, remaining body types (multipart/file/graphql),
Postman/Insomnia/OpenAPI/HAR import. Contract-validation scope notes (local
`$ref`s only, 3.1-only, ajv `strict:false`) are in ADR 0005.

Decided (ADR 0004): new pure-TS **`@strummer/api`** package; **Bruno `.bru`** +
thin model (via `@usebruno/lang`); Strummer assertions/captures in a **sidecar
`*.strummer.yml`**; **deny-by-default** mutation safety (dry-run + allowlist +
`--unsafe`); secrets via `@napi-rs/keyring` + env fallback, value-redacted;
**QuickJS-sandboxed** JS scripts in v1. Engine: **undici 8**.

## Milestone log (historical)

> Pillar-by-pillar history. The **authoritative current state + test counts** are
> in the top block above; test counts in these bullets are point-in-time.

- Decisions locked (see ADR 0001 + ARCHITECTURE.md §7): **Strummer**, polyglot
  core, headless MCP+CLI, docs pillar first, **bge-small-en-v1.5 / 384-dim**
  embeddings, **React 19** first corpus, license posture local-index-only.
- Design grounded by a 6-stream research workflow → `ARCHITECTURE.md` (exact
  stack/versions, the SQLite contract, MCP tool shapes). Raw research archived in
  `docs/research/2026-05-31-design-research.md`.
- **Monorepo scaffolded and 100% green:** pnpm workspace + `@strummer/core` (TS;
  better-sqlite3 + sqlite-vec, Biome, Vitest, tsdown) and `py/strummer_ingest`
  (uv; Ruff, pytest). `pnpm gate` runs both toolchains.
- **Polyglot boundary proven (red→green):** Python builds `fixtures/golden.sqlite`
  (schema + FTS5 + vec0 float[384]); TS `openDb`/`searchDocs`/`getDoc` reads it,
  asserts the schema contract, finds `react/useState` via FTS with no
  cross-library leakage. sqlite-vec verified on **both** runtimes.
- **`@strummer/mcp` shipped:** MCP server (SDK 1.29) over `core` exposing
  `search_docs` (compact + `resourceUri`), `get_doc` (full body), and the
  `strummer://doc/{id}` resource. License: **Apache-2.0** (ADR 0002).
- **Real React 19.2 ingestion working end to end:** DevDocs adapter (`react`
  slug = 19.2, CC-BY-4.0) → section chunking (`extract`) → type normalization
  (`types_map`) → bge-small embeddings (`embed`) → SQLite (`build`), driven by
  `strummer-ingest build --slug react`. Produced a **1,279-fragment** index
  (`data/react.sqlite`, gitignored/reproducible) and queried it through the MCP
  server. The three leaf modules were built by a **parallel fan-out workflow**.
- **Hybrid search shipped:** `core.searchDocs` fuses FTS5/bm25 with `sqlite-vec`
  KNN via reciprocal rank fusion (optional `queryVector`). The MCP server embeds
  queries in-process with transformers.js (`Xenova/bge-small-en-v1.5`), which
  reproduces the Python-`fastembed` vectors exactly (cosine 1.0, ADR 0003) — so
  the server stays a self-contained Node process, no Python at serve time.
  Verified on the real index: `useState` now ranks the useState hook #1; pure
  semantic queries ("share state between components") hit the right guide.
- **Version-pinning shipped:** `core.resolveVersion` (semver; exact →
  nearest-same-major → refuse, never silently wrong) + `listVersions`. The
  ingester `build --append` puts multiple versions in one index; the real
  `data/react.sqlite` now holds **19.2 + 18.3.1 + 17.0.2** (2,905 fragments).
  `search_docs` takes `installed` (version/range) → resolves → filters and
  reports `resolvedVersion`/`versionNote`; new `list_versions` tool. Verified:
  installed `^18.2.0` → React 18.3.1 docs; `16.8.0` → flagged, not silently 19.x.
- **Auto-detect installed version shipped:** `core.detectInstalledVersion`
  (node_modules → package-lock.json → package.json range; works for npm/pnpm/
  yarn). New `detect_version` MCP tool; `search_docs` gains a `project` input
  (precedence version > installed > project). Verified end to end: pointing at a
  project with React 18 installed, with no version supplied, returns React
  18.3.1 docs.
- **`@strummer/cli` shipped:** `strummer search|get|versions|detect` over `core`
  (hybrid via `@strummer/embed`, `--json`, version flags). The query embedder was
  extracted into **`@strummer/embed`** (transformers.js, dynamic import) shared
  by cli + mcp.
- **CI gate:** `.github/workflows/ci.yml` mirrors `pnpm gate` (both toolchains)
  on push/PR.
- Dev container provisions pnpm + uv. **39 TS + 36 Py tests** (1 skipped real
  embed), all green. **Pillar 1 (docs/idioms) is functionally complete.**

## Next action

**Phase 3, Slice 1 (a11y-audit summarizer): DONE & committed** (`@strummer/browser`
scaffolded; `ArtifactStore`/`summarizeA11y`/`auditA11y`, TDD against an offline
fixture + real headless Chromium; CI + docker harness provision Chromium). The
slice deliberately deferred visual baselines + Lighthouse scores (the flaky parts).

**Slice 2 (browser lifecycle manager): DONE.** `BrowserManager` — lazy single
shared browser, ephemeral isolated context per session, `maxContexts` cap,
idle-TTL `sweepIdle` + `startReaper`, per-context default timeouts,
`closeSession`/`shutdown`. (Fake browser + deterministic clock + real-chromium
integration.)

**Slice 3 (ARIA-snapshot capture + serializer): DONE.** `snapshot.ts` —
`buildSnapshot`/`captureSnapshot`/`diffSnapshots`. NOTE the empirical revision of
the ADR open fork: `playwright-core` 1.60.0 has **no** `_snapshotForAI` and **no**
ref-ids in `ariaSnapshot()`, so Strummer parses the public `ariaSnapshot()` YAML
and **mints its own ref-ids** → semantic-locator descriptors `{role,name,nth}`
(per-snapshot, non-persisted), token-capped serialize + full-snapshot handle +
ref-independent diff. (See ADR 0006 update 2026-06-01.)

**Slice 4 (imperative step tools): DONE.** `PageDriver` (`driver.ts`) — navigate,
click, fill, fillForm, selectOption, press, waitFor, snapshot, and free reads
(getText/getValue/getAttribute). Refs resolve via the snapshot descriptors to
`getByRole(role,{name}).nth(n)` with auto-waiting; each navigating/mutating step
re-captures under a new snapshot **generation** (refs like `s2e3`) and returns a
scoped diff + capped snapshot + handle, so a stale ref from an earlier snapshot
**fails loudly** instead of matching a different element. Real-chromium tested
against an in-process fixture (fill/click/select/press/wait_for/stale-ref).
**155 TS + 45 Py green.**

This completes a usable interaction unit (lifecycle + snapshot + step tools) —
slices 2–4 pushed to `main`.

**Slice 5 (deny-by-default action gate): DONE.** `BrowserGate` (`gate.ts`,
operator-set `{allowUnsafe, allowedHosts}`) + `PageDriver` wiring: reads free;
`navigate` gated by host allowlist (`checkNavigation` → `GateError`); mutating
interactions (click/fill/fillForm/selectOption/press) **dry-run by default** — a
one-shot `page.route` captures + aborts the first would-be request and returns a
`{dryRun, wouldRequest}` preview — and **execute** only with `allowUnsafe` + an
allowlisted current host (hard-deny otherwise). Gate omitted ⇒ raw ungated layer
(the MCP surface always supplies one). Pure policy tests + chromium integration
(navigate allow/deny, dry-run captures+blocks a POST, execute sends it). **161 TS
+ 45 Py green.** Committed to `main`; **not yet pushed** — push after the SSRF
slice rounds out the safety story.

**Slice 6 (`@strummer/safety` + Tier-1 SSRF): DONE.** New shared **`@strummer/safety`**
package (factored per ADR 0006): SSRF range classifier (`isBlockedIp`/
`isBlockedHost`/`isBlockedHostLiteral` via `ipaddr.js`, fail-closed) +
`resolveAndPin` (DNS resolve → refuse blocked range → pinned IP, the Tier-2
decision core) + the `Redactor` (moved from `@strummer/api`, re-exported there —
behavior-preserving). **Tier-1** `installSafetyRoutes` (deny-by-default
`browserContext.route`, wired into `BrowserManager` when a gate is set) governs
every request and is **allowlist-authoritative** (ADR 0006 update 2026-06-01:
literals blocked by deny-by-default rather than unconditionally, so localhost
apps stay testable). **174 TS + 45 Py green.** Committed to `main`; the
`@strummer/safety` extraction (77c7ff7) + Tier-1 are being pushed together as the
milestone.

**Slice 7 (Tier-2 DNS-pinning SSRF proxy): DONE.** `createSsrfProxy`
(`proxy.ts`) — a loopback forward proxy (HTTP absolute-form + HTTPS `CONNECT`)
passed as Chromium's `proxy.server`; calls `@strummer/safety` `resolveAndPin` per
request/CONNECT (resolve once → refuse blocked range → connect to the **pinned**
IP), closing allowlisted-hostname DNS-rebinding (the gap Tier-1 can't see). HTTP
rebind → 502; redirects re-checked (each hop is a fresh proxy request). The
safety classifier gained `classifyAddress` (`global`/`private`/`blocked`) + an
operator **`allowPrivate`** opt-in (permits loopback/RFC1918 for local-app
testing, **never** link-local/metadata). Direct HTTP-client-through-proxy tests +
a real Chromium-through-proxy test (hostnames, so no loopback-bypass). **181 TS +
45 Py green.** The **two-tier SSRF defense is now complete.** Committed to `main`;
pushing as the milestone.

**Slice 8a (dry-run redaction completeness): DONE.** `PageDriver`'s dry-run
preview now applies the `redact` hook to the would-be request **`url`** as well as
its `postData` (a secret in a GET query string previously leaked into the preview);
the option doc records that the server bin wires the real `@strummer/safety`
`Redactor` there. Test wires a real `Redactor` through the hook → both body and
`?token=` query scrubbed. (ef5cd81)

**Slice 8b (artifact-capture pipeline): DONE.** `RunRecorder` (`recorder.ts`) —
attaches to a page + its context tracer for a run's lifetime and captures three
channels, each returned **by handle** (`strummer://browser/run/<id>/<kind>`) with
a compact summary (never inlined): a Playwright **trace.zip**
(screenshots+snapshots+sources), the **console** stream (incl. uncaught
`pageerror`s, tallied `byType`), and the **network** log (method/url/status/
failure, tallied `byStatus` + `failed`). Text channels pass through the operator's
`redact` hook **before** write (so a registered secret never lands in an artifact
via a logged value or query string); trace is binary (deep trace-internal
redaction is the secret-boundary slice). Per-channel enable flags. Real-chromium
tested against a fixture that logs a secret, fetches a secret-bearing URL, and
throws. **184 TS + 45 Py green.** (9a0a810)

**Browser MCP surface — design locked by the `browser-mcp-design` fan-out**
(3 design proposals → 2 adversarial critics → synthesis; ~407k tokens). Decisions:
**MCP surface only this pass (no CLI)**; safety/operator-config-first spine (one
operator `BrowserGate` threaded into the manager AND every driver; namespaced
`STRUMMER_BROWSER_*` env, no fallback to the api bin's vars); handle-resource
egress (one `strummer://browser/run/{runId}/{kind}` ResourceTemplate); explicit
session-lifecycle tools with distinct mutating verbs. Plan staged into 3
milestones:

**Milestone A — engine hardening: DONE (slices A1–A6, pushed).** A1 snapshot
redaction seam, A2 per-generation immutable handles, A3 bounded diff, A4 dry-run
popup-block + `crossOriginEgress`, A5 no-snapshot vs stale-ref error, A6
`BrowserManager.onReap` flush hook. (The critic's "dry-run aborts only the first
request" was a verified misread — the route aborts every request; only the capture
is first-only.)

**Milestone B — MCP surface: DONE (pushed).** `registerBrowserTools`/
`createBrowserServer` (`packages/mcp/src/browser.ts`): process-lifetime singletons
(one BrowserManager, one operator gate, one ArtifactStore, one Redactor) + a
`Map<sessionId, BrowserSession>` with a per-session async mutex; 15 tools
(`browser_open_session`/`list_sessions`/`navigate`/`snapshot`/`click`/`fill`/
`fill_form`/`select`/`press`/`wait_for`/`get_text`/`get_value`/`get_attribute`/
`audit_a11y`/`close_session`); server-minted UUID sessionId+runId (1:1, never agent
input); reads redacted at the surface; reaper reconciliation via `manager.onReap`
(flush recorder) + `hasSession` eviction; the two-variable resource template over
the shared store. **Tested with real headless chromium + `InMemoryTransport`** (the
repo's established offline/deterministic browser-test posture — chosen over the
fake-launch suggestion as far more faithful + already CI-provisioned). Engine fix
this milestone demanded: `PageDriver` resolves a ref's locator **eagerly** so a
no-snapshot/stale-ref error propagates instead of being swallowed by the dry-run
try/catch.

**Milestone C — server bin: DONE (pushed).** `bin-browser.ts`
(`buildBrowserServerFromEnv`, exported + unit-tested; executable tail guarded by an
`import.meta` main-module check): sole reader of `STRUMMER_BROWSER_*` env + sole
constructor of the egress boundary; **mandatory** `createSsrfProxy` (no disable
env) + Chromium launch with `--proxy-bypass-list=<-loopback>` (loopback also
traverses the pinning proxy — closes the documented bypass); trace-off-by-default;
sandbox on by default (`--no-sandbox` opt-in); `startReaper`; SIGINT/SIGTERM
shutdown → `manager.shutdown()` then `proxy.close()`; `strummer-browser-mcp` bin +
package.json deps/build inputs. Built bin smoke-starts clean.

**Secret boundary (ADR 0006 §6): COMPLETE.** `{{secret:NAME}}` fill resolution
(`bffdf07`, fail-closed, bin-wired) + origin-scoped `httpCredentials` (`4841fb2`,
per-context via `BrowserManager`, password redacted/out-of-config) + `storageState`
by handle (`24e47ff`, operator-gated, counts+handle only, resource-refused) +
trace-internal redaction (`acc6536`, fflate unzip→scrub text entries→rezip) — on
top of console/network (8b), dry-run preview (8a), snapshot (A1), and surface-read
(Milestone B) redaction. Scheduled refinements (not blocking): HAR bodies;
`storageState`/userDataDir **import** for operator login-reuse.

**Hardening — `serviceWorkers:'block'` + WebRTC: DONE (`9207224`).** SWs blocked on
every context; WebRTC limited to proxied UDP via a launch arg. **Caps — session
wall-clock + max-pages: DONE (`f0fc419`).** `maxSessionMs` reaps active-but-old
sessions; `maxPages` closes excess pages per context; both operator-set, default
no cap.

**On-demand screenshot step tool: DONE.** `PageDriver.screenshot()` → PNG to the
`ArtifactStore` under an immutable `screenshot-s<n>` handle (summary only, never
inlined; does NOT re-snapshot so refs survive); MCP `browser_screenshot` gated
**off by default** (`allowScreenshots`) because a screenshot is unredactable pixels
(same posture as the trace.zip); the resource serves PNGs as a base64 blob;
bin-wired via `STRUMMER_BROWSER_ALLOW_SCREENSHOTS` (default off).

**Dialog gating: DONE.** `PageDriver` installs `page.on('dialog')` →
dismiss-by-default (override of Playwright's auto-dismiss, so the page never hangs)
+ record `DialogEvent {type, message(redacted), accepted}` onto
`StepResult.dialogs`; `BrowserGate.allowDialogs` flips to accept; bin-wired via
`STRUMMER_BROWSER_ALLOW_DIALOGS` (default off).

**Download gating: DONE.** `BrowserManager` contexts are `acceptDownloads:false` by
default (Playwright cancels — race-free deny); an operator quarantine dir
(`STRUMMER_BROWSER_DOWNLOAD_DIR`) flips it on + sets `PageDriver.downloadDir`, where
a download is saved under a sanitized indexed name and recorded as a `DownloadEvent`.
Surfaced by the race-free `browser_downloads` read tool (metadata only — bytes never
served).

**Upload gating: DONE.** `PageDriver.uploadFiles` / MCP `browser_upload` —
deny-by-default (requires operator `STRUMMER_BROWSER_UPLOAD_DIR`); every path must
resolve within that dir (no traversal/absolute escape) so an agent can't exfiltrate
arbitrary local files. **The downloads/uploads/dialog/auth gating bundle is COMPLETE.**

**Next (later Phase 3):** only the deferred human **`strummer browser` CLI** remains.
TDD red→green; `pnpm gate` 100% green before each commit.

---

Pillar 2 (`@strummer/api`) **engine + agent/human surfaces are complete**: the
MCP tools (`strummer-api-mcp`) and CLI (`strummer api …`) both ship over the
engine, fan-out built and integrated, all green. Remaining Pillar-2 tail (pick
any; none blocking):
1. Wire the **keyring** secret store into CLI/MCP (opt-in `--keyring` / env);
   today both default to `EnvSecretStore` (`STRUMMER_SECRET_<NAME>`).
2. **SSRF range-block + post-redirect re-check** in the safety gate (currently
   method + host-allowlist only).
3. Remaining request **body types**: multipart-form, file, graphql.
4. **Import**: Postman/Insomnia/OpenAPI (`@usebruno/converters`); HAR→`.bru`.
5. Contract-validation reach (ADR 0005): external/remote `$ref` deref; OpenAPI
   3.0 `nullable` shim; `operationName`-scoped GraphQL.

Or start **Phase 3 (browser/UI testing, Playwright over MCP)** — see ROADMAP.

Deferred Pillar-1 polish — **all DONE**: non-Node version detection (Python/Ruby
in `detectInstalledVersion`, wired into MCP/CLI); ingestion TOC-bleed + richer
`symbol` (`split_sections` strips on-page TOC lists; `symbol_from_heading`);
**Dash docset adapter** (`dash.iter_fragments` + `build --docset`, searchIndex
schema). Remaining Pillar-1 nice-to-haves: Homebrew tap; Dash Core Data docsets.

## How to build an index / register the server today

```bash
cd py/strummer_ingest && uv run strummer-ingest build --slug react --library react \
  --out ../../data/react.sqlite        # ~1,279 fragments, bge-small embeddings
claude mcp add strummer -- strummer-mcp /abs/path/to/data/react.sqlite
```
See `py/strummer_ingest/README.md` and `packages/mcp/README.md`.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this file (current phase + next action).
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (why).
4. Skim project memories and `git log --oneline -15`.
5. Continue from **Next action** above.

## Known open questions

- npm publishing: scope packages under `@strummer/*` (bare `strummer` is taken
  on npm). Name confirmed fine for repo + Homebrew tap.
- Captured/script-set values flow through `response.captured` unredacted (needed
  for chaining); the MCP/CLI surface layer must decide how to expose them.

## Resolved (was open)

- **Repo license: Apache-2.0** (ADR 0002; `LICENSE` + `NOTICE` committed).
- **Version-pin fallback** (nearest-same-major → refuse) validated on the real
  React index: `^18.2.0` → 18.3.1, `16.8.0` → flagged.
