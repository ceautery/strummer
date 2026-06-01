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

## Phase 3 — Browser / UI testing pillar  *(design locked: ADR 0006 + ARCHITECTURE §10)*

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
      timeouts, `closeSession`/`shutdown`. (Session wall-clock cap + max-pages
      land with the step tools.)
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
- [ ] **Deny-by-default action gate** — reads free; navigation/mutation/download/
      upload/dialog-accept/auth gated by operator unlock + allowlist;
      interception-based `dry_run` mutation preview.
- [ ] **Tier-1 route allowlist** — `browserContext.route` deny-by-default +
      private/link-local/metadata literal block; `serviceWorkers:'block'`; dialog
      auto-dismiss.
- [ ] **Tier-2 loopback DNS-pinning SSRF proxy** reusing the shared range
      classifier; redirect re-check. **Factor `@strummer/safety`** (SSRF +
      redaction) shared by `api` + `browser`.
- [ ] **Secret boundary** — `{{secret:NAME}}` fill resolution + origin-scoped
      `httpCredentials`; redaction over console/network/HAR/trace/storageState
      before any write; `storageState` by handle only.
- [ ] **Artifact capture pipeline** — trace.zip (screenshots+snapshots+sources),
      own console/network logs, screenshots — all by
      `strummer://browser/run/<id>/<kind>` handle with structured summaries;
      capture-level operator gating (`STRUMMER_BROWSER_ARTIFACTS`).
- [ ] **`browser_trace_query`** — wraps `npx playwright trace` subcommands
      (`open`/`actions`/`action`/`snapshot`/`close`) + direct trace.zip JSON-lines
      parser fallback. (Console/network/errors come from within actions/snapshot,
      not dedicated subcommands.)
- [ ] **Browser assertions** — reuse + extend the `@strummer/api` engine
      (text/element-visible/value/url/ariaSnapshot) with auto-waiting; one
      assertion engine across pillars.
- [ ] **Perf-audit tool** — Lighthouse 13.3.0 node API over CDP; scores +
      core-metrics summary, full LHR JSON+HTML by handle; assert
      shape/thresholds, never exact scores.
- [ ] **Network heavy mode** — `recordHar content:'attach' .zip` (or
      `tracing.startHar`) behind operator unlock; HAR replay/mocking via
      `page.route` for offline determinism.
- [ ] **Downloads quarantine** dir + saveAs path validation; uploads confined to
      an operator upload-allowlist dir; download/upload as gated structured events.
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
- [ ] **`.bru` + sidecar persistence** for replayable browser step flows
      (semantic locators, not persisted refs) — mirrors ADR 0004.
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
