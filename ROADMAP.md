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

## Phase 2 — API testing pillar  *(core complete; optional tail remains; design = ADR 0004 + 0005)*

- [x] `@strummer/api` package + Bruno `.bru` format (via `@usebruno/lang`) +
      thin domain model; Strummer assertions/captures in `*.strummer.yml` sidecar.
- [x] Declarative assertion engine (status/statusText/header/jsonpath/responseTime/
      schema) + undici runner + resource-handle artifacts.
- [x] Secrets: `{{secret:NAME}}` + `SecretStore` (`@napi-rs/keyring`/env/static/
      chained), fail-closed, value-redaction (raw + base64/url encodings).
- [x] Mutation safety gate: dry-run by default; send only with `allowUnsafe` +
      host allowlist. (SSRF/redirect re-check still to add.)
- [x] Request chaining via captures (`extractCaptures` + `runSequence`).
- [x] Environment-file loading (`environments/<Env>.bru`, lowest precedence) +
      request **body** sending (json/text/xml/sparql/form-urlencoded). multipart/
      file/graphql bodies still TODO.
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
- [ ] Import: Postman/Insomnia/OpenAPI (`@usebruno/converters`); HAR→`.bru`.
- [ ] Contract validation reach (scheduled, see ADR 0005): external/remote `$ref`
      deref; OpenAPI 3.0 `nullable` shim; `operationName`-scoped GraphQL.

## Phase 3 — Browser / UI testing pillar  *(engine + safety + artifact pipeline + MCP surface + human CLI complete; only the aspirational tail remains; design = ADR 0006 + ARCHITECTURE §10)*

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
- [ ] **Container hardening ADR** — seccomp profile + dropped caps + read-only FS
      + non-root by default; `--no-sandbox` as documented operator-gated fallback;
      disable WebRTC/QUIC in the hardened profile.
- [ ] **Vision/coordinate capability** behind operator-gated `--caps=vision` for
      canvas/non-AX-tree UI (screenshot-pixel click/move), off by default.
- [ ] **Video capture** (webm, retain-on-failure) operator-gated with size caps.
- [ ] **Developer live-view** (observability, not the agent path) — primary:
      headless + `--remote-debugging-port` so a developer can attach DevTools /
      `chrome://inspect` to watch the live session with no extra infra; optional
      operator-gated **headed profile** (Xvfb → x11vnc → noVNC) for in-browser
      watching. Default remains headless; for *reviewing* a run, the trace viewer
      + video are the deterministic, CI-friendly path.
- [ ] **Visual regression** — `toHaveScreenshot` (pixelmatch) default with
      `animations:'disabled'`/`caret:'hide'`/`mask[]`/`maxDiffPixelRatio`;
      baselines generated in the pinned Docker image keyed by (name,browser,
      platform); `odiff` opt-in for large corpora.
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
      `examples/browser/login/`. (An MCP `browser_run_flow` tool is a scheduled
      follow-up — the CLI is the primary surface for replayable/CI flows.)
- [ ] **Multi-engine** (firefox/webkit) install + cross-engine determinism
      (chromium-only for v1).
- [ ] *(aspirational, scheduled not cut)* optional `@playwright/mcp` embed via
      `createConnection()` behind a feature flag for parity testing; autonomous
      self-healing "act"/locator-cache behind a strong operator gate; cross-pillar
      verification tying browser network capture to the API pillar's contract
      validation.

## Phase 4 — Cross-cutting verification tools

Drawn from the brainstorm; sequence TBD by leverage.

- [ ] **LSP bridge** — semantic code navigation (defs/refs/types/call hierarchy).
- [ ] **Coverage-aware, impact-scoped test runner** — run only what a diff
      touches; coverage deltas; uncovered-new-line detection.
- [ ] Mutation testing (are the tests meaningful?).
- [ ] Flaky-test detection & quarantine (protects the green gate).
- [ ] Dependency/version intelligence (deprecations, changelog diffs).

## Ongoing

- [ ] Distribution: Homebrew tap; single-binary CLI for macOS.
- [ ] Project documentation site.
- [x] CI mirroring the local green gate (`.github/workflows/ci.yml`).
