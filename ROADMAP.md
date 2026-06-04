# Strummer Roadmap

Phased plan. Phases are sequenced but the design is aspirational — items aren't
cut for being "v1-hard", they're scheduled. `STATUS.md` says which phase is
live right now.

## Phase 0 — Design & Scaffold  *(complete)*

Goal: a reproducible, 100%-green polyglot monorepo skeleton and the design docs
that make the project resumable and aspirational.

- [x] Decisions captured (stack, surface, first pillar, polyglot boundary, name).
- [x] Design research fan-out → `ARCHITECTURE.md` with exact stack & versions.
- [x] pnpm workspace scaffold: `@strummer/core` (mcp/cli land in Phase 1 with
      real behavior — no fake-stub packages).
- [x] Python `ingest` package scaffold (uv-managed).
- [x] Biome + Ruff configured; Vitest + pytest wired.
- [x] Polyglot boundary proven red→green (Python writes index, TS reads it).
- [x] Top-level "green gate" (`pnpm gate`) runs both languages.
- [x] Dev container provisions pnpm + uv.
- [x] Milestone push to GitHub.

## Phase 1 — Docs / idioms pillar  *(complete, incl. deferred polish)*

Goal: an agent can ask "the current idiomatic way to do X in library Y at the
installed version Z" and get a precise, cited answer over MCP.

- [x] **Polyglot boundary proof:** Python writes a SQLite index; TS reads it
      back end-to-end (smallest possible red→green step).
- [x] SQLite index schema (FTS5 + vec0; title/body/symbol/library/version).
- [x] MCP tools: `search_docs`, `get_doc` + `strummer://doc/{id}` resource
      (structured, resource-link output; SDK 1.29).
- [x] Python ingestion pipeline: HTML → clean fragments → FTS5 + vectors.
- [x] First real source adapter (**DevDocs**) against **React 19.2** — a
      1,279-fragment index built and served over MCP.
- [x] **Hybrid search:** sqlite-vec KNN + RRF fusion with bm25 in `searchDocs`;
      in-server query embedding via transformers.js (matches fastembed, ADR 0003).
- [x] **Version pinning:** `resolveVersion` (exact → nearest-same-major →
      refuse) + multi-version index (`build --append`); `search_docs installed`
      + `list_versions`. React index holds 19.2/18.3.1/17.0.2.
- [x] **Detect the installed version from a project** — `detectInstalledVersion`
      (node_modules/lockfile/package.json); `detect_version` tool + `search_docs
      project` input (auto-pin with zero ceremony).
- [x] `@strummer/cli` thin human entry over `core` (`search`/`get`/`versions`/
      `detect`); query embedder extracted to `@strummer/embed`.
- [x] **Second source adapter: Dash docsets** — `dash.iter_fragments` reads a
      `.docset` bundle (`searchIndex` + `Documents/*.html`), reuses
      `split_sections`/`symbol_from_heading`, `normalize_dash_type` for the type
      taxonomy; `build --docset` CLI source. (Core Data docsets: future.)
- [x] **Detect installed versions for non-Node ecosystems** — `detectInstalledVersion`
      now dispatches by ecosystem (auto-probe node → python → ruby, or explicit):
      Python (dist-info METADATA, uv/poetry/Pipfile locks, requirements.txt,
      pyproject.toml) + Ruby (Gemfile.lock, Gemfile). `ecosystem` wired into the
      `detect_version`/`search_docs` MCP tools + CLI `detect`/`search`.
- [x] **Ingestion refinements** — `split_sections` strips on-page table-of-contents
      lists (intra-page-anchor `<ul>`/`<ol>`) so their titles stop bleeding into the
      first section; `symbol_from_heading` recovers a code symbol from signature
      headings (`useState(initialState)` → `useState`) as a fallback when a section
      has no source-index entry.

## Phase 2 — API testing pillar  *(COMPLETE — core + tail; design = ADR 0004 + 0005)*

- [x] `@strummer/api` package + Bruno `.bru` format (via `@usebruno/lang`) +
      thin domain model; Strummer assertions/captures in `*.strummer.yml` sidecar.
- [x] Declarative assertion engine (status/statusText/header/jsonpath/responseTime/
      schema) + undici runner + resource-handle artifacts.
- [x] Secrets: `{{secret:NAME}}` + `SecretStore` (`@napi-rs/keyring`/env/static/
      chained), fail-closed, value-redaction (raw + base64/url encodings).
- [x] Mutation safety gate: dry-run by default; send only with `allowUnsafe` +
      host allowlist. **+ SSRF range-block on every request** (reuses
      `@strummer/safety` `resolveAndPin`; metadata/link-local always refused,
      loopback/private gated by `allowPrivate`, default permissive for local
      testing — `STRUMMER_BLOCK_PRIVATE` / CLI `--block-private` to harden) **+
      opt-in redirect following (`maxRedirects`) with per-hop re-check** (SSRF +
      mutation allowlist + cross-origin credential-header strip).
- [x] Request chaining via captures (`extractCaptures` + `runSequence`).
- [x] Environment-file loading (`environments/<Env>.bru`, lowest precedence) +
      request **body** sending — the full matrix now materializes from a `.bru`:
      json/text/xml/sparql (raw), form-urlencoded, **graphql** (`{query, variables}`
      JSON envelope; variables interpolated + JSON-parsed), **multipart-form**
      (text + file parts via undici `FormData`, files read from disk, undici mints
      the boundary), and **file** (raw bytes under the declared content-type).
      File paths resolve against the collection dir (operator-authored config;
      egress separately gated). Agent-facing previews summarize binary/file parts
      (name + byte size), never inlining bytes; secrets resolve in every part and
      are redacted at the surface. _(Fixed a latent gap: `graphql` was mis-stored
      as a raw string; and an uncaught discriminator regression — the parser emits
      camelCase `formUrlEncoded`/`multipartForm`, normalized via an alias map.)_
- [x] QuickJS-sandboxed pre/post scripts (curated `bru`/`expect`/`test` API;
      JSON-only boundary, 1s interrupt). Sidecar `preScript`/`postScript`.
- [x] **Contract validation & drift detection** (ADR 0005, ajv-direct): `schema`
      assertion (ajv 2020-12); `validateOpenApiResponse` (OpenAPI 3.1: path/status
      match, response-schema validation, local `$ref`→`$defs`); `validateGraphql
      Operation` (graphql-js: query-vs-schema drift incl. missing root types +
      response `errors`). Adversarially verified.
- [x] **MCP tools** (`list_requests`/`get_request`/`run_request`/`run_collection`/
      `validate_response` + `strummer://run/{id}/body` resource; `strummer-api-mcp`
      bin; safety operator-set, not agent-set) **+ CLI** (`strummer api list|get|
      run|run-collection|validate`). Built as a parallel fan-out, integrated green.
- [x] **Keyring secret store wired** into both surfaces: CLI `--keyring`, MCP
      `STRUMMER_KEYRING` (chains the OS keyring ahead of `STRUMMER_SECRET_<NAME>`).
- [x] **Import**: Postman v2.1 / Insomnia v4 / OpenAPI 3.x / HAR → `.bru`
      (`import.ts`, native — `@usebruno/converters` is unavailable offline, so the
      importers normalize each source and serialize via `@usebruno/lang`
      `jsonToBruV2`). CLI `strummer api import <format> <src> <dest>`. multipart/
      file bodies + non-header auth deferred.
- [x] **Contract validation reach** (ADR 0005): **external local-file `$ref`**
      deref (JSON+YAML, incl. the file's own internal refs, cycle-guarded; remote
      http refs stay out of scope — SSRF); **OpenAPI 3.0 `nullable` shim** →
      3.1-style type union; **`operationName`-scoped GraphQL** drift. CLI `--openapi`
      passes the spec dir as the deref base; `validate --operation`; MCP
      `validate_response.operationName`.
- [x] **Non-scalar request-param serialization (ADR 0016)** — `validateOpenApiRequest`
      validates array params, converting prior `unverified`-skips into real findings (no
      new finding kind; signature unchanged; reaches the capture bridge + live
      `api run --openapi` with no surface change). Designed via a research→synthesis→2-critic
      fan-out; the cardinal invariant: ambiguous/unsupported ⇒ `unverified`-skip, never a
      false finding.
  - [x] **v1 — query `form` arrays, `explode=true`** (≥2 occurrences = the array, sound
        count; single occurrence wrapped only when comma-free + no cardinality, else
        `unverified`) — coerce each element + ajv the assembled array. Plus the mandatory
        **undocumented-param suppression** around object query params (form/explode object
        ⇒ suppress the whole pass; deepObject ⇒ exclude `name[...]` keys; unresolved `$ref`
        ⇒ suppress).
  - [x] **slice 6 — delimited arrays (ADR 0016 addendum 1)** — query `form/explode:false`
        (split `,`), `spaceDelimited` (` `), `pipeDelimited` (`|`); path `simple` (`,`);
        header `simple` (`,`, trimmed) — **only for NON-STRING scalar items** (the delimiter
        can't occur inside an integer/number/boolean, so the split is exact + cardinality is
        sound). String/typeless items + empty segments stay `unverified` (irreducible
        embedded-delimiter class).
  - [x] **slice 7 — path `label` + `matrix` arrays (ADR 0016 addendum 2)** — `label`
        (`.a,b,c` / `.a.b.c`) + `matrix` (`;n=a,b,c` / `;n=a;n=b`): strip the RFC 6570 prefix
        then split per explode. Same non-string-scalar gate, with `number` excluded for
        label-EXPLODE (its `.` delimiter collides with the decimal point). A malformed prefix
        ⇒ `unverified`, never a false fail.
  - [x] **slice 8 — object reconstruction + `multipleOf` guard (ADR 0016 addendum 3)** —
        query `deepObject` (`name[prop]` discrete keys, string props sound) + `form/explode=false`
        (`name=k,v,k,v`, integer/boolean props + `additionalProperties:false`). Object-form
        `additionalProperties`/nested/repeated keys ⇒ `unverified`. Plus a cross-cutting fix: a
        fractional `multipleOf` (IEEE-754 FP trap, confirmed pre-existing in scalar+array number
        paths) ⇒ `unverified` everywhere. `form/explode=true` objects stay permanently out
        (shared namespace; undoc-suppression only). **Non-scalar param ARRAY+OBJECT matrix complete.**
  - [x] **non-JSON request BODY schemas (ADR 0016 addendum 4)** — validate
        `application/x-www-form-urlencoded` + `multipart/form-data` (text parts) bodies against
        the declared object schema. Form bodies arrive as a flat field→value(s) map on a NEW
        authoritative `RequestFacts.form`/`formFileFields` channel (file bytes never inlined,
        never re-parsed from the serialized string); `validateFormBody` mirrors
        `validateObjectParam`'s coerce-then-ajv logic, and discrete repeated keys make even
        STRING array items sound. REFUSE → `unverified`: any per-property `encoding`; non-UTF-8
        charset; non-flat-object schema; typed `additionalProperties`; nested/typeless/
        array-of-object props; fractional `multipleOf`; scalar-with-repeats; single-occurrence
        array + cardinality; ambiguous empty value; a prop satisfied by a multipart FILE part.
        Reaches the LIVE `api run --openapi` (via `runRequestForContract`) + direct MCP
        `validate_request` (`form`/`formFileFields`) + CLI `api validate-request --form`/
        `--form-file`. Signature + result shape + finding kinds UNCHANGED (reuse
        `request-body-schema`). **The ADR 0016 tail list is now EMPTY.**
  - [x] **HAR-CAPTURE form bodies (ADR 0016 addendum 4 follow-up)** — `harEntriesToFacts`
        resolves a `form`-style request `postData` into `RequestFacts.form`/`formFileFields`
        (prefer structured `postData.params[]`; `fileName` ⇒ file part names-only; urlencoded
        `text` fallback; raw multipart with no `params[]` stays `unverified` — no boundary
        parse), and the REST branch drives `validateOpenApiRequest` NON-authoritatively (absent
        required field ⇒ `unverified`→`noSignal`; present invalid value ⇒ a true finding,
        redacted). No surface change (`validate_capture` auto-resolves it).
  - [x] **per-property `encoding` ⇒ PERMANENTLY OUT** (not staged) — any `encoding` block
        `unverified`-skips the body; honoring it re-introduces the full param style/explode
        ambiguity matrix inside the body (mostly the irreducible embedded-delimiter class) for a
        rare feature. **The ADR 0016 tail list is now genuinely EMPTY.**

## Phase 3 — Browser / UI testing pillar  *(FEATURE-COMPLETE — engine + safety + artifacts + MCP + CLI + multi-engine; live-view dropped per ADR 0008; only the explicitly-aspirational bucket remains; design = ADR 0006/0008/0009 + ARCHITECTURE §10)*

New pure-TS `@strummer/browser`, thin on **stable `playwright-core` 1.60.0** (not
a wrap of `@playwright/mcp`). Design grounded by a 5-stream research workflow with
adversarial verification (`docs/research/2026-05-31-pillar3-browser-testing.md`).
Staged below; aspirational items are scheduled, not cut.

