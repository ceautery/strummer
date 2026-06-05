# ARCHITECTURE

Authoritative technical design. Distilled from the design-research workflow
(raw findings archived in `docs/research/2026-05-31-design-research.md`). When
this disagrees with that archive, this file wins.

## 1. Shape

Sackville is a **headless MCP server + CLI**, agent-first. Capabilities are MCP
tools/resources with structured, token-efficient output; large artifacts are
returned by **handle/resource link**, never inlined.

**Polyglot core, file-based boundary.** TypeScript serves; Python ingests; they
meet only at a SQLite file on disk and the schema that defines it. No live RPC.

```
sackville/
  pnpm-workspace.yaml
  package.json                 # private root; scripts; packageManager pnpm@11.4.0
  biome.json                   # lint + format (TS)
  tsconfig.base.json
  packages/
    core/                      # TS domain logic; THE ONLY package that opens SQLite
      src/{db,search,schema,types}.ts
    mcp/                       # thin MCP stdio adapter over core
      src/server.ts
    cli/                       # thin CLI adapter over core (shebang bin)
      src/index.ts
  py/
    sackville_ingest/           # uv-managed Python package; console_scripts CLI
      pyproject.toml
      src/sackville_ingest/{cli,sources,extract,chunk,embed,db}.py
  schema/
    sackville.schema.sql        # THE CONTRACT — single source of truth DDL
    sackville.schema.json       # machine-readable: schema_version, embed_dim, embed_model
  fixtures/                    # tiny committed fixtures + golden .sqlite for tests
```

**Invariant:** only `packages/core` touches SQLite. `mcp` and `cli` depend on
`core` via `workspace:*` and stay thin. Both languages read
`schema/sackville.schema.json` and **refuse to operate on a DB whose
`sackville_meta.schema_version` doesn't match** — that is what makes
file-as-contract safe.

## 2. Stack & versions (current as of 2026-05-31)

**TypeScript (Node 22 LTS):**
- pnpm 11.4.0 · Biome 2.4.x (lint+format, replaces ESLint+Prettier) · Vitest 4.1.x
  + @vitest/coverage-v8 (use `test.projects`, not the deprecated `workspace`)
- tsdown 0.20.x (ESM + d.ts; CLI emits a shebang bin)
- **better-sqlite3** (current major) — chosen over `node:sqlite` because loading
  the `sqlite-vec` extension needs Node ≥23.5 with `node:sqlite`; we're on 22.
  Allowlist it in pnpm `onlyBuiltDependencies`.
- **sqlite-vec** 0.1.x — `sqliteVec.load(db)`
- **@modelcontextprotocol/sdk** 1.29.x — v1 subpath imports (`McpServer`,
  `StdioServerTransport`). v2 (split server/client) expected Q1 2026; keep the
  MCP layer thin so a port is contained. Zod 3.25/4.0 peer dep.
- **@huggingface/transformers** (transformers.js) — the server embeds queries
  with `Xenova/bge-small-en-v1.5` (CLS pooling + normalize), which reproduces the
  Python-`fastembed` document vectors exactly (verified cosine 1.0). Keeps the
  server a self-contained Node process — no Python at serve time (ADR 0003).

**Python (uv-managed, target 3.12):**
- uv 0.11.x (project + lockfile + interpreter pin) · Ruff 0.15.x (lint+format)
- trafilatura 2.0.x (main-content extraction, `favor_recall` for docs)
- selectolax 0.4.x (LexborHTMLParser — preserves code blocks/anchors)
- sqlite-vec 0.1.9 (PyPI) · stdlib sqlite3 (FTS5 built in)
- **fastembed** with **bge-small-en-v1.5** (ONNX, contextual, **384-dim**) as the
  embedder (decided — see §7.1). Local/offline after a one-time model download.
- **uv-managed CPython 3.12**, not the distro Python — its `sqlite3` must allow
  `enable_load_extension` to create the `vec0` table (Debian's build often does
  not; this is the macOS/Linux extension-loading footgun).

