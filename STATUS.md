# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**Phase 1 — Docs / idioms pillar** (in progress). Phase 0 (Design & Scaffold) is
**complete** and the polyglot boundary is **proven end to end**.

## Where we are

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
  `strummer://doc/{id}` resource. Tested via in-memory transport AND a real
  stdio subprocess. License: **Apache-2.0** (ADR 0002).
- Dev container (`docker/`) provisions pnpm + uv. 13 TS + 2 Py tests, all green.

## Next action

1. **Add `@strummer/cli`** — thin human entry over `core` (search/get from the
   terminal; later: `ingest`, `serve`).
2. **Real ingestion (Python):** first source adapter (Dash docset and/or
   DevDocs) against **React 19**; HTML → clean fragments → FTS5; version-pin
   resolution (nearest-same-major, per ARCHITECTURE §7.2).
3. **Hybrid search:** real bge-small embeddings (fastembed) + sqlite-vec KNN +
   RRF fusion in `core.searchDocs`, surfaced through `search_docs`.

## How register/run today

`claude mcp add strummer -- strummer-mcp <index.sqlite>` (see
`packages/mcp/README.md`). Build with `pnpm build`.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this file (current phase + next action).
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (why).
4. Skim project memories and `git log --oneline -15`.
5. Continue from **Next action** above.

## Known open questions

- npm publishing: scope packages under `@strummer/*` (bare `strummer` is taken
  on npm). Name confirmed fine for repo + Homebrew tap.
- Version-pin fallback policy (nearest-same-major, warn, refuse-if-none) is a
  documented default in ARCHITECTURE §7.2 — validate against real React docs.
- License chosen for the repo itself: still TBD.