- [x] **Slice 1 (first red→green):** a11y-audit summarizer + on-disk
      `ArtifactStore` + handle resolution, against an in-process `node:http`
      fixture (no pixels/perf/network).
- [x] **Scaffold `@strummer/browser`** (Apache-2.0, ESM, tsdown, Biome+Vitest);
      add to the pnpm workspace + `pnpm gate` + CI; pin `playwright-core` 1.60.0
      and `mcr.microsoft.com/playwright:v1.60.0-noble` in lockstep.
- [x] **Browser lifecycle manager** (`BrowserManager`) — lazy single shared
      browser, ephemeral isolated context per session, `maxContexts` cap,
      idle-TTL `sweepIdle` + `startReaper`, per-context default action/navigation
      timeouts, `closeSession`/`shutdown`. _(Update: a `maxSessionMs` wall-clock cap
      — `sweepIdle` reaps past `now - createdAt` even when active — and a `maxPages`
      per-context cap — a `'page'` guard closes pages opened beyond the limit — now
      land; both operator-set via `STRUMMER_BROWSER_SESSION_MS`/`MAX_PAGES`, default
      no cap. `f0fc419`.)_
- [x] **ARIA-snapshot capture + serializer** (`snapshot.ts`) — parses the public
      `locator.ariaSnapshot()` YAML and **mints our own ref-ids** (1.60.0 lacks
      `_snapshotForAI`/snapshot-refs; see ADR 0006 update 2026-06-01, a revision
      of the "copy @playwright/mcp's serializer" open fork). `buildSnapshot`
      (parse → mint → token-capped serialize), `captureSnapshot` (+ full-snapshot
      handle), `diffSnapshots` (scoped, ref-independent); refs → semantic-locator
      descriptors `{role,name,nth}`, per-snapshot/non-persisted.
- [x] **Imperative step tools** (`PageDriver`) over refs → semantic locators with
      auto-waiting: navigate, click, fill, fillForm (batch), selectOption, press,
      waitFor, snapshot, getText/getValue/getAttribute (free reads). Each
      navigating/mutating step re-captures under a new snapshot generation and
      returns a scoped diff + capped snapshot + handle; refs tagged by generation
      (`s2e3`) so a stale ref fails loudly instead of matching a wrong element.
- [x] **Deny-by-default action gate** (`BrowserGate` + `PageDriver` wiring) —
      operator-set `{allowUnsafe, allowedHosts}`; reads free; navigation gated by
      host allowlist; mutating interactions **dry-run by default** (one-shot route
      captures + aborts the would-be request, returns a preview) and execute only
      with `allowUnsafe` + an allowlisted host; hard-deny otherwise. Config is
      operator-set, never an agent input. _(Dialog gating now lands: `PageDriver`
      installs `page.on('dialog')` → dismiss-by-default + record `DialogEvent`s onto
      `StepResult.dialogs`; `BrowserGate.allowDialogs` (bin `ALLOW_DIALOGS`) flips to
      accept. Auth = origin-scoped `httpCredentials` (done). Downloads/uploads gating
      still scheduled — see the Downloads-quarantine bullet.)_
- [x] **Factor `@strummer/safety`** — shared SSRF range classifier (`isBlockedIp`/
      `isBlockedHost`/`isBlockedHostLiteral`, `ipaddr.js`, fail-closed) +
      `resolveAndPin` (DNS resolve → refuse blocked range → pinned IP) + the
      `Redactor` (moved from `@strummer/api`, re-exported there). Consumed by both
      pillars.
- [x] **Tier-1 route allowlist** (`installSafetyRoutes`, wired into
      `BrowserManager` when a gate is set) — `browserContext.route` deny-by-default
      governing every request (nav + subresource + XHR); **allowlist-authoritative**
      (ADR 0006 update 2026-06-01: private/metadata literals blocked by
      deny-by-default, not unconditionally, so localhost apps remain testable).
- [x] **Tier-2 loopback DNS-pinning SSRF proxy** (`createSsrfProxy`) — HTTP +
      HTTPS-CONNECT forward proxy passed as Chromium's `proxy.server`; calls
      `resolveAndPin` per request/CONNECT (resolve once → refuse blocked range →
      connect to the pinned IP), so allowlisted-hostname rebinding is refused
      (HTTP→502 / tunnel refused); redirects re-checked (each hop is a fresh
      request). Operator `allowPrivate` opt-in permits loopback/RFC1918 for
      local-app testing but never link-local/metadata. _(Now wired into the bin's
      launch as mandatory; `serviceWorkers:'block'` is a `BrowserManager` context
      default and WebRTC is neutralized via
      `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` — `9207224`.)_
- [x] **Secret boundary** (ADR 0006 §6) — `{{secret:NAME}}` fill resolution
      server-side at the fill boundary (fail-closed, bin-wired from
      `STRUMMER_BROWSER_SECRET_*`); origin-scoped `httpCredentials` applied per
      context via `BrowserManager` (bin-parsed from `STRUMMER_BROWSER_HTTP_*`,
      password redacted + kept out of config); `storageState` **by handle**
      (operator-gated `browser_save_storage_state` → counts + handle only, never
      inlined; the resource refuses the password-equivalent `storage-state` kind);
      and **redaction before any write** across console/network (8b), dry-run
      preview url+postData (8a), ARIA-snapshot text+stored tree (A1), surface reads
      (Milestone B), and the **trace.zip** text entries (metadata + DOM/sources
      snapshots, via fflate). _(Further refinements scheduled, not blocking: HAR
      bodies; userDataDir/storageState **import** for operator login-reuse.)_
- [x] **Engine hardening for the MCP surface** (Milestone A, slices A1–A6) —
      surfaced by the `browser-mcp-design` fan-out's adversarial review: snapshot
      redaction seam (A1); per-generation immutable artifact handles `snapshot-s<gen>`
      / `a11y-s<n>` so a returned handle never resolves to a later tree (A2);
      bounded `diffSnapshots` output (A3); dry-run popup-block + `crossOriginEgress`
      flag (A4); no-snapshot vs stale-ref error in `PageDriver` (A5);
      `BrowserManager.onReap` flush hook so a reaped recording session writes its
      artifacts before the context closes (A6).
- [x] **Browser MCP surface + server bin** (Milestones B+C; design = the
      `browser-mcp-design` fan-out, MCP-only this pass) — `registerBrowserTools`/
      `createBrowserServer` (`packages/mcp/src/browser.ts`): 15 session-oriented
      tools over a per-session-mutex registry; server-minted UUID sessionId+runId
      (never agent input); reads redacted at the surface; reaper reconciliation
      (`manager.onReap` flush + `hasSession` eviction); the two-variable
      `strummer://browser/run/{runId}/{kind}` resource. `strummer-browser-mcp` bin
      (`bin-browser.ts`): namespaced `STRUMMER_BROWSER_*` env (no api-var fallback),
      **mandatory** SSRF proxy + `--proxy-bypass-list=<-loopback>`, trace-off
      default, sandbox-on default. Safety is operator-set; no tool input flips a
      flag.
- [x] **Human `strummer browser` CLI** (`@strummer/cli` `browser snapshot|audit|
      screenshot <url>`, `packages/cli/src/browser.ts`) — single-shot page
      inspection over the engine (navigate once + read; refs needn't persist across
      the process). Reuses the bin's egress boundary: a gated `BrowserManager` +
      mandatory `createSsrfProxy` + the loopback-bypass/WebRTC launch args; the typed
      host is auto-allowed (explicit operator intent) plus `--allow-host`; flags
      `--allow-private`/`--no-sandbox`/`--headed`/`--json`/`--out`/`--full-page`;
      `audit` exits 1 on a11y violations (CI-usable). Real-chromium tested.
- [x] **Artifact capture pipeline** — `RunRecorder` (`recorder.ts`) captures a
      Playwright trace.zip (screenshots+snapshots+sources) + own console/network
      logs, all by `strummer://browser/run/<id>/<kind>` handle with structured
      summaries (`byType`/`byStatus`/`failed`/`byteSize`); text channels redacted
      before write; per-channel enable flags. _(On-demand screenshot capture now
      ships as a step tool: `PageDriver.screenshot()` → PNG by `screenshot-s<n>`
      handle; MCP `browser_screenshot` operator-gated off by default
      (`STRUMMER_BROWSER_ALLOW_SCREENSHOTS`) — unredactable pixels, same posture as
      the trace.zip; the run-artifact resource serves `image/png` as a base64 blob.)_
- [x] **`browser_trace_query`** — `queryTrace` parses the trace.zip's `.trace`
      JSON-lines **directly** (the chosen path over an `npx playwright trace`
      subprocess: `open` is a GUI viewer and there are no console/network/errors
      subcommands — those live inside the trace). Pairs `before`/`after` by `callId`
      into an action timeline (api/timing/error/params) + console + errors +
      browser/Playwright metadata; filters apiFilter/errorsOnly/limit/includeParams.
      MCP `browser_trace_query` reads the stored (already-redacted) trace by runId —
      no live session needed (query after close). Schema probed against the pin.