**Footgun (the #1 macOS risk):** SQLite extension loading. better-sqlite3 bundles
its own SQLite; the Python side must run on an interpreter whose `sqlite3` allows
`enable_load_extension` (Homebrew/python.org, not all distro builds). Both sides
assert `sqlite-vec` loads at startup.

## 3. The contract — SQLite schema

`schema/sackville.schema.sql` (Python writes, TS reads read-only). Highlights:

- `sackville_meta(key,value)` — seeded with `schema_version`, `embed_model`,
  `embed_dim`, `built_at`, `builder_version`. Both sides assert compatibility.
- `docs(id, library, version, title, symbol, type, heading_path, url,
  attribution, body)` — canonical fragments; `version` is the pinned doc release.
- `docs_fts` — FTS5 **external-content** over `docs` (no body duplication),
  `tokenize='porter unicode61'`, `prefix='2 3'`, kept in sync by triggers.
- `docs_vec` — `vec0` virtual table, `embedding float[384] distance_metric=cosine`,
  with `library/version/type` as KNN-pushdown filter columns.

**Tested invariants on both sides:** `sackville_meta.embed_dim` == the `float[N]`
in the vec0 DDL; `docs.id == docs_fts.rowid == docs_vec.doc_id`; FTS triggers
exist; shipped DB is checkpointed (`wal_checkpoint(TRUNCATE)`) + `VACUUM`ed into
a single clean file opened read-only by TS.

## 4. MCP tools (token economy)

Two tools. Search returns **compact metadata + resource links only** — full
bodies are fetched on demand. (Claude Code warns >10k tokens, caps at 25k,
persists oversized output to disk.) Always emit `structuredContent` **and** a
matching JSON text block (some clients break on structuredContent alone).

- `sackville.search_docs` — in: `query`, optional `library`/`version`/`type`,
  `limit` (default 8, max 25), `cursor`. Hybrid **RRF** (FTS5 `bm25` + vec0 KNN),
  version filter pushed to **both** halves. Out: `{ results: [{ id, title,
  symbol, type, library, version, score, snippet, resourceUri }], nextCursor? }`
  where `snippet` is a short FTS `snippet()` excerpt and `resourceUri` is
  `sackville://doc/{id}`.
- `sackville.get_doc` — in: `id` (or the `sackville://doc/{id}` URI). Out: the full
  fragment incl. `body`, `heading_path`, `url`, `attribution`. The **only** place
  full body text is returned.
- Resource `sackville://doc/{id}` mirrors `get_doc` for link-following.

Server `instructions` (≤2KB): explain search-returns-summaries+links, the
version-pin semantics, and pagination.

## 5. Ingestion pipeline (Python CLI)

`sackville-ingest build --source <docset|devdocs> --in <path> --out X.sqlite
[--library L --version V]`

1. **Acquire/identify** via two adapters behind one interface, normalizing to a
   single record `(library, version, title, symbol, type, url, attribution,
   html)`:
   - *Dash docset* — parse `Info.plist`; probe `sqlite_master` for `searchIndex`
     (canonical, ~99% of community docsets) vs the `ZTOKEN` Core Data join.
     **M1: plain-HTML + `searchIndex` only**; tarix/brotli/Core Data are later.
   - *DevDocs* — ingest prebuilt `index.json` + `db.json`; carry `release` as
     `version`.
2. **Resolve + extract** — resolve relative file / `#anchor` / http paths;
   trafilatura for main content; selectolax to retain code/tables/anchors; split
   shared pages by `#anchor`.
3. **Chunk** by heading/section with overlap; compute `heading_path`.
4. **Type-normalize** Dash's ~76-value enum / DevDocs types onto Sackville's
   taxonomy via a mapping table.
5. **Embed** chunks (model2vec → float32, 512-dim).
6. **Write DB** — apply schema, seed meta, insert `docs` (triggers fill FTS),
   insert vectors; WAL → checkpoint → VACUUM.
7. **Emit** a machine-readable stdout summary (counts, schema_version), logs on
   stderr, meaningful exit codes. Ingestion is resumable/incremental.

**Licensing gate (must-have):** record per-doc `attribution`; respect upstream
licenses (DevDocs excludes Microsoft/Apple/Oracle; Dash licenses are per-folder).
M1 posture is **local-index-only, no redistribution** — see open decision #4.

## 6. The green gate

Run before every commit (wired into root scripts during scaffold):

```
pnpm lint && pnpm test                              # Biome + Vitest, all TS packages
cd py/sackville_ingest && uv run ruff check . \
  && uv run ruff format --check . && uv run pytest  # Ruff + pytest
```

A single `pnpm gate` (or `make gate`) will fan both out. Nothing commits/pushes
unless this is 100% green (per `CLAUDE.md`).

## 7. Open decisions (defaults chosen; veto welcome)

These came out of the research as genuine forks.

1. **Embedding model + dimension — RESOLVED.** **fastembed / bge-small-en-v1.5,
   384-dim.** Contextual, strong on "how-do-I" queries, local/offline after a
   one-time download. `embed_dim=384` and `embed_model="bge-small-en-v1.5"` are
   frozen into the schema; pluggable via `sackville_meta.embed_model`, but a
   dimension change is a migration.
2. **Version-pin fallback.** Decided default: resolve installed semver to the
   nearest **same-major** doc release, record the resolved version in results,
   warn on inexact match, **refuse** (never silently wrong) if no same-major doc
   exists.
3. **First real corpus — RESOLVED.** **React 19** (MIT, excellent versioned
   docs) is the first ingested target — drives the real adapters + licensing
   review. (The boundary proof uses a hand-crafted `react/19.0/useState`
   fixture, so no corpus is needed for the first cycle.)
4. **License posture.** Decided default: **local-index-only for M1**, attribution
   recorded and surfaced; no redistribution of doc bodies.

## 8. First red→green (proves the whole boundary)

1. Author `schema/sackville.schema.sql` + `schema/sackville.schema.json`
   (`{schema_version:1, embed_dim:384, embed_model:"bge-small-en-v1.5"}`).
2. **RED (TS/core):** Vitest opens `fixtures/golden.sqlite`, loads sqlite-vec,
   asserts `schema_version==1`, runs `searchDocs("useState", {library:"react"})`,
   expects one row `{symbol:"useState", version:"19.0"}`. Fails (no fixture/code).
3. **GREEN (Python):** minimal `sackville-ingest` applies the schema, seeds meta,
   inserts one literal `docs` row + one constant 512-dim vector, checkpoints +
   VACUUMs into `fixtures/golden.sqlite`. (No real scraping/embedding yet.)
4. **GREEN (TS):** implement `core.openDb()` + `core.searchDocs()` (FTS branch;
   vec optional) until the test passes.

This single cycle exercises every contract surface — schema file, meta/version
guard, id alignment across `docs`/`docs_fts`/`docs_vec`, sqlite-vec loading on
both runtimes, and the search result shape the MCP tool wraps — before
committing to real adapters, embeddings, or RRF tuning.

---

## 9. Pillar 2 — Web API testing (`@sackville-mcp/api`)

Decisions in ADR 0004; research in `docs/research/2026-05-31-pillar2-api-testing.md`.
All TypeScript — collections are git-friendly files, no Python/SQLite.

```
packages/api/src/
  collection/  # .bru <-> thin domain model (via @usebruno/lang); sidecar *.sackville.yml
  vars/        # layered scope resolver + {{var}} / {{secret:NAME}} interpolation, captures
  runner/      # undici dispatcher: execute request, capture status/headers/body/timing
  assert/      # declarative assertion engine (status/header/jsonpath/schema/responseTime)
  secrets/     # SecretStore (keyring | env) + value Redactor
  script/      # QuickJS-sandboxed pre/post scripts (curated bru/expect API)
  contract/    # OpenAPI 3.1 (ajv-direct, ADR 0005) + GraphQL (graphql-js) validation
  artifacts/   # resource-handle store: sackville://run/<id>/body  (bodies never inlined)
  index.ts
```

- **Format:** Bruno `.bru` (mirror Bruno's on-disk layout) parsed by `@usebruno/lang`
  V2 fns → a thin internal model. Sackville's richer assertions/captures live in a
  sidecar `<request>.sackville.yml` so the `.bru` stays Bruno-compatible.
- **Runner:** `undici` 8 `request()` (control over body consumption + TTFB/full
  timing; proxy/mTLS). Layered var resolution
  `runtime/captured > request > folder > collection > environment`.
- **Assertions (declarative, first-class):** `{ source, op, value }` where source ∈
  `status|statusText|header|body|jsonpath|responseTime|schema`; jsonpath via
  `jsonpath-plus` (eval off), schema via `ajv` 2020-12. Captures write into the
  runtime scope for request chaining.
- **Scripts (opt-in power):** pre/post JS in a QuickJS WASM sandbox.
- **Secrets:** `{{secret:NAME}}` resolved only at the transport boundary;
  `@napi-rs/keyring` with mandatory `SACKVILLE_SECRET_<NAME>` env fallback (Linux/
  CI); values redacted (incl. base64/url encodings) from all returned artifacts.
- **Safety (server-side, deny-by-default):** GET/HEAD/OPTIONS free; mutations
  dry-run unless `allowUnsafe` + host/method allowlist; SSRF range-block;
  post-redirect re-check; no auto-retry for non-idempotent.
- **MCP surface:** `list_requests`, `get_request` (reports required secret *names*,
  not values), `run_request` (structured result + `resource_link` body handle),
  `run_collection`, `validate_response`. CLI mirrors these.

### First red→green slice

Load a request from a `.bru` collection + its sidecar, interpolate `{{baseUrl}}`,
execute against an **in-process** `node:http` server (ephemeral port, no external
network), evaluate declarative assertions (status + jsonpath), and return
`{ status, latencyMs, assertions[], bodyHandle }` with the body behind a
`sackville://run/<id>/body` handle. Secrets, mutation gating, scripts, contract
validation, and MCP/CLI wiring layer on next.

---

## 10. Pillar 3 — Browser / UI testing (`@sackville-mcp/browser`)

Decisions in ADR 0006; research in `docs/research/2026-05-31-pillar3-browser-testing.md`.
All TypeScript, built **thin on stable `playwright-core` 1.60.0** (NOT a wrap of
`@playwright/mcp`, which pins an alpha core and inlines artifacts).

```
packages/browser/src/
  browser/     # browser/context/page lifecycle; one browser/server, ephemeral
               # isolated context per session; idle reaper; concurrency/timeout caps
  snapshot/    # ARIA accessibility-tree capture + serializer (copied from
               # @playwright/mcp, Apache-2.0, attributed); per-snapshot ref-ids,
               # token-capped scoped diffs + full-tree handle
  steps/       # imperative step tools over ref-ids -> semantic locators
               # (navigate/click/fill/select/press/wait_for/snapshot/query/get_*)
  assert/      # browser assertion sources (text/element-visible/value/url/
               # ariaSnapshot) — REUSES @sackville-mcp/api's declarative engine
  safety/      # deny-by-default action gate; interception-based mutation dry-run;
               # Tier-1 route allowlist; Tier-2 loopback DNS-pinning SSRF proxy
  artifacts/   # ON-DISK ArtifactStore: sackville://browser/run/<id>/<kind>
               # {path,contentType,byteSize,sha256}; trace/screenshot/video/HAR/
               # console/network/storageState; redacted before write
  trace/       # browser_trace_query: wraps `npx playwright trace` CLI
               # (open/actions/action/snapshot/close) + JSON-lines parser fallback
  audit/       # a11y (@axe-core/playwright) + perf (lighthouse node API over CDP)
  index.ts

packages/safety/   # NEW shared module: SSRF range classifier (ipaddr.js) +
                   # secret-resolution/redaction boundary, used by api + browser
packages/assert/   # NEW shared module: declarative-assertion operator core
                   # (AssertionOp + applyOp), used by api + browser — one
                   # assertion vocabulary across pillars
```

- **Driving model — ARIA-snapshot-first.** The agent perceives the page as the
  accessibility tree; step tools target per-snapshot **ref-ids** (never persisted —
  refs invalidate as the DOM changes) resolving to semantic auto-waiting locators.
  Each step returns a token-capped snapshot **diff + handle**, never the full tree.
  Vision/coordinate tools ship behind an operator-gated `vision` capability.
- **Artifacts by handle.** trace.zip / video / HAR / console+network logs /
  screenshots / storageState / audit reports → `sackville://browser/run/<id>/<kind>`
  from an on-disk store; tool results carry only structured summaries.
- **Safety (server-side, deny-by-default, operator-set).** Reads free; navigation/
  mutation/download/upload/dialog-accept/auth gated behind operator unlock +
  allowlist with an interception **dry-run** preview. Two-tier SSRF: route
  allowlist (legible, hostname-level) + a loopback **DNS-pinning proxy** that
  closes the rebinding hole `route()` can't see (it lacks the resolved IP) and
  re-checks on redirect. `serviceWorkers:'block'`; container keeps the Chromium
  sandbox (`--no-sandbox` only as an operator-gated fallback). The full
  deployment-hardening posture (sandbox via unprivileged userns, non-root,
  `cap_drop: ALL`, seccomp, read-only FS, WebRTC/QUIC off, egress firewalling) is
  **ADR 0007** — the container/kernel boundary behind this in-process spine.
- **Secrets** resolve at the `locator.fill()` boundary (`{{secret:NAME}}`) /
  origin-scoped `httpCredentials`; every artifact is redacted before any write
  (Playwright does none). `storageState` is password-equivalent (operator path,
  by handle).
- **Audits.** `@axe-core/playwright` 4.11.3 (a11y, free read) + Lighthouse 13.3.0
  over CDP (perf); cheap summaries, full reports by handle; assert
  shape/thresholds, never exact perf scores.
- **Visual regression.** `compareScreenshots` (**pixelmatch** 7.2.0 + **pngjs**
  7.0.0) — a pure pixel diff with a `maxDiffPixelRatio`/`maxDiffPixels` budget +
  pixel-rect masks; stable capture (`animations:'disabled'`/`caret:'hide'`).
  `browser_visual_compare` is operator-gated (`BASELINE_DIR`; baseline writes behind
  `ALLOW_BASELINE_UPDATE`), diff PNG by handle. **Committing** cross-platform
  baselines is deferred — operator-managed, generated in the pinned Docker image
  keyed by (name, browser, platform) — so the engine stays green-gate-deterministic.
- **MCP surface:** snapshot/step tools, `browser_trace_query`, `audit.a11y`,
  `audit.perf`, `validate`-style assertions; CLI mirrors these. Browser binaries
  come from `mcr.microsoft.com/playwright:v1.60.0-noble` (lockstep with the pin).

### First red→green slice

The **a11y-audit summarizer** against an in-process `node:http` fixture (a page
with one `<img>` missing `alt`): launch headless chromium once via
`playwright-core` 1.60.0 → `AxeBuilder({page}).analyze()` → assert `summarize()`
returns `violationCount>=1` + the `image-alt` rule bucketed by impact + the full
Results addressable by a `sackville://browser/run/<id>/a11y` handle. No pixels, no
perf, no network — deterministic and offline. Exercises every seam (launch,
fixture server, audit, token-efficient summary, on-disk handle store) at minimum
size; visual baselines and Lighthouse scores (the flaky parts) come in later
slices.
