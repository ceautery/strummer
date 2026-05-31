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
- [ ] Milestone push to GitHub.

## Phase 1 — Docs / idioms pillar  *(first vertical slice)*

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
- [ ] `@strummer/cli` thin human entry over `core`.
- [ ] Second source adapter: Dash docsets (plain-HTML + searchIndex).
- [ ] Detect installed versions for non-Node ecosystems (Python, Ruby, …).
- [ ] Ingest existing **Dash** docsets to bootstrap coverage (aspirational).
- [ ] Reuse/ingest **DevDocs** sources where licensing allows (aspirational).
- [ ] Hybrid semantic search via `sqlite-vec` + local embeddings (aspirational).

## Phase 2 — API testing pillar

- [ ] Git-friendly collection format (Bruno-`.bru`-compatible where sensible).
- [ ] Environments & variables; macOS **Keychain**-backed secrets (agent drives
      authenticated requests without seeing raw secrets).
- [ ] Assertion engine; agent-drivable runner; structured run artifacts.
- [ ] Traffic record (HAR) → test/mock generation (aspirational).
- [ ] OpenAPI/GraphQL contract validation & drift detection (aspirational).

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
- [ ] CI mirroring the local green gate.
