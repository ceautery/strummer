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
  `strummer://doc/{id}` resource. License: **Apache-2.0** (ADR 0002).
- **Real React 19.2 ingestion working end to end:** DevDocs adapter (`react`
  slug = 19.2, CC-BY-4.0) → section chunking (`extract`) → type normalization
  (`types_map`) → bge-small embeddings (`embed`) → SQLite (`build`), driven by
  `strummer-ingest build --slug react`. Produced a **1,279-fragment** index
  (`data/react.sqlite`, gitignored/reproducible) and queried it through the MCP
  server. The three leaf modules were built by a **parallel fan-out workflow**.
- Dev container provisions pnpm + uv. **13 TS + 35 Py tests** (1 skipped real
  embed), all green.

## Next action

1. **Hybrid search (highest value):** FTS-only ranking is rough for exact-symbol
   queries (e.g. `useState` doesn't top the results). Add `sqlite-vec` KNN over
   the stored 384-d vectors + **RRF fusion** with bm25 in `core.searchDocs`
   (query embedding via fastembed), surfaced through `search_docs`. TDD.
2. **`@strummer/cli`** — thin human entry over `core` (search/get; later
   `ingest`/`serve`).
3. **Version-pin resolution** — map an installed dependency semver to the doc
   release (nearest-same-major, per ARCHITECTURE §7.2).
4. Ingestion refinements: drop TOC bleed into first sections; richer `symbol`
   extraction.

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
- Version-pin fallback policy (nearest-same-major, warn, refuse-if-none) is a
  documented default in ARCHITECTURE §7.2 — validate against real React docs.
- License chosen for the repo itself: still TBD.
