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

## Phase 1 — Docs / idioms pillar  *(functionally complete)*

Goal: an agent can ask "the current idiomatic way to do X in library Y at the
installed version Z" and get a precise, cited answer over MCP.

- [x] **Polyglot boundary proof:** Python writes a SQLite index; TS reads it
      back end-to-end (smallest possible red→green step).
- [x] SQLite index schema (FTS5 + vec0; title/body/symbol/library/version).
- [x] MCP tools: `search_docs`, `get_doc` + `strummer://doc/{id}` resource
      (structured, resource-link output; SDK 1.29).
- [x] Python ingestion pipeline: HTML → clean fragments → FTS5 + vectors.
- [x] First real source adapter (**DevDocs**) against **React 19.2** — a
      1,279-fragment index built and served over MCP. (Dash adapter: later.)
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

## Phase 2 — API testing pillar  *(in progress; design = ADR 0004)*

- [x] `@strummer/api` package + Bruno `.bru` format (via `@usebruno/lang`) +
      thin domain model; Strummer assertions/captures in `*.strummer.yml` sidecar.
- [x] Declarative assertion engine (status/header/jsonpath; ajv/responseTime
      next) + undici runner + resource-handle artifacts. First slice green.
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

## Phase 3 — Browser / UI testing pillar

- [ ] Playwright orchestration exposed over MCP.
- [ ] Traces, screenshots, console & network capture as agent-readable
      artifacts (by handle).
- [ ] Visual regression / perceptual screenshot diffing (aspirational).
- [ ] Accessibility (axe-core) & performance (Lighthouse) audits (aspirational).

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
