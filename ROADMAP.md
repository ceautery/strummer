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

## Phase 3 — Browser / UI testing pillar  *(FEATURE-COMPLETE — engine + safety + artifacts + MCP + CLI + multi-engine; live-view dropped per ADR 0008; only the explicitly-aspirational bucket remains; design = ADR 0006/0008/0009 + ARCHITECTURE §10)*

New pure-TS `@strummer/browser`, thin on **stable `playwright-core` 1.60.0** (not
a wrap of `@playwright/mcp`). Design grounded by a 5-stream research workflow with
adversarial verification (`docs/research/2026-05-31-pillar3-browser-testing.md`).
Staged below; aspirational items are scheduled, not cut.

- [ ] **Slice 1 (first red→green):** a11y-audit summarizer + on-disk
      `ArtifactStore` + handle resolution, against an in-process `node:http`
      fixture (no pixels/perf/network).
- [ ] **Scaffold `@strummer/browser`** (Apache-2.0, ESM, tsdown, Biome+Vitest);
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

## Phase 4 — Cross-cutting verification tools  *(UNDERWAY — sequence locked by ADR 0010)*

Sequence decided by the `phase4-design-research` fan-out (5 research streams →
synthesis → 3 adversarial critics → corrected synthesis); see **ADR 0010** for the
ranking, the cross-cutting decisions (shared `@strummer/artifacts` extraction;
explicit pins / no transitive imports; paired deny-by-default operator gate; TS-first
with Python staged), and the per-candidate corrections the adversarial pass forced.
Two independent tracks, then the test-quality chain, then LSP last:

- [ ] **Dependency/version intelligence** (`@strummer/deps`) — *track B, building first.*
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
  - [ ] *(staged)* Python/PyPI + RubyGems advisory adapters.
- [ ] **Coverage-aware, impact-scoped test runner** (`@strummer/coverage`) — *track A, building.*
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
  - [ ] *(staged)* pin `istanbul-lib-coverage` if `CoverageMap` merging/summaries are needed;
        a `strummer coverage` human CLI; Python (coverage.py) adapter.
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
  - [ ] *(staged)* Python (pytest-json) adapter; an optional `strummer flake` human CLI.
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
  - [ ] *(staged)* Python (mutmut / cosmic-ray) adapter; a `strummer mutate` human CLI.
- [ ] **LSP bridge** (`@strummer/lsp`) — semantic code navigation. Highest *raw*
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
  - [ ] **Slice 3 — `manager.ts` + gated `query.ts`.** `LanguageServerManager` keyed by
        (language, projectRoot), per-(server,uri) mutex, in-flight-aware reaper with a
        clock-driven shutdown→exit grace; `LspGateError`, `assertAllowed`, `rootUri`
        pinned to the allowlist; `serverInfo.version` provenance + v1 warn-on-toolchain-
        mismatch (reusing `core.detectInstalledVersion`).
  - [ ] **Slice 4 — MCP surface + `strummer-lsp-mcp` bin.** `lsp_find_definition`/
        `lsp_find_references`/`lsp_hover` (gated as a group); always-on `lsp_languages`
        (reports bound languages + advertised capabilities + server version, never
        commands/paths); large results by handle (`strummer://lsp/{id}/{kind}`). Env
        `STRUMMER_LSP_ALLOW_RUN`/`_PROJECT_ROOTS`/`_TIMEOUT_MS`/`_SERVERS`(JSON)/
        `_ARTIFACT_DIR`.
  - [ ] *(staged, not amputated)* `lsp_type_definition`/`lsp_document_symbols`/
        `lsp_call_hierarchy` (behind per-server capability detection); then write-mode
        (`rename`), `workspace/symbol` search, `diagnostics`, multi-root, full
        toolchain-version resolution, Python adapter posture.

## Ongoing

- [ ] Distribution: Homebrew tap; single-binary CLI for macOS.
- [ ] Project documentation site.
- [x] CI mirroring the local green gate (`.github/workflows/ci.yml`).