- [x] **Browser assertions** — one assertion engine across pillars. Factored the
      operator core into **`@strummer/assert`** (`AssertionOp` + `applyOp`, extracted
      from `@strummer/api`, which now consumes it). `@strummer/browser` `assertions.ts`
      + `PageDriver.assert` evaluate `url`/`title`/`ariaSnapshot` (page) +
      `text`/`value`/`visible`/`count` (element, by ref or role+name) with
      **auto-waiting** (fast count-gated poll, not Playwright's default timeout);
      observed values redacted. MCP `browser_assert` tool (free read).
- [x] **Perf-audit tool** — `auditPerf` (`perf.ts`) runs Lighthouse 13.3.0 node API
      (`onlyCategories:['performance']`) via `chrome-launcher` at the operator
      chromium path + operator flags (the bin passes the mandatory SSRF proxy +
      loopback-bypass + WebRTC arg, so Lighthouse's nav traverses the egress
      boundary). Score + core web-vitals (FCP/LCP/TBT/CLS/SI/TTI) summary inline; full
      LHR JSON+HTML by handle, redacted before write. MCP `browser_perf_audit` is
      standalone (own runId, no session) + allowlist-gated; assert shape/thresholds,
      never exact scores.
- [x] **Network heavy mode** — HAR **capture**: `BrowserManager` `harDir` records
      a full HAR (`content:'attach'`, `mode:'full'`) per context; on close
      `finalizeHar` redacts every text entry (the `.har` JSON + persisted text
      bodies, fflate) before surfacing, stores by `strummer://browser/run/<id>/har`
      handle, returns a compact summary (entryCount/byStatus/byMethod), and removes
      the raw staged file — driven by a new `BrowserManager.onClosed` hook (after
      `context.close()`; mirror of `onReap`) so the explicit close, idle reaper, AND
      shutdown all finalize (no unredacted HAR left on disk). HAR **replay**:
      `PageDriver.replayFromHar` arms `page.routeFromHAR(notFound:'abort')` for
      deterministic offline runs (unmatched requests aborted, zero egress). MCP
      `browser_close_session` surfaces the HAR; `browser_replay_har` arms replay
      (call before navigate). Both operator-gated (`STRUMMER_BROWSER_HAR_DIR` /
      `STRUMMER_BROWSER_REPLAY_HAR_DIR`), deny-by-default; HAR is a heavy secret
      surface so capture is off by default (registered-secret redaction only).
- [x] **Downloads quarantine** dir + saveAs path validation; uploads confined to
      an operator upload-allowlist dir; download/upload as gated structured events.
      _(Downloads: `BrowserManager` `acceptDownloads:false` cancels by default;
      operator `DOWNLOAD_DIR` flips it on + `PageDriver` saves under a sanitized,
      indexed name (no traversal) and records a `DownloadEvent`; race-free
      `browser_downloads` read tool surfaces metadata only, bytes never served.
      Uploads: `PageDriver.uploadFiles` / MCP `browser_upload` is deny-by-default —
      requires operator `UPLOAD_DIR` and confines every path within it (no
      traversal/absolute escape), the exfiltration control. Dialog gating: dismiss
      by default, `ALLOW_DIALOGS` to accept, recorded as `DialogEvent`s. Auth:
      origin-scoped `httpCredentials`. The full gating bundle is complete.)_
- [x] **Container hardening ADR** (`docs/decisions/0007-container-hardening.md`) —
      the deployment-security posture behind the in-process spine: keep the Chromium
      sandbox by default (resolving the sandbox-in-container tension via unprivileged
      user namespaces, so **no `SYS_ADMIN`**; `--no-sandbox` only as a documented
      operator-gated fallback); non-root + no-new-privileges; `cap_drop: ALL`; a
      default-derived **seccomp** profile pinned to the Playwright image; read-only
      rootfs + minimal tmpfs/volume mounts (incl. the `/dev/shm` footgun, **not**
      `--ipc=host`); **WebRTC + QUIC disabled**; container-level **egress firewalling**
      as defense-in-depth behind the SSRF proxy (metadata endpoint unreachable). Maps
      each threat across the two boundaries (documented-API vs renderer-RCE bypass).
- [x] **Vision/coordinate capability** — operator-gated `allowVision` (off by
      default) for canvas / non-AX-tree UI the ARIA-snapshot path can't address.
      `PageDriver.mouseClick(x,y)` drives the raw pointer at a viewport coordinate
      **through the same mutation gate** as the ref/semantic clicks (dry-run vs
      execute); `mouseMove(x,y)` is non-mutating positioning (hover egress still
      governed by the always-on SSRF layer). MCP `browser_vision_click`/
      `browser_vision_move` are off by default (a blind click on a *point* sidesteps
      the accessible-tree safety story); **decoupled from `allowScreenshots`** so an
      operator can permit read-only screenshots without blind clicks. Bin:
      `STRUMMER_BROWSER_ALLOW_VISION`. Real-chromium tested (coordinate recorder).
- [x] **Video capture** (webm) operator-gated with size caps. `video.ts`
      `finalizeVideo` reads the `.webm` Playwright writes on context close, stores it
      by `strummer://browser/run/<id>/video` handle (no redaction — video is
      unredactable pixels, so it is gated **off** by default like the trace/
      screenshots), returns a compact summary (`byteSize`/`video/webm`), and removes
      the temp recording. `BrowserManager` gains `videoDir`/`videoSize` →
      `recordVideo:{dir,size?}` per context; the MCP surface finalizes the video in
      the same `onClosed` hook as the HAR (resolved via `page.video().path()`, since
      Playwright auto-names the file) and surfaces the `video` handle in
      `browser_close_session`; the run-artifact resource serves `video/*` as a base64
      blob. Bin: `STRUMMER_BROWSER_VIDEO_DIR` (+ `_VIDEO_WIDTH`/`_HEIGHT` size cap; the
      session wall-clock cap bounds duration). Real-chromium tested (EBML/webm magic).
- ~~**Developer live-view**~~ — **DROPPED (2026-06-01), not deferred.** Strummer
      is **LLM-first**: the high-value question is "navigate to the personnel page
      and tell me what AJAX requests happen", and the trace timeline (`browser_trace_query`),
      HAR capture, console/network artifacts, and video already answer that
      *better* than a human watching pixels render. So we commit to **headless
      only** and spend no effort on the Xvfb→x11vnc→noVNC headed profile or
      `--remote-debugging-port` DevTools attach. (The CLI's single-shot `--headed`
      launch flag stays as a trivial escape hatch where a display exists; it is not
      a live-view feature.) See ADR 0008.
- [x] **Visual regression** — `@strummer/browser` `visual.ts` `compareScreenshots`
      (pixelmatch 7.2.0 + pngjs 7.0.0): a **pure, deterministic** pixel diff —
      diff-pixel count/ratio, `maxDiffPixelRatio`/`maxDiffPixels` budget, pixel-rect
      `mask[]` for dynamic regions, size-mismatch hard-fail, diff PNG. `PageDriver.
      screenshot()` gains stable-capture options (`animations:'disabled'`/
      `caret:'hide'`/`clip`). MCP `browser_visual_compare` (operator `baselineDir`,
      deny-by-default): captures the current page, diffs vs the named baseline, stores
      the diff PNG by `visual-diff-s<n>` handle on mismatch; `update:true` records a
      baseline (separately operator-gated — an agent can't rewrite the golden). Bin:
      `STRUMMER_BROWSER_BASELINE_DIR` + `STRUMMER_BROWSER_ALLOW_BASELINE_UPDATE`. The
      flake-prone part — **committing** cross-platform baselines — is deferred: they
      are operator-managed, generated in the pinned Docker image keyed by (name,
      browser, platform). `odiff` opt-in for large corpora is future. Tested
      deterministically (in-memory PNGs + a real-chromium self-captured baseline, so
      nothing is committed to the repo).
- [x] **`.bru` + sidecar persistence** for replayable browser step flows
      (semantic locators, not persisted refs) — mirrors ADR 0004. `flow.ts`: a
      Bruno-openable `<name>.bru` (meta) + `<name>.strummer.yml` sidecar holding
      ordered `steps` (navigate/click/fill/select/press/wait_for/assert), keyed by
      `SemanticLocator {role,name?,nth?}`. `loadFlow`/`loadFlowCollection` parse +
      validate (fail-loud) into a typed model; `runFlow(driver, flow, opts)` replays
      sequentially with `{{var}}` interpolation + fail-closed `{{secret:NAME}}`
      resolution (driver redactor scrubs cleartext; assert expected-values get vars
      only, never secrets). PageDriver gained semantic-locator action methods
      (`clickAt`/`fillAt`/`selectAt`/`pressAt`) driving via `getByRole` directly +
      reusing the mutation gate. Surfaced by `strummer browser run <flow.bru>`
      (--var/--unsafe/--allow-host/--json, exit-nonzero on failure); example in
      `examples/browser/login/`. _(The MCP follow-up is **done**: `browser_list_flows`
      + `browser_run_flow` replay a flow **by name** (no caller path) on a session's
      gated driver behind the per-session mutex — caller `{{var}}`s + operator-resolved
      `{{secret:NAME}}` (fail-closed), surface error redaction; deny-by-default via
      `STRUMMER_BROWSER_FLOWS_DIR`. Agent surface at parity with `strummer browser run`.)_
- [x] **Multi-engine** (firefox/webkit) — DONE (ADR 0009). `engine.ts`:
      `resolveEngine` (default chromium, throws on a typo) + `engineLauncher` /
      `engineLaunchOptions`. The injected-`launch()` `BrowserManager` is unchanged
      (engine-agnostic); selection lives at the launch seam. Bin
      `STRUMMER_BROWSER_ENGINE`, CLI `--engine chromium|firefox|webkit`. The SSRF
      **proxy applies to every engine**; the chromium-only hardening args
      (`--proxy-bypass-list`/WebRTC/`--no-sandbox`) are emitted only for chromium
      (firefox/webkit rely on the Tier-1 route allowlist + proxy — chromium stays
      the hardened default). Lighthouse perf stays chromium (Chrome-only). One
      engine per server instance. Verified end-to-end: firefox + webkit drive
      navigate→snapshot→click→re-snapshot (real cross-engine test, skips where the
      binary is absent). CI + dev image now install all three engines.
- [ ] *(aspirational, scheduled not cut)* optional `@playwright/mcp` embed via
      `createConnection()` behind a feature flag for parity testing; autonomous
      self-healing "act"/locator-cache behind a strong operator gate; cross-pillar
      verification tying browser network capture to the API pillar's contract
      validation.

## Phase 4 — Cross-cutting verification tools  *(pillars COMPLETE — engine + agent surface; Python adapters (flake/coverage/deps/mutate) + LSP capability-gated read tails + LSP write-mode (`lsp_rename`) done; only non-blocking tails remain; sequence locked by ADR 0010)*

Sequence decided by the `phase4-design-research` fan-out (5 research streams →
synthesis → 3 adversarial critics → corrected synthesis); see **ADR 0010** for the
ranking, the cross-cutting decisions (shared `@strummer/artifacts` extraction;
explicit pins / no transitive imports; paired deny-by-default operator gate; TS-first
with Python staged), and the per-candidate corrections the adversarial pass forced.
Two independent tracks, then the test-quality chain, then LSP last:

### Python (+Ruby) second half — the polyglot push *(UNDERWAY; ADR 0010 addendum 2026-06-04)*

The Phase-4 pillars shipped TS-first; the pure Python adapters (`parsePytestJson`,
`parseMutmutResults`, `coveragePyToIstanbul`) already landed. This arc adds the gated
spawn runners + pure deps diff-scoping that complete the Python half. **No new
boundary** — one-shot spawn-and-parse of a Python tool is the established vitest/stryker
runner pattern (ADR 0010 addendum). Four forks ratified by the human: cosmic-ray primary
(keep mutmut); coverage scoping fallback = both modes operator-visible, default report-gap
(testmon opt-in only); Ruby = deps lockfile-diff only this arc; pytest = json-report now,
stage `reportlog`. Pure/zero-spawn slices first.

- [x] **Slice 1 — deps `changedDependencies` for PyPI + RubyGems.** Generalized the npm
      block-aware diff walker into a per-file *classifier* selected by basename, unioning names.
      PyPI: `pyproject.toml` (PEP 621 `dependencies`/`optional-dependencies` arrays — `]`-outside-
      quotes close detection so `coverage[toml]` parses — + Poetry `[tool.poetry…dependencies]`
      tables, `python` skipped), `requirements*.txt`, TOML lockfiles (`uv.lock`/`poetry.lock`/
      `pylock.toml` `[[package]]` named-block, name from a context line + any changed line touches
      it), all PEP 503-normalized so manifest+lockfile dedupe. RubyGems: `Gemfile` (`gem "x"`) +
      `Gemfile.lock` (4-space concrete-version spec rows; transitive `(= …)`/`DEPENDENCIES`
      operator rows excluded by the digit-after-`(` anchor). Under-scope-safe (never invents).
      Pure, fixture-only; the `strummer verify run --deps` CLI already threads the ecosystem.
      *(Staged within: `Pipfile.lock`/`Pipfile`; the MCP `bin-verify` deps audit stays npm-only —
      separate registry-fetcher wiring.)*
- [ ] **Slice 2 — deps `changelog_diff` for PyPI + RubyGems.** Pure `repoUrlFromMetadata`
      (PyPI `info.project_urls`, RubyGems `source_code_uri`/`homepage_uri` via a second
      changelog-only fetch), reuse `sliceChangelog` with `comparatorFor(ecosystem)`. *(Staged:
      ecosystem-aware heading-token regex — PEP 440/Gem versions won't all match `SEMVER_TOKEN`.)*
- [ ] **Slice 3 — mutate `parseCosmicRayDump`** (pure) — `cosmic-ray dump` JSON-lines → MTE
      `MutationReport`; unrecognized/null outcome → `Pending` (ambiguity rule). Real dump
      fixture captured out-of-gate (provenance in `test/fixtures/README.md`).
- [ ] **Slice 4 — flake `runAndRecordPytest`** (gated runner) — near-clone of vitest's
      `runAndRecord`; `pytest --json-report`, loop the whole suite N times (NOT `pytest-repeat`),
      ingest via the existing `parsePytestJson`. MCP `flake_run` gains `framework`; CLI `--framework`.
- [ ] **Slice 5 — mutate Python mutation runner** (cosmic-ray primary + mutmut, `--tool`) —
      stdout-fed parse branch, `reportPath` optional; cosmic-ray TOML synth from `changedFiles` +
      `session.sqlite`; transport-completeness guard (pending/null → inconclusive). *(Depends on slice 3.)*
- [ ] **Slice 6 — coverage `runScopedPython`** (pytest + coverage.py) — mirror `runScoped`;
      `--cov=<target> --cov-report=json`; `coveragePyToIstanbul`→`uncoveredInDiff` (unchanged);
      pytest exit-code map (5=no-tests → inconclusive); scoping = diff path-heuristic with the
      ratified both-modes fallback. coverage.json fixture captured out-of-gate. *(Staged: testmon
      opt-in fast path.)*
- [ ] *(staged, this arc defers)* Ruby coverage (SimpleCov) + mutation (`mutant`/`mutest`) runners,
      gated on a `mutant` licensing investigation; a Python `pytest-reportlog` aggregating parser.

- [x] **Dependency/version intelligence** (`@strummer/deps`) — *track B, COMPLETE (npm + PyPI + RubyGems).*
      Cleanest architectural fit: pure offline verdict core + an operator-provisioned
      on-disk OSV advisory snapshot (file-as-data); extends shipped
      `detectInstalledVersion`/`resolveVersion`; answers deprecation/EOL/CVE/freshness
      for **the installed version** (not "latest").
  - [x] **Slice 1 — `auditDeprecation`**: pure, offline deprecation reducer over an
        npm packument (version-scope wins over package-scope; empty-string
        un-deprecate idiom honoured). Committed fixtures, zero network/subprocess.
  - [x] **Slice 2 — `matchVulnerabilities`**: pure OSV version-range matcher (the
        documented sort-events-then-scan algorithm; SEMVER/ECOSYSTEM ranges via
        `semver`, `last_affected` inclusive vs `fixed` exclusive, explicit `versions`,
        ecosystem+name filter; severity bucketed `critical|high|moderate|low|unknown`).
        Pure over committed OSV-advisory fixtures.
  - [x] **Slice 3 — `loadOsvSnapshot`**: read an operator on-disk OSV snapshot
        (`<dir>/<ecosystem>/all.zip`, fflate-unzipped, one advisory JSON per entry),
        parse → `OsvAdvisory[]` (sorted by id) feeding `matchVulnerabilities`, surface
        `snapshotDate` (newest advisory `modified`) so "no known vulns" is never
        treated as authoritative; fail loud on an absent ecosystem snapshot. Real FS
        round-trip in tests, zero network.
  - [x] **CVSS-vector → bucket scoring** — pure `cvssV3BaseScore` (CVSS v3.0/v3.1 base
        formula + official Roundup, verified against the spec's example vectors; v2/v4 →
        undefined). `matchVulnerabilities` keeps the qualitative GHSA
        `database_specific.severity` authoritative, else derives the bucket from the
        highest CVSS v3 vector on the matching affected entries / advisory (OSV `severity[]`
        `{type, score}`), so a vector-only advisory no longer reports `unknown`.
  - [x] **Slice 4 — `auditDependency`**: pure roll-up composing `auditDeprecation` +
        `matchVulnerabilities` + freshness (latest / latestSameMajor / isOutdated via
        `semver`, prereleases excluded) into one verdict — `worstSeverity`,
        `recommendedTarget` (conservative newest-same-major), `snapshotDate`,
        `hasFindings`. Inputs are gathered by the caller (still pure/offline).
  - [x] **Vuln-aware "minimum safe upgrade" target** — `auditDependency.minimumSafeUpgrade`:
        the lowest stable release newer than installed that re-matches ZERO advisories
        (re-evaluated per candidate against the full advisory set, so a release that fixes
        the original vuln but is hit by a different one is skipped); `undefined` when nothing
        is vulnerable or no release clears them. Distinct from the conservative same-major
        `recommendedTarget` (a security fix may cross a major). Surfaced in
        `audit_dependency` + the `audit_project` roll-up.
  - [x] **`behindBy` freshness metric** — `FreshnessVerdict.behindBy` breaks upgrade
        distance down by semver component (`releases` newer / `major` / `minor` within the
        installed major line / `patch` within the installed `major.minor`), each floored at
        0, `undefined` for a non-semver installed version. Lets a caller judge upgrade
        risk (patch bump vs major jump), not just the binary `isOutdated`. Carried through
        `audit_dependency` + `audit_project`'s by-handle detail.
  - [x] **Slice 5 — MCP surface** `audit_dependency` (single package) + `audit_project`
        (compact npm-manifest roll-up; per-package error non-fatal) in
        `packages/mcp/src/deps.ts` (`registerDepsTools`/`createDepsServer`). Detect the
        INSTALLED version (`core.detectInstalledVersion`, ecosystem-mapped npm→node) →
        injected packument fetch → operator OSV snapshot → pure `auditDependency`;
        reports `osvSnapshotLoaded` so "no known vulns" is never authoritative absent a
        snapshot. `strummer-deps-mcp` bin (`bin-deps.ts`) reads namespaced
        `STRUMMER_DEPS_*` (`OSV_DB_DIR`, `ALLOW_NETWORK` off by default, `NPM_REGISTRY`,
        `ALLOW_PRIVATE`) and is the sole builder of the SSRF-pinned (`resolveAndPin`,
        private blocked by default) packument fetcher. Safety/network operator-set,
        never agent inputs. (TDD: real OSV-snapshot zip + temp `node_modules` project +
        injected fetcher.)
  - [x] **Shared `@strummer/artifacts` extraction** (ADR 0010 cross-cutting) — the
        on-disk `ArtifactStore` moved out of `@strummer/browser` into a new shared
        package with a **parameterized** `strummer://<prefix>/<id>/<kind>` handle prefix
        (browser bakes in `browser/run`; deps/coverage emit their own). Behavior-
        preserving (browser suite is the regression guard); unblocks the first
        handle-emitting Phase-4 slice.
  - [x] **`changelog_diff`** — pure `sliceChangelog(markdown, {from, to?})` core
        (versioned ATX headings, Keep-a-Changelog + plain `## vX.Y.Z`; sections in
        `(from, to]` newest-first; semver-ordered) + the `changelog_diff` MCP tool: an
        **injected** changelog fetcher → slice → store the sliced markdown **by handle**
        in `@strummer/artifacts` (`deps` prefix), compact summary; new
        `strummer://deps/{id}/{kind}` resource. Deny-by-default (registers only with both
        a fetcher + artifact store). Bin: `STRUMMER_DEPS_ARTIFACT_DIR` + a SSRF-pinned
        GitHub-raw CHANGELOG fetcher (packument repo → `raw.githubusercontent.com/HEAD`,
        `resolveAndPin` per attempt). **First handle-emitting deps slice** — first
        consumer of the extracted `@strummer/artifacts`.
  - [x] **by-handle full `audit_project` detail** — when an artifact store is configured,
        `audit_project` stores the full per-package `DependencyAudit` verdicts (vulnerability
        lists, deprecation messages, freshness) as one JSON blob by handle and surfaces
        `detailHandle`; the inline result stays a compact roll-up. The
        `strummer://deps/{id}/{kind}` resource now serves both audit detail + changelog
        slices (decoupled from the changelog fetcher).
  - [x] **Multi-ecosystem version algebra (ADR 0012)** — a pluggable `VersionComparator`
        threaded through `audit.ts`/`osv.ts` (npm behavior-preserving via `semverComparator`);
        `pep440Comparator` on the pinned `@renovatebot/pep440` (conformance + OSV-PyPI range tests);
        and **PyPI `audit_dependency` end-to-end** — `pypiJsonToPackument` + PEP 503
        `normalizePypiName`, the per-ecosystem comparator map in the surface, and a PyPI JSON-API
        packument fetcher in the bin (`STRUMMER_DEPS_PYPI_REGISTRY`). `changelog_diff` stays npm-only.
  - [x] **RubyGems `audit_dependency` end-to-end** — `gemComparator` on the pinned
        `@renovatebot/ruby-semver` (derives `compare` from `eq`/`gt`; loads cleanly) + Gem
        conformance fixtures, `rubygemsToPackument` (RubyGems API versions array → `Packument`,
        freshness derives latest), wired into the comparator map + a RubyGems API fetcher
        (`STRUMMER_DEPS_RUBYGEMS_REGISTRY`). All three ecosystems now audit a single package.
  - [x] **`audit_project` for PyPI + RubyGems** — pure `pythonManifestNames` (PEP 621
        `[project]` deps + optional-dependencies, Poetry deps + group deps, requirements.txt;
        PEP 503-normalized) and `rubyManifestNames` (Gemfile.lock `DEPENDENCIES` block, else
        Gemfile `gem` lines); the surface dispatches the reader by ecosystem and the npm-only
        gate is lifted. `audit_project` now rolls up npm, PyPI, and RubyGems.
  - [x] **`strummer deps` human CLI** — `audit`/`audit-project`/`changelog`; exits 1 on a
        security/deprecation finding. The pure ecosystem-dispatch helpers (`comparatorFor`/
        `matchName`/`dependencyNames` + `OsvEcosystem`) were lifted out of the MCP surface into
        `@strummer/deps` `ecosystem.ts` (one source of truth, shared by the surface + CLI;
        behavior-preserving). The CLI builds its own SSRF-pinned fetcher from `resolveAndPin`.
- [x] **Coverage-aware, impact-scoped test runner** (`@strummer/coverage`) — *track A, COMPLETE (engine + agent surface + CLI; coverage.py adapter).*
      Run only what a diff touches; coverage deltas; **uncovered-new-line** detection
      (the forgotten-assertion catch — the genuinely novel win under our TDD gate).
  - [x] **Slice 1 — pure `uncoveredNewLines` differ.** Classifies each diff-added line
        against an istanbul `FileCoverage` (`statementMap`/`s`, the `coverage-final.json`
        per-file shape) as `covered` / `uncovered` / `nonExecutable`, and surfaces the
        executable-but-unhit lines. The no-statement **`nonExecutable` third state** is
        encoded explicitly with a guard test (ADR 0010's correctness trap: istanbul derives
        line coverage from `statementMap`, so a blank/brace line is in neither set). Line
        hits mirror istanbul's `getLineCoverage` (max over statements per start line). Pure.
  - [x] **Slice 2 — `parseUnifiedDiff`.** Extracts, per file, the new-side line numbers a
        change ADDED (to feed the differ). A count-tracking state machine (ends each hunk
        when its `@@ -a,b +c,d @@` counts are consumed) distinguishes file headers from
        removed/added lines whose content starts with `-`/`+`, and handles multi-hunk/
        multi-file (incl. prefix-less, no `diff --git`), new/deleted files, and the
        no-newline marker. Pure.
  - [x] **Slice 3 — `uncoveredInDiff`.** Joins the two halves: parse the diff → match each
        file to its `coverage-final.json` entry → classify → report every executable-but-unhit
        new line across the diff + a per-file breakdown + aggregate summary. Path
        reconciliation: exact `<projectRoot>/<path>` when given, else a **unique** path-suffix
        match (refuses an ambiguous >1-key match); cross-platform path normalization. Pure.
  - [x] **Slice 4 — `runScoped`.** Runs only the tests a change touches (`vitest related
        <changed files>`) with v8 JSON coverage, then feeds `coverage-final.json` into
        `uncoveredInDiff`. Behind a **paired deny-by-default** operator gate (`allowRun` +
        `allowedRoots` allowlist + wall-clock cap; `CoverageGateError` on denial). The
        `vitest` run is an **injected `TestRunner`** (default spawns a subprocess — the
        child-process boundary that avoids in-process Vitest-in-Vitest); the engine owns the
        gate/argv/collection/diff-wiring and is unit-tested with a fake runner (no real
        spawn in the gate).
  - [x] **MCP surface + `strummer-coverage-mcp` bin** — `uncovered_in_diff` (free,
        read-only; diff + coverage inline or by path) + `run_scoped` (gated; registered only
        when the operator set `allowRun` AND a non-empty root allowlist — deny-by-default).
        Bin reads `STRUMMER_COVERAGE_ALLOW_RUN` / `_PROJECT_ROOTS` / `_TIMEOUT_MS` and wires
        the live vitest subprocess runner. **The coverage pillar's agent surface is complete.**
  - [x] **Python (coverage.py) adapter** — pure `fileCoverageFromCoveragePy` /
        `coveragePyToIstanbul` (`coverage json`'s line-list shape → the istanbul `FileCoverage`
        the differ already consumes: one synthetic single-line statement per executed/missing
        line, excluded omitted → `nonExecutable`). The differ (`uncoveredInDiff`/
        `uncoveredNewLines`) is unchanged (ecosystem-agnostic). `uncovered_in_diff` gained a
        `coverageFormat: istanbul|coveragepy` discriminator so the Python path is agent-reachable.
  - [x] **`strummer coverage` human CLI** — `uncovered-in-diff` (istanbul|coveragepy) +
        gated `run-scoped`; exits 1 when a new line is uncovered.
  - [ ] *(staged)* pin `istanbul-lib-coverage` if `CoverageMap` merging/summaries are needed;
        a Python `run_scoped` (pytest --cov argv) sibling.
- [x] **Flaky-test detection & quarantine** (`@strummer/flake`) — **COMPLETE (engine +
      agent surface).** Protects the deterministic green gate. Pure Wilson/binomial
      classifier over a run-history fixture first; quarantine **writes** operator-gated
      (paired) with mandatory expiry. Opens its own private `better-sqlite3` history DB (a
      second SQLite owner, outside the docs-pillar core invariant — noted in ADR 0010).
  - [x] **Slice 1 — pure `wilsonInterval` + `classifyHistory`/`classifyHistories`.**
        The Wilson score interval for a binomial proportion (clamped to [0,1], degenerate
        zero for zero runs — chosen over naive p̂=failures/runs, which is overconfident at
        small n and collapses at the p̂=0/1 boundaries) + a classifier over per-test run
        histories → `FlakeVerdict {state, runs, passes, failures, failureRate, wilson,
        flakeScore}`. Policy: a **mixed** history is `flaky` at any run count (observed
        inconsistency = flaky); an all-pass/all-fail history is `reliable`/`broken` only
        once it clears `minRuns` (default 5), else `insufficient-data`. `flakeScore` = the
        Wilson lower bound of the failure rate — the conservative, sample-size-aware
        magnitude the (later, operator-gated) quarantine slice thresholds on. Pure/offline
        over a committed `run-history.json` fixture shaped like the future history store
        ({passed, at} runs; `at` ignored). No runtime deps yet.
  - [x] **Slice 2 — `HistoryStore`.** The private better-sqlite3 run-history DB (append-only
        `test_run` + `flake_meta`); `recordRun`/`recordRuns`, `history`/`histories`
        (`limitPerTest`/`since`), `classify()` straight from the store. better-sqlite3
        ^12.10.0 = flake's first explicit pinned dep.
  - [x] **Slice 3 — `parseVitestJson` + `ingestReport`.** Pure parser of a `vitest run
        --reporter=json` report → RecordedRuns (stable `<relFile> > <ancestorTitles>title`
        ids, skipped/pending/todo dropped), over a committed real-shaped fixture.
  - [x] **Slice 4 — `Quarantine` (operator-gated writes).** Paired gate adapted to this
        surface: `allowQuarantine` + load-bearing `maxExpiryMs` (mandatory expiry, refused
        past the cap, no permanent quarantine). Writes upsert; reads/`release` ungated +
        expiry-aware. Pure `quarantineCandidates` proposes (never `broken`/`reliable`).
  - [x] **Slice 5 — `runAndRecord` (gated vitest runner).** Spawns `vitest run
        --reporter=json` (`repeat` × suite), records, classifies; mirrors coverage's
        runScoped (paired `allowRun`+`allowedRoots` gate, injected TestRunner — no real
        spawn in the gate).
  - [x] **Slice 6 — MCP surface + `strummer-flake-mcp` bin.** Always-on reads
        (`flake_status`/`flake_candidates`/`flake_release`); `flake_run` behind the run gate;
        `flake_quarantine` behind the quarantine gate. Bin requires `STRUMMER_FLAKE_DB` +
        the two independent paired gates.
  - [x] **Python (pytest-json) adapter** — pure `parsePytestJson` (pytest-json-report's
        `tests[]` → `RecordedRun[]`; the `nodeid` is the stable id verbatim — no reconstruction;
        per-phase seconds summed → `durationMs`; `error`→fail, `skipped`/`xfailed`/`xpassed`
        dropped). Store/classifier/quarantine unchanged (test-id-opaque). `HistoryStore.
        ingestPytestReport` + a new always-on, format-discriminated **`flake_ingest`** MCP tool
        (vitest|pytest, no spawn — the suite already ran; the only way to feed pytest history).
  - [x] **`strummer flake` human CLI** — always-on `status`/`candidates`/`ingest`/`release`;
        gated `run` + `quarantine` (the two paired gates as straight-through flags).
- [x] **Mutation testing** (`@strummer/mutate`) — **COMPLETE (engine + agent surface).**
      Are the tests meaningful? **Stryker/Vitest-4 compat spike resolved** (ADR 0010 update
      2026-06-01: vitest-runner 9.x declares `vitest >=2.0.0` + ships Vitest 4/4.1 support —
      thin-wrap viable, no command-runner fallback; Stryker stays an injected, operator-
      spawned runner, NOT a gate dep).
  - [x] **Slice 1 — pure `summarizeMutation`.** Reads the stable mutation-testing-elements
        report schema (no `@stryker-mutator` import); status tally → detected/undetected/
        covered/valid/invalid/total + mutationScore (detected/valid) +
        mutationScoreBasedOnCoveredCode (detected/covered), per-file metrics, and an
        actionable `survivors` list (Survived + NoCoverage). Golden-fixture tested.
  - [x] **Slice 2 — gated `runMutation` + MCP surface.** Spawns `stryker run --reporters
        json`, reads the report, summarizes; paired `allowRun`+`allowedRoots` gate +
        injected `MutationRunner` (no real Stryker in the gate); diff-scoped via
        `mutateFiles`→`--mutate` + `--incremental`. `mutate_summarize` (free) +
        `mutate_run` (gated) MCP tools + `strummer-mutate-mcp` bin.
  - [x] **Python (mutmut) adapter** — pure `parseMutmutResults` maps `mutmut results --all true`
        text (verified against **real mutmut 3.5.0** output; statuses killed/survived/no-tests/
        timeout/suspicious/skipped → mutation-testing-elements `MutantStatus`, never overstating the
        score) into a `MutationReport`, so `summarizeMutation` is reused unchanged. `mutate_summarize`
        gained a `format: stryker|mutmut` discriminator (mutmut input = the results text, no spawn).
  - [x] **`strummer mutate` human CLI** — `summarize` (stryker|mutmut) + gated `run`.
  - [ ] *(staged)* a cosmic-ray adapter; a gated `runMutmut` spawner.
- [x] **LSP bridge** (`@strummer/lsp`) — semantic code navigation. **COMPLETE (engine +
      agent surface), slices 1–5.** Highest *raw*
      leverage but **last**: the documented exception to ARCHITECTURE §1's no-live-RPC
      rule (a live, version-coupled subprocess). **Design DONE — ADR 0011** (3-stream
      research → synthesis → 2 adversarial critics; the adversarial pass reshaped it).
      Locked decisions: the right analogy is the **browser subprocess** (resident,
      code-executing — ADR 0007 container), not the test-runner; paired `allowRun`+
      `allowedRoots` gate (load-bearing *because indexing runs project code*); **operator
      binds a JSON `language→{command,args[]}` registry**, agent picks only a *language*;
      **v1 reads-only**; green gate uses a **fake in-process JSON-RPC peer replaying
      recorded real-server payloads** (no real server in the gate — stricter than the
      other pillars).
  - [x] **Slice 1 — pure `encoding.ts` + `normalize.ts`.** `toLspCharacter`/`fromLspCharacter`
        (utf-8/16/32, non-BMP fixtures + a cross-encoding round-trip — the #1 silent-wrong
        trap), `resolvePositionEncoding` (absent→utf-16, unsupported→throw),
        `toLspPosition`/`fromLspPosition` (LF/CR/CRLF split, no doc normalization, BOM
        strip) + result normalizers (`Location` vs `LocationLink`, `DocumentSymbol` vs
        `SymbolInformation`, hover, tri-state `decideStatus`). No spawn, no network; 31 tests.
  - [x] **Slice 2 — `client.ts`.** Handshake (initialize advertising
        `positionEncodings:["utf-16","utf-8"]` → read back the negotiated encoding +
        `serverInfo` provenance + capabilities; initialized; didOpen full-text once,
        refcounted, no didClose by default), capability-gated requests
        (`LspUnsupportedError`), deadlock-safe inbound `null` replies, tri-state readiness
        gated on `$/progress` inside the single operator deadline (injected clock). The
        injected `serverSpawn` seam (`defaultServerSpawn` = `child_process.spawn`) tested
        against a fake in-process JSON-RPC peer (paired `PassThrough` streams) replaying
        RECORDED `typescript-language-server` 5.3.0 payloads. `vscode-jsonrpc` +
        `vscode-languageserver-protocol` added as explicit pins; 13 tests.
  - [x] **Slice 3 — `registry.ts` + `manager.ts`.** The operator-bound JSON
        `language→{command,args[],initializationOptions?}` registry (command/args
        structurally separate, no DSL; unbound language refused). `LanguageServerManager`
        keyed by (language, projectRoot), shared/lazy spawn via the injected seam, `rootUri`
        pinned to the allowlisted root (refused before spawn), per-(server,uri) chained-promise
        mutex, in-flight-aware reaper that never reaps mid-request with a clock-driven
        shutdown→exit grace before `dispose()`. Shared fake-peer harness factored to
        `src/peer.ts`. 10 + 8 tests.
  - [x] **Slice 4 — gated `query.ts`.** `LspQueryEngine` mirroring `runScoped` — the paired
        deny-by-default gate (`allowRun` + `allowedRoots` + deadline, `LspGateError`/
        `assertAllowed`, never spawns when denied); queried-file confinement to the project
        root (no traversal); human↔LSP position mapping via `toLspPosition`/`fromLspPosition`
        + the negotiated `client.encoding` (result ranges mapped back per target file, `+1`
        fallback when unreadable); tri-state passthrough; `serverInfo` provenance +
        serverInfo-absent `versionWarning`; echoes optional `toolchain` provenance. 10 tests.
        (The warn-on-toolchain-mismatch heuristic reusing `core.detectInstalledVersion` is
        staged to the surface slice, which has the `core` dep.)
  - [x] **Slice 5 — MCP surface + `strummer-lsp-mcp` bin.** `lsp_find_definition`/
        `lsp_find_references`/`lsp_hover` (gated as a group — no free-read tier); always-on
        no-spawn `lsp_languages` (bound languages + live capabilities + server version via
        `manager.describe()`, never commands/paths); large reference lists by handle
        (`strummer://lsp/{id}/{kind}`). Surface is pure wiring over an injected
        `query`+`describeServers`; the bin builds the real manager/engine + reaper/shutdown.
        Env `STRUMMER_LSP_ALLOW_RUN`/`_PROJECT_ROOTS`/`_TIMEOUT_MS`/`_SERVERS`(JSON)/
        `_ARTIFACT_DIR`/`_MAX_SERVERS`/`_IDLE_TTL_MS`; toolchain provenance via
        `core.detectInstalledVersion`. 7 surface + 6 bin tests.
  - [x] **Capability-gated read tails — `lsp_type_definition` / `lsp_document_symbols` /
        `lsp_call_hierarchy`.** `type_definition` reuses `normalizeLocations` (the handshake
        already advertised `typeDefinition` linkSupport); `document_symbols` is position-less and
        reuses the slice-1 `normalizeDocumentSymbols` (the query engine gained a no-position path +
        recursive human-coord range mapping; `line`/`column` now optional, validated per kind);
        `call_hierarchy` is the two-round-trip protocol (`prepareCallHierarchy` → `incoming`/
        `outgoing` calls; new `normalizeCallHierarchyItems`/`normalizeIncoming`/`normalizeOutgoing`;
        keeps ALL prepared overloads; per-direction `fromRanges`-file attribution; the client now
        declares the `callHierarchy` capability so servers advertise it). All gated as part of the
        navigation group; `lsp_languages` already reported their capabilities. Fixtures captured
        from the **same real `typescript-language-server` 5.3.0** (provenance in the fixtures README).
  - [x] **Write-mode — `lsp_rename` (ADR 0011 addendum, slices A–G).** The first WRITE surface,
        designed by the `lsp-write-mode-design` fan-out (adversarial pass folded in). **Dry-run by
        default**; applies to disk only behind a SEPARATE `STRUMMER_LSP_ALLOW_WRITE` gate that is
        enforced to require `allowRun`. Pure `applyTextEdits`/`lspPositionToOffset` (CRLF/BOM/non-BMP-
        faithful, overlap-throwing) + `normalizeWorkspaceEdit` (changes vs documentChanges; resource
        ops flagged + refused); realpath-hardened all-or-nothing confinement of every edited file;
        `client.rename`/`prepareRename` + handshake caps; full-text `didChange` doc-sync (monotonic
        version) + inbound `applyEdit` deadlock guard; single- AND multi-file apply via
        `manager.runWithUris` (sorted multi-URI lock) with stage-then-commit-all + staleness guards +
        SHA-256 audit digests; the `lsp_rename` MCP tool (no `write` input — apply is the engine's
        internal decision) + bin wiring. Real-server fixtures captured out-of-gate (gate replays
        recorded payloads, no real server). The capture flipped a design assumption: tsserver 5.3.0
        returns the legacy `changes` map (not `documentChanges`) and no resource ops on a rename.
  - [x] **`strummer lsp` human CLI** — single-shot `languages`/`definition`/`type-definition`/
        `references`/`hover`/`symbols`/`call-hierarchy` + write-mode `rename` (dry-run unless
        `--allow-write`). The human is the operator (`--allow-run`/`--allow-write` straight-through;
        `--servers` binds the registry, `--project` is the allowlist); the engine is injectable so
        the gate never spawns a real server, and production builds the real manager/engine per
        invocation and shuts it down. Exit 2 = `not_ready` (retry). Ships `examples/lsp/greeter`
        (a tiny TS project mirroring the fixture-capture shape) + an offline coordinate guard.
  - [x] **Cold-project-load fix** — running the greeter example live caught a real bug: tsserver
        answers an early request from a single-file *inferred* project (a non-empty BUT partial
        result) while still loading the configured `tsconfig` project, so a cold cross-file
        `references`/`rename` saw only the opened file. Fixed in `client.ts` `withRetry`: a result
        returned **while indexing is active is untrusted** — wait out the project-load `$/progress`
        (event-driven, injected-`delay` deadline backstop) and re-query the loaded project; traded
        "return `not_ready` fast" for "wait for the correct answer within the deadline". Verified
        live (cold `Greeter` references/rename now return the full cross-file set). New fake-peer
        test replays the captured timeline; no real server in the gate (ADR 0011).
  - [x] **`workspace/symbol` search — `lsp_workspace_symbols`.** Project-wide symbol search by name
        (the first file-less, position-less navigation). Pure `normalizeWorkspaceSymbols` (flat
        `SymbolInformation[]` + the uri-only LSP 3.17 `WorkspaceSymbol` shape — range omitted, never
        crashes) over a recorded real `typescript-language-server` 5.3.0 payload; capability-gated
        `client.workspaceSymbols` (tri-state; advertises the `workspace.symbol` client cap, no
        `resolveSupport`); a `'workspaceSymbol'` query kind (file-less via `runWithUris([])`,
        cross-file ranges mapped per target file); the gated `lsp_workspace_symbols` MCP tool (large
        lists by handle) + `strummer lsp workspace-symbols <language> <query> [anchorFile]` CLI.
        An OPTIONAL anchor `file` opens a document so a tsserver-style project loads (a "No Project"
        bug caught running the greeter live; eager indexers don't need it). Verified live.
  - [x] **`diagnostics` — `lsp_diagnostics` (PUSH model).** Errors/warnings for a file.
        `textDocument/publishDiagnostics` is a server NOTIFICATION, not a request (tsserver advertises
        no `diagnosticProvider`, so pull `textDocument/diagnostic` is staged). Pure
        `normalizeDiagnostics` (severity/tag names, code, source, relatedInformation) over a recorded
        real `typescript-language-server` 5.3.0 publish payload; `client.documentDiagnostics`
        accumulates pushed diagnostics per-uri and — grounded in the captured timeline (publish lands
        ~60ms AFTER the project loads) — waits out the project-load `$/progress` then returns the
        post-settle publish (empty = clean `ok`, never settles/no publish = `not_ready`); a
        `'diagnostics'` query kind (file-based, position-less); the gated `lsp_diagnostics` MCP tool
        (large lists by handle) + `strummer lsp diagnostics <language> <file>` CLI. Verified live
        (clean file → 0; an introduced error → the 2322 error + a 6133 unused hint).
  - [x] **Pull diagnostics — `textDocument/diagnostic` (PULL model).** `documentDiagnostics(uri)`
        now dispatches by capability: PULL (a `textDocument/diagnostic` request) when the server
        advertises `diagnosticProvider` (rust-analyzer), else the existing PUSH model (tsserver
        advertises none). Pull is a deterministic request/response — better for single-shot than
        waiting on an async publish. Capability-gated `client.pullDiagnostics` echoes the provider
        `identifier` (RA requires it), tri-state with the diagnostics rule that an empty `full` report
        is `ok` (clean, never no_result), and maps a soft `ContentModified`-class error to
        backoff-retry → not_ready; `normalize.diagnosticsFromReport` unwraps the full/unchanged
        envelope over the shared `normalizeDiagnostics`. Same result shape as push, so the query
        engine / MCP / CLI are unchanged. Real captured RA `full` report fixtures; fake-peer
        `onDiagnostic`. Verified live against rust-analyzer 0.3.2921 (`strummer lsp diagnostics rust`
        → ok/0 — and since RA does not push in the no-cargo config, `ok` proves the pull path ran).
  - [x] **Multi-root workspaces — `workspaceRoots[]` / `--workspace-root`.** One language server
        bound to MULTIPLE `workspaceFolders` (a monorepo) so cross-root navigation resolves through
        one server. Additive + opt-in (single-root behavior byte-identical). `client.initialize`
        takes `workspaceFolders[]`; the manager keys a server by the sorted, de-duplicated root
        GROUP (`assertRootAllowed`s every member before spawn; `describe()` reports `roots[]`); the
        query engine threads `workspaceRoots[]` (each paired-gated, file confined to the primary
        root); the MCP nav tools gained an optional `workspaceRoots` (nav-only — `lsp_rename`
        excluded) and `strummer lsp` a repeatable `--workspace-root`. Verified live (real tsserver
        accepts the multi-folder init; a query in a non-primary root is served; cross-root
        definition resolves). Honest nuance: cross-root *references* depend on the server's indexing
        model (eager indexers cover all folders; tsserver loads a folder's project lazily on open).
  - [x] **Write-mode multi-root — `lsp_rename` `workspaceRoots[]`.** A cross-root rename in a
        monorepo now applies. The manager already plumbed `workspaceRoots` through `run`/`runWithUris`;
        the new safety work is confining every edited URI to the allowlisted root GROUP (primary ∪
        `workspaceRoots`), realpath-hardened, all-or-nothing (`confineEditedUriToRoots`) — so a
        legitimate edit in a secondary authorized root is written, but one escaping every root aborts
        the whole apply before any byte is touched. `workspaceRoots` is threaded into BOTH the compute
        (`manager.run`) and apply (`manager.runWithUris`) phases so they key the SAME group-server (the
        post-write `didChange` must reach the server the doc was opened on); each member is paired-gated
        before spawn. Exposed on the `lsp_rename` MCP tool + `strummer lsp rename --workspace-root`.
        Verified live (tsserver 5.3.0: a cross-root `Greeter`→`Welcomer` rename applied to disk in BOTH
        roots with per-file digests).
  - [x] **Write-mode resource operations — `CreateFile`/`RenameFile`/`DeleteFile` (ADR-0011 addendum
        2026-06-02).** `lsp_rename` now APPLIES file ops interleaved with text edits (in
        `documentChanges` order), e.g. a module rename that renames its backing file. Designed via an
        adversarial critic pass (B1–B12): `normalizeWorkspaceEdit` gains an ordered `operations` list;
        the apply locks the UNION of every touched URI, confines every URI (both rename endpoints) to
        the root group, replays ops over a virtual content map (CreateFile seeds `''`; the staleness
        guard is scoped to pre-existing files), and stage-then-commits a `PhysicalOp` plan
        (write/rename/delete) — a mid-commit fault is terminal (`partial`, no rollback; reconcile via
        VCS). `client.didFileRename`/`didFileDelete` migrate the open-doc map so a `RenameFile` of an
        open file can't desync the shared server. v1 cuts (staged): non-default resource-op options,
        recursive/dir delete, editing a file also renamed in the same batch. Prerequisite that fell out
        of the live check: the **readiness model now handles servers that signal not-ready via an
        ERROR** (rust-analyzer's `-32602` mid-index) — `withRetry` routes a soft `ResponseError` through
        the tri-state (indexing ⇒ `not_ready`, settled ⇒ `no_result`). The client advertises
        `workspaceEdit.resourceOperations` (else rust-analyzer refuses a module rename). **Provisioned
        rust-analyzer 0.3.2921** (local/untracked; gate stays fixture-only) and verified live: a
        `mod greeter;`→`welcome` rename edited `main.rs` AND renamed `greeter.rs`→`welcome.rs` on disk.
  - [x] **Resource-op SAFE-SUBSET v1 cuts — `ignoreIf*` + edit composed with rename/delete.** Closes
        the non-destructive cuts (operator chose the safe subset; `overwrite`/recursive-delete stay
        staged). `ignoreIfExists` (create/rename) + `ignoreIfNotExists` (delete) are now conditional
        NO-OPS (never more destructive than the default), not blanket-refused (`hasNonDefaultOptions`
        → `hasRefusedOptions`, overwrite/recursive only). Editing a file that is ALSO renamed/deleted
        in the same batch now APPLIES: `applyEdit`'s replay was rewritten onto a per-file `Fate` VFS
        keyed by the ORIGINAL uri so content flows THROUGH a rename — rename(A→B)+edit(B) (import
        fix-up in a moved file) and edit(A)+rename(A→B) both write the edited content to the final
        path in documentChanges order; net-no-op batches (create+delete) drop out. The physical plan
        is one ordered write/rename/delete list with a shared digest index per op (edited-AND-renamed
        = rename+write sharing ONE audit row); resync derives its bytes from what ACTUALLY landed
        (pristine on a partial commit) and migrates the open buffer only when the physical rename
        landed. Genuinely ambiguous/conflicting batches are REFUSED, not silently reconciled: a rename
        cycle, two renames into one target, editing a renamed-away path, and **deleting a path that is
        also a rename/create target** (a data-loss guard). Designed via the
        `lsp-resource-op-safe-cuts-design` fan-out (2 proposals → synthesis → 3 adversarial critics,
        five holes folded in) + a recall-biased review fan-out. Fixture-only gate (no real server);
        TDD A1-A9 + B1-B20. **Verified live against rust-analyzer 0.3.2921**: a module rename applied
        cross-file edits + the `RenameFile`, and the editing-a-renamed-file case (a `crate::greeter::`
        self-reference) applied with the moved file carrying the edited content (the batch the old
        code refused).
  - [x] **Dynamic `didChangeWorkspaceFolders` — grow-only warm-server reuse.** A query whose root
        group is a SUPERSET of a warm same-language server's folders extends that server in place
        (`workspace/didChangeWorkspaceFolders`, sending only the delta) and re-keys it, instead of
        spawning a fresh server and re-paying indexing. `client.supportsWorkspaceFolderChange` (reads
        `workspaceFolders.changeNotifications`) + `client.changeWorkspaceFolders`; `manager.acquire`
        `tryGrowExisting` picks the UNIQUELY-largest subset server (ambiguous tie or no-cap ⇒ spawn
        fresh, never guesses), grow-only (never shrinks a larger server). Safety unchanged (every
        folder allowlist-gated before the grow); write-mode unchanged (rename confinement is the query
        group, independent of server folder state). Gate uses the real RA init fixture (advertises the
        cap) + tsserver (does not). **Verified live vs rust-analyzer 0.3.2921** (superset query grows
        the warm server in place, serverCount stays 1, post-grow query still resolves).
  - [x] **Python adapter — pyright as a third real server.** The LSP engine is language-agnostic, so
        this is NOT engine code: it is gate coverage + an example + docs proving (and documenting) a
        real Python server. The gate replays recorded **`pyright-langserver` 1.1.410** payloads (a
        third real server alongside tsserver + rust-analyzer): an `initialize` with object-form
        provider caps, **no `serverInfo`** (⇒ `versionWarning`), **no `positionEncoding`** (⇒ utf-16),
        and **no `diagnosticProvider`** (⇒ push); a **flat `Location[]`** definition (pyright ignores
        `linkSupport`); a **`documentChanges`+`version:null` multi-file rename** (a REAL payload for the
        branch `rename-documentchanges.json` only synthesized); and a **string-code** push
        `publishDiagnostics`. Ships `examples/lsp/pygreeter` (the Python counterpart of `greeter`:
        `greeter.py`+`main.py`) + an offline coordinate guard. **Verified live across every capability**
        (definition/references/hover/symbols/type-def/call-hierarchy/push-diagnostics + a
        `--allow-write` rename that re-type-checks clean *in this 2-file example*). **Documented
        pyright limitation (capability difference, deep-dived after a follow-up question, no code fix
        yet):** pyright's `references` AND `rename` are scoped to the **open files** — it does not scan
        unopened workspace files, so on a non-trivial project a references/rename from a *declaration*
        misses unopened files (coverage scales linearly with the open set), and **a pyright cross-file
        `rename` can be silently INCOMPLETE** (a 62-file repro renamed only the declaration). An anchor
        file does NOT fix it (unlike `workspace/symbol`, where one anchor establishes the project and
        the server searches its own index); server config (diagnosticMode/indexing) doesn't either. The
        2-file example looks complete only because pyright auto-analyzes the whole tiny workspace.
        Provenance: python has **no** clean single-package toolchain map, so `bin-lsp.ts` deliberately
        maps none (the `versionWarning` is the honest signal). See [[strummer-lsp-pyright]].
  - [x] **Partial-rename completeness guard (`lsp_rename`).** Server-agnostic protection against the
        open-files-scoped data-loss: after computing the edit, the engine extracts the old identifier
        at the queried position and scans the allowlisted root group for same-language files that
        mention it as a whole word but are NOT covered by the edit. The verdict — `complete` /
        `suspect` / `unknown` (scan truncated) — is surfaced in the dry-run preview (with the capped
        `suspectedMissedFiles`), AND a `suspect` verdict **refuses the WRITE deny-by-default**;
        overridable by the operator-only `allowPartialRename` (`STRUMMER_LSP_ALLOW_PARTIAL_RENAME` /
        `--allow-partial-rename`), never a tool input. The guard is inert until a `listFiles` lister
        is wired (cf. `redact`); the bin/CLI/MCP wire the real bounded, skip-list, symlink-safe walker.
        A whole-project-rename server (tsserver/rust-analyzer) covers every use ⇒ `complete` (no false
        block). Verified live: a 60-importer pyright project refuses the partial write (nothing lost),
        the override applies, and complete renames (pygreeter, tsserver greeter) are not flagged.
  - [x] **Destructive resource-op `overwrite`** (ADR 0011 addendum 2026-06-03) — a `CreateFile`/
        `RenameFile` carrying `overwrite:true` truncate-and-replaces an EXISTING regular file behind a
        SEPARATE deny-by-default operator gate (`allowDestructiveResourceOps` / `STRUMMER_LSP_ALLOW_
        DESTRUCTIVE_RESOURCE_OPS` / `--allow-destructive-resource-ops`; self-enforcing ⇒ allowWrite).
        The destroyed bytes are audited (`<path> (overwritten)` digest row, partial-commit-safe) and
        surfaced as `overwritten[]`. Designed via the `lsp-destructive-overwrite-design` fan-out (2
        blockers caught): symlink/dir targets REFUSED (lstat — no clobber-through-link audit lie);
        an overwrite-create kept OUT of `created` so a following delete is still real; queried-file
        drift guard; clobbered-buffer close; a destructive batch escalates the completeness guard
        (`unknown`⇒blocking). Hand-authored INPUT fixtures (no real server emits overwrite in a
        rename flow). Plus a conservative toolchain-mismatch `versionWarning` (toolchain-identity
        servers only — rust-analyzer/gopls; tsserver excluded as a wrapper version).
  - [ ] *(staged, kept refused-by-design / not feasible yet)* recursive / directory delete (the
        least-reversible op — no `rm -rf` from a server payload); the FULL toolchain cross-version
        resolution matrix (server↔toolchain); the residual confine→commit parent-dir-swap TOCTOU
        (documented terminal-partial-but-confined).

## Phase 5 — Cross-pillar verification  *(5a–5f COMPLETE; design = ADR 0013 + Addenda 1–4, Accepted; only the older non-blocking tails remain)*

The Phase-4 pillars each emit a pure, structured verdict that nothing composes. Phase 5 makes
them compose: a captured browser/API run's traffic is validated against the API contract, and
that contract sub-verdict folds with the four Phase-4 signals (deps/coverage/flake/mutate) into
ONE structured verdict an agent requests for a change. Two compose-only / zero-spawn milestones
(ADR 0013 §5–6). Decisive choices the adversarial pass forced: **absence is never a pass**
(missing/no-signal ⇒ `inconclusive`, never `pass`); reading an operator-gated HAR **inherits its
gate** (validating a HAR is NOT free); **no baked-in policy default**; `@strummer/verdict` is a
**pure, type-only-import** package (never pulls a pillar runtime).

- [x] **Milestone 5a — the capture→contract bridge: COMPLETE** (the cross-pillar win; reuses 100%
      of the shipped `validateOpenApiResponse`). Engine (`packages/api/src/har-capture.ts`) + gated
      MCP `validate_capture` (api server) + human `strummer api validate-capture` CLI; verified
      against a REAL Playwright-emitted `content:'attach'` HAR `.zip` fixture.
  - [x] **Slice 1 — `@strummer/artifacts` prefix-qualified, hardened, cross-prefix resolution.**
        On-disk layout moved to `<baseDir>/<prefix>/<id>/<kind>` (prefix INTO the path) so one
        shared `baseDir` is collision-free across pillars and a store **rehydrates a foreign-prefix
        handle it never `put()`** (the cross-pillar read). Hardened: per-segment allowlist (refuses
        `..`/separator/absolute in `put()` AND rehydrate) + realpath-confinement under `baseDir`
        (symlink-escape closed); `<kind>.meta.json` contentType sidecar (legacy/no-sidecar ⇒
        `application/octet-stream` + `contentTypeInferred`). Browser pillar (regression guard) green.
  - [x] **Slice 2 — `harEntriesToFacts`** in `packages/api/src/har-capture.ts`: attach/zip HAR body
        resolution **first** (the only path a real browser HAR emits — `content:'attach'`), inline
        `text` fallback; body JSON-parsed, URL→`pathname`; an attached-but-unresolved body is a hard
        finding, never an empty-body pass. Real Playwright `.zip` fixture; size-bounded `fflate`.
  - [x] **Slice 3 — origin / content-type filter** (PRIMARY, not late): a non-API asset is skipped,
        so the exercised-operations set isn't polluted + no false `missing-operation` flood.
  - [x] **Slice 4 — OpenAPI server-base-path reconciliation** (strip `servers[].url` base before
        `matchPath` so `/api/v1/widgets` matches spec path `/widgets`).
  - [x] **Slice 5 — bridge → existing validator + the exercised-operations spec-walk** (`spec.paths
        × methods`, net-new code, scoped here); **every finding message routed through the operator
        `Redactor`; reference paths use `matched.template`, never `req.path`**.
  - [x] **Slice 6 — `validate_capture` MCP (api server) + CLI**, behind the §3a capture gate
        (`STRUMMER_VERIFY_ALLOW_CAPTURE` + the source artifact gate); a HAR with an unregistered
        cookie/token yields a verdict whose inline + stored bytes contain neither.
- [x] **Milestone 5b — the unified verdict reducer: COMPLETE.** New pure `@strummer/verdict` package (type-only pillar imports; zero runtime pillar deps) + `request_verdict` MCP + `strummer-verify-mcp` bin + `strummer verify` CLI.
  - [x] **Slice 7 — `@strummer/verdict` Severity core + empty-fold = `inconclusive`** (NOT `pass`).
  - [x] **Slice 8 — `fromContractResults`/`fromDiffCoverage`/`fromDependencyAudits` + a real fold**
        (deps `'unknown'` ⇒ `no-signal`, never `low`/`none`; no OSV snapshot ⇒ `inconclusive`).
  - [x] **Slice 9 — `fromFlakeVerdicts`/`fromMutationSummary` no-signal correctness** (mutation
        `survivors[]` drives warn/fail; `mutationScore===null` AND no survivors ⇒ `no-signal`).
  - [x] **Slice 10 — `request_verdict` MCP + `strummer-verify-mcp` bin + `strummer verify` CLI**;
        **no baked-in `failAtOrAbove` default**; v1 bin reads ONLY `STRUMMER_ARTIFACTS_ROOT` +
        `STRUMMER_VERIFY_ALLOW_CAPTURE` (no per-pillar `ALLOW_RUN` env pre-read).
- [x] **GraphQL drift over captured traffic (ADR 0013 §5 tail).** `harEntriesToFacts` resolves the
      **request** body (where the GraphQL `query` lives); `validateCapturedTraffic`'s 2nd arg is the
      discriminated `CaptureContract { openapi?, graphql?: {endpointPath, sdl} }`; a JSON entry matched
      by `endpointPath` or the `{query}` shape routes to the shipped `validateGraphqlOperation` (never
      to the OpenAPI validator). Absence is never a pass: GraphQL-with-no-SDL ⇒ no-signal
      `graphql-sdl-not-supplied`, REST-with-no-OpenAPI ⇒ `no-contract-for-entry`, any `noSignal>0`
      blocks `clean`. Surface: `validate_capture` MCP `graphqlSchema`/`graphqlEndpoint` + CLI
      `--graphql`/`--graphql-endpoint`. Backed by a REAL Playwright `content:'attach'` capture
      (`packages/api/test/fixtures/graphql-capture.har.zip`) consumed by the api/MCP/CLI tests; only
      the response-errors / no-query / operationName edge cases stay hand-authored.
- [x] **Milestone 5c — run-driving / orchestration `verify`: COMPLETE** *(design = ADR 0013 Addendum
      2026-06-04, Accepted; "compose, never widen").* A new `@strummer/verify` runtime package + a sibling
      `verify_change` MCP tool + `strummer verify run` CLI that DRIVE the gated pillars and fold them
      into one `CompositeVerdict` in a single agent call. **First cut runs the pillars unscoped**
      (diff-scoping is 5d); **capture stays consume-only** (live capture is 5e). All TDD red→green;
      every runner/store/validator injected so `pnpm gate` never spawns (no `better-sqlite3`/
      `playwright-core` loaded). Run-driving wired for **coverage / flake / mutate + the consume-only
      contract**; **deps run-wiring is carried to 5d** (its `audit_project` pipeline has no single
      exported runner — deps stays reachable via the deps server's `audit_project` → `request_verdict`).
      Ordered slices:
  - [x] **Slice 1 — `@strummer/verdict` provenance fields (pure, no new statuses).** Red: a
        `PillarVerdict` carrying `skipReason:'gate-not-set'` folds to `inconclusive` (never `pass`);
        a present `errorReason` likewise; a `{coverage:fail, flake:skipReason:'gate-not-set'}` fold
        stays `fail` (a real failure beats absence). Green: add optional `skipReason`/`errorReason` to
        `PillarVerdict`; map skipped/errored to `status:'no-signal'`, not-requested to `'missing'`;
        widen the `inconclusive` predicate to also recognize a present `skipReason`/`errorReason`.
        **`PillarStatus` is UNCHANGED** (exhaustive switches + `failsByPolicy`'s `warn|fail` guard must
        not see a new value).
  - [x] **Slice 2 — `@strummer/verify` scaffold + the gated `orchestrate()` over injected seams.**
        New package (depends on `@strummer/verdict` + engine packages for types/seams; engines
        `external` in tsdown). Red: `orchestrate()` with ALL runners injected as fakes runs the
        requested pillars concurrently (`Promise.allSettled`), maps each native result via the
        existing `from*` adapters, and **never imports a spawn-capable default** (assert the built
        `.mjs` has zero inline `better-sqlite3`/`playwright-core`/`defaultVitestRunner` require).
        Green: the orchestration core + opts/config types + injected `idFactory` (default
        `randomUUID`, test injects a deterministic stub) + injected `redact` callback.
  - [x] **Slice 3 — gate composition: "compose, never widen".** Red: (i) a pillar whose own
        `assertAllowed` denies ⇒ `skipReason:'gate-not-set'`, surfaced, NOT run, sibling pillars still
        run and fold (the §3d test); (ii) deps' absent-fetcher and flake's absent-DB also map to
        `gate-not-set`, not `errored`; (iii) any OTHER runner rejection ⇒ `errorReason` **redacted**
        (a thrown `…/tmp/abc/coverage-final.json` path must not appear in the verdict, inline or
        stored); (iv) NO `orchestrate()` input can set `allowRun`/`allowedRoots`/timeout. Green:
        gate-denial detected via a structural brand on the `*GateError` classes (or bin
        pre-validation) so verify reuses the real gate without `instanceof`-importing spawn code; the
        gate INPUTS come only from operator config.
  - [x] **Slice 4 — `verify_change` MCP tool (deny-by-default registration) + the verdict handle.**
        Red: `verify_change` is registered ONLY when run-driving is enabled (mirroring
        `run_scoped`); input selects pillars + `projectRoot` (operator-auto-allowed) + `failAtOrAbove`
        (no default); output = compact `CompositeVerdict` inline + per-pillar provenance
        (`ran`/`skipped:gate-not-set`/`skipped:not-requested`/`errored`/`no-signal`) + detail by
        `strummer://verify/{id}/{kind}`; the compose-only `request_verdict` is unchanged. Consume-only
        contract sub-verdict folds in behind the EXISTING capture gate (injected `resolveHar` +
        `validateCapturedTraffic`, `source:'capture-from-HAR'`).
  - [x] **Slice 5 — `bin-verify.ts` run-driving entrypoint: the "both required" env gate.** Red: the
        run-driving path requires BOTH `STRUMMER_VERIFY_ENABLE_RUN` AND each pillar's OWN
        `STRUMMER_<PILLAR>_ALLOW_RUN`(+`_PROJECT_ROOTS`/`_TIMEOUT_MS`); with `ENABLE_RUN` unset,
        `verify_change` is not registered; with it set but a pillar's own gate unmet, that pillar is
        `skipped:gate-not-set`. **The compose-only path stays env-identical** — its existing red test
        (`bin-verify` reads no per-pillar `ALLOW_RUN`) keeps passing; only the new entrypoint reads
        them. Green: the run-driving bin wiring (reuses the pillar gate as the single source of truth
        + the separate `ENABLE_RUN` opt-in, no verify-scoped renames, no umbrella).
  - [x] **Slice 6 — `strummer verify run <root>` CLI** (thin human wrapper over `@strummer/verify`;
        gates as straight-through flags `--enable-run` + per-pillar `--allow-*`; runners injectable so
        the suite never spawns). Exit codes `0 pass / 1 fail|warn / 2 inconclusive`; a gate-blocked
        pillar ⇒ `2` (absence, not misconfig). Then STATUS/ROADMAP/memory updates; push at the
        milestone boundary.
- [x] **Milestone 5d — diff-scoping the non-coverage pillars + deps run-wiring: COMPLETE** *(ADR 0013 §5
      + Addendum; 1109 TS + 45 Py green).* A shared changed-set primitive; expose flake's existing `files` input in MCP; a pure
      `changedDependencies(diff, ecosystem)` for deps (npm `package.json` first, PyPI/Gem lockfiles
      staged); mutate already supports `mutateFiles`/`--incremental`. `verify_change` then scopes each
      pillar from one diff. **Also wire deps into the verify run path** (carried from 5c): factor
      `audit_project`'s per-package pipeline (manifest names → detect installed → SSRF-pinned packument
      fetch → OSV snapshot → `auditDependency`) into a reusable runner, then add `rd.deps` to
      `bin-verify` (gated by `STRUMMER_DEPS_ALLOW_NETWORK`, composed under `ENABLE_RUN`) + a `--deps`
      flag to `strummer verify run`. Naturally paired with `changedDependencies` so a PR audits only the
      changed packages. Ordered slices:
  - [x] **Slice 1 — extract `@strummer/diff` (the human-ratified placement fork).** Move coverage's
        pure `parseUnifiedDiff` into a new **zero-dependency** `@strummer/diff` package + add
        `changedFiles(diff)` (all non-deleted touched paths — the scope primitive; includes
        removal-only modifications `parseUnifiedDiff` omits). Coverage re-exports for back-compat +
        consumes via `report.ts` (behavior-preserving; coverage suite is the regression guard). Chosen
        over keeping it in coverage because `@strummer/verify` must RUNTIME-call the parser to scope
        pillars and its source-scanned "imports zero spawn-capable code" invariant forbids a runtime
        import from the engine-listed coverage (re-exports `runScoped`→`child_process`); a pure shared
        package keeps that invariant provable. Mirrors the safety/assert/artifacts extractions.
  - [x] **Slice 2 — `changedDependencies(diff, ecosystem)` in `@strummer/deps`** (pure; npm
        `package.json` dependency-name diff first; PyPI/Gem lockfiles staged) over `@strummer/diff`.
        Block-aware: tracks the open `dependencies`/`devDependencies`/`peerDependencies`/
        `optionalDependencies` block so a changed `version`/`engines.node`/`packageManager`/`scripts`
        value (which also *looks* like a version) is never mistaken for a dependency. Under-scopes
        (never invents a dep) when a deep dependency's block header is outside the diff context —
        documented; the caller falls back to a whole-project audit.
  - [x] **Slice 3 — `verify_change` scopes the file-scoped pillars from one diff.** When the agent
        supplies a `diff` but no explicit `changedFiles`, derive the set via `@strummer/diff`
        `changedFiles` so coverage (`vitest related`), mutate (`mutateFiles`), and flake (`files`) are
        all scoped from ONE diff (explicit `changedFiles` still wins). Deps scoping is delegated to its
        runner (slice 4), which owns the ecosystem and computes `changedDependencies(ctx.diff, …)`
        itself. flake's `files` is already on its own `flake_run` MCP tool. "Compose, never widen":
        scoping only narrows what runs, never widens the gate.
  - [x] **Slice 4 — factor `audit_project`'s per-package pipeline into a reusable deps runner.**
        `auditProjectDependencies(config)` in `packages/mcp/src/deps.ts` (detect → SSRF-pinned packument
        fetch → OSV snapshot → `auditDependency`, per-package error isolation) → `{audits,
        osvSnapshotLoaded, snapshotDate, errors}` — exactly the `RunDrivingOptions.deps` shape. Optional
        `names` scope (the diff-changed deps; omitted ⇒ all declared manifest deps). `audit_project`
        refactored to consume it (behavior-preserving — its tests are the regression guard).
  - [x] **Slice 5 — `bin-verify` `rd.deps`** gated by `STRUMMER_DEPS_ALLOW_NETWORK` composed under
        `ENABLE_RUN` (compose, never widen). Deps' OWN gate is NETWORK (it fetches packuments, never
        runs project code), so the runner is wired iff `ENABLE_RUN` AND `STRUMMER_DEPS_ALLOW_NETWORK`.
        Factored a shared `depsNetworkConfig(env)` in `bin-deps` (the SSRF-pinned fetcher + OSV dir,
        single source — both bins use it). The deps runner scopes the audit to
        `changedDependencies(ctx.diff)`; no changed deps ⇒ whole-project fallback.
  - [x] **Slice 6 — `--deps` flag on `strummer verify run`.** Drives the deps pillar over
        `auditProjectScoped` (factored into `cli/deps.ts`, mirroring the MCP runner) + folds it. deps'
        gate is NETWORK not spawn (a packument fetch), so `--deps` needs NO `--allow-run`; a `--diff`
        scopes the audit to `changedDependencies`. The fetcher is the same SSRF-pinned
        `makeFetcher(registriesFrom(values))` the `strummer deps` CLI uses (`--osv-db`/`--registry`/
        `--allow-private`); the runner is injectable so the suite never fetches.
- [x] **Milestone 5e — `verify` driving a LIVE capture to *produce* the HAR (browser-spawn): COMPLETE** (1122 TS + 45 Py green)
      *(design = ADR 0013 Addendum 3, forged via the `verify-live-capture-design` fan-out — 5 research
      streams → synthesis → 3 adversarial critics, all `sound-with-fixes`; human-ratified forks).* Turns
      the consume-only bridge into a verify-DRIVEN one: one gated call drives a browser flow → captures
      the HAR → validates it against the contract. **Browser-spawn ONLY** (API-runner staged to 5f);
      `@strummer/verify` core untouched (the injected contract-runner seam is opaque to consume-vs-produce);
      all new code in `packages/mcp`. The critics' load-bearing correction: **gate on FLOW COMPLETENESS,
      not HAR emptiness** (`runFlow` swallows step errors → a partial HAR could validate to a PASS;
      `driveBrowserFlowToHar` throws if `flow.passed===false` or any step `ok:false`). Egress safety via a
      single-source `buildBrowserRuntimeFromEnv()` (proxy started + hardening args + gate installed) +
      `proxy.stop()` in `finally`; gate model "both required, no new env"; one union redactor at both
      `finalizeHar` and `validateCapturedTraffic`; verify-prefix HAR handle; lazy `@strummer/browser`
      import. Ordered slices:
  - [x] **Slice 1 — brand the browser `GateError`** (`Symbol.for('strummer.gate-denial')`; consistency
        nicety for the pre-`runFlow` `checkNavigation` path).
  - [x] **Slice 2 — `ContractCaptureContext` → `mode:'consume'|'produce'` discriminated union** (surface
        types) + handler normalization; re-run the `orchestrate.test.ts` import-scan (core invariant).
  - [x] **Slice 3 — extract `buildBrowserRuntimeFromEnv()`** from `bin-browser.ts` (manager+gate+proxy
        STARTED+hardening args+redactor), single-source; `bin-browser` refactored to consume it.
  - [x] **Slice 4 — `driveBrowserFlowToHar` + the FLOW-COMPLETENESS guard** (injected runtime; flow by
        NAME; STORED verify-prefix redacted artifact; incomplete flow ⇒ throw ⇒ inconclusive;
        `proxy.stop()` in `finally`; lazy import).
  - [x] **Slice 5 — union redactor + the attach-body redaction test** (Fork 2: registered secret in an
        attach-mode response body must not survive; widen `finalizeHar` by `mimeType` iff it leaks).
  - [x] **Slice 6 — `bin-verify` produce-branch wiring** behind the full gate (env-matrix tests).
  - [x] **Slice 7 — `verify_change` MCP input** (`contract:{flow,vars}`) + surface the verify HAR handle.
  - [x] **Slice 8 — `strummer verify run --flow <name>` CLI** + the milestone tail (notes + push).
- [x] **Milestone 5f — `verify` driving the @strummer/api RUNNER to *produce* the HAR: COMPLETE** (1160 TS
      + 45 Py green; design = ADR 0013 Addendum 4, the `verify-api-capture-5f-design` fan-out → human
      ratified 2 forks). The SECOND produce source (after 5e's browser-spawn): a single gated call drives
      the api runner for an operator-authored request (by NAME), SYNTHESIZES a HAR, and validates it via the
      shipped `validateCapturedTraffic` — REST + GraphQL parity. Closes Addendum 3's 3 gaps: per-hop HAR
      entries in the redirect loop, the real request body as `postData`, and a `finalizeHar`-style
      blanket-redaction pass extracted to `@strummer/api` `har-synth.ts` (shared so browser's `finalizeHar`
      delegates to it). 9 TDD slices: `redactHarZip`/`summarizeHar` extract → browser delegation →
      `synthesizeRedactedHarZip` → runner `runRequestForHar`/`runSequenceForHar` out-of-band channel →
      `runRequestToHar`/`runSequenceToHar` driver + transport guards (throw ⇒ inconclusive) →
      **`@strummer/verdict` `fromCaptureVerdict`** (the ratified deeper fix: `clean===false` ⇒ inconclusive,
      closing a CONFIRMED latent absence-as-pass hole in the shipped 5e produce + consume paths) →
      `verify_change` `produce-api` variant → `bin-verify` branch behind the api gate +
      `STRUMMER_API_COLLECTIONS_DIR` → `strummer verify run --request`. Invariants held (compose-never-widen,
      absence-never-a-pass, redaction before the verdict, no real fetch in `pnpm gate`, core `.mjs`
      untouched).
- [x] **Tail — extract the shared `Severity` scale into `@strummer/severity`: COMPLETE** (1164 TS + 45 Py
      green; behavior-preserving). A new pure ZERO-dependency leaf (mirrors `@strummer/diff`/`assert`/
      `artifacts`) owning the qualitative vocabulary: `QualitativeSeverity` ('critical'|'high'|'moderate'|
      'low') + `QUALITATIVE_RANK` (the single source of truth) + the verdict scale `Severity` (=
      `QualitativeSeverity | 'none'`) + `SEVERITY_RANK` (derived from `QUALITATIVE_RANK`, never re-typed) +
      `maxSeverity`/`atLeast`. `@strummer/verdict`'s `severity.ts` is now a thin re-export shim (public
      surface + internal `./severity.js` imports unchanged); `@strummer/deps` builds `SeverityBucket` (=
      `QualitativeSeverity | 'unknown'`) + `BUCKET_RANK` (= `{...QUALITATIVE_RANK, unknown:0}`) on the same
      base, and `audit.ts` now imports `BUCKET_RANK` from `osv.ts` (killed the byte-identical duplicate rank
      map). **The load-bearing `none` ≠ `unknown` distinction is preserved** — deps' `'unknown'` stays a
      separate member that maps to a `no-signal` pillar, never to `none`/`low` (absence-is-never-a-pass).
      verdict gains one runtime workspace import (the pure leaf), dragging in no heavy deps. New
      `@strummer/severity` alias in `vitest.config.ts`; runtime dep of verdict + deps.
- [x] **Request-body & parameter contract validation: COMPLETE (v1)** (1202 TS + 45 Py green; design =
      ADR 0014, the `request-contract-validation-design` fan-out → all 4 forks human-ratified). The contract
      pillar now validates the REQUEST half of an exchange. New `validateOpenApiRequest` SIBLING (placement
      fork: not a unified `validateOpenApiExchange`), reusing slice-0 shared helpers (`resolveOpenApiOperation`
      / `normalizeOpenApiSchema`) lifted out of the response validator so body+param schemas get the same 3.0
      `nullable` shim + local/external-local-file `$ref` deref. v1 scope (scalars only): requestBody JSON
      schema + required presence, scalar path/query/header params (default serializations) with strict
      whole-string coercion, media-type-aware body selection, local `$ref` deref, undocumented-query-param.
      Threaded into the capture→contract bridge (driving request validation per entry, NON-authoritative) +
      the verdict via the **`unverified`→`noSignal` fold** (the load-bearing absence-is-never-a-pass fix a
      critic proved: a present-but-uncheckable body / uncapturable required param can't ride to a pass) +
      direct MCP `validate_request` / CLI `api validate-request` (authoritative; GraphQL-envelope refused).
      Fork-1: `pushResult` redacts finding `path` too (request bodies/params are secret-bearing). Verdict
      shape UNCHANGED (compose-never-widen).
- [x] **Live `api run --openapi` request validation: COMPLETE** (1207 TS + 45 Py green; closes the ONE
      surface ADR 0014 staged). A new out-of-band channel **`runRequestForContract`** → `{ result, capture:
      { request: RequestFacts, registeredSecrets } }` (sibling of `runRequestForHar`, populated at PREPARE time
      so it works on a withheld dry-run; `RunResult` byte-identical) surfaces the un-redacted request facts
      WITHOUT widening the agent-facing result. CLI `api run --openapi` drives `validateOpenApiRequest`
      (authoritative) alongside the existing response check, redacts findings (message+path) via a `Redactor`
      rebuilt from `registeredSecrets`, folds request-contract validity into the exit code, surfaces
      `requestContract`. A present non-JSON/binary body routes to the validator's presence-only `unverified`
      path (never a false `missing-required-body`); a GraphQL envelope skips OpenAPI request validation.
      Ratified forks: validate even on a dry-run (request known at prepare time; exit code unchanged); CLI-only
      (MCP `run_request` keeps run/validate as separate tools).
- [x] **GraphQL-request variable validation: COMPLETE** (1228 TS + 45 Py green; design = ADR 0015, a design
      fan-out → synthesis → adversarial critic). The contract-pillar deepening: `validateGraphqlOperation`
      (EXTENDED, not a sibling — fork 1) validates the runtime `variables` against the operation's declared
      types via a per-variable `getVariableValues(schema, [varDef], vars)` loop (structural attribution →
      findings reconstructed from variable name + printed type + category, never from graphql-js messages,
      which echo values). Returns `GraphqlValidationResult extends ContractResult { unverified? }` (additive
      subtype). Authority model + `unverified`-skip (custom-scalar-typed vars via a `typeFromAST` transitive
      walk, non-object `variables`, multi-op ambiguity) mirror ADR 0014. Full-parity surfaces (fork 2): engine
      + capture→contract bridge (`graphqlOperationOf` extracts `variables`; `unverified → noSignal` fold) +
      MCP `validate_response.variables` + CLI `api validate --graphql --variables` + live `api run --graphql
      <schema>` (the symmetric parallel to `api run --openapi`). New finding kinds `graphql-variable-missing`/
      `-invalid` (error) + `graphql-undocumented-variable` (warning).
- [x] **Artifact retention / GC (ADR 0017)** — the shared `@strummer/artifacts` store was append-only;
      a long-running server grew its dir without bound. Added an opt-in `RetentionPolicy`
      (`maxAgeMs`/`maxEntries`/`maxBytes`) applied by a disk-based `sweep()` scoped to the store's own
      `<baseDir>/<prefix>` subtree (never a foreign pillar), oldest-first by mtime, confinement-checked
      before every delete; triggered opportunistically + throttled on `put()` (injected clock) plus a public
      `sweep()`. No policy ⇒ no GC (backward-compatible). Wired into every long-running server bin
      (`bin-browser`/`bin-deps`/`bin-lsp`/`bin-verify`) via `STRUMMER_<PILLAR>_ARTIFACT_MAX_AGE_MS`/
      `_MAX_ENTRIES`/`_MAX_BYTES`. *(Staged: a global cross-prefix cap; LRU-by-access / refcounting — we
      evict by write-age, not last-read.)*
- [ ] *(staged, not amputated)* the older tails: non-scalar/advanced OpenAPI parameter serializations (deepObject/pipeDelimited/CSV/
      explode arrays, object-valued, content-typed, cookie params) + `label`/`matrix`/multi-param path
      templates + non-local `$ref`; GraphQL directive-argument validation + custom-scalar
      variable coercers; the Python second half (pytest / coverage.py / pyright capture); `changedDependencies`
      for PyPI/Gem lockfiles; deps `changelog_diff` for PyPI/RubyGems; a mutate cosmic-ray/`runMutmut` adapter;
      LSP recursive/dir delete + the full toolchain cross-version matrix.

## Ongoing

- [ ] Distribution: Homebrew tap; single-binary CLI for macOS.
- [ ] Project documentation site.
- [x] CI mirroring the local green gate (`.github/workflows/ci.yml`).
