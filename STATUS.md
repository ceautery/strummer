# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**Phase 0 — Design & Scaffold** (in progress)

## Where we are

- Project decided: name **Strummer**, polyglot core (TS MCP+CLI / Python docs
  ingestion), headless MCP+CLI surface, **docs pillar first**.
- Repo initialized on `main`, remote wired to `ceautery/strummer` (nothing
  pushed yet).
- Durable docs written: `README.md`, `CLAUDE.md`, `ROADMAP.md`, this file, and
  ADR `docs/decisions/0001-foundational-choices.md`.
- A **design-research workflow** (6 parallel streams + synthesis) is grounding
  the exact stack/versions; `ARCHITECTURE.md` will be authored from its results.

## Next action

1. Consume the design-research synthesis → write `ARCHITECTURE.md` (exact stack,
   versions, SQLite contract schema, MCP tool shapes).
2. Scaffold the pnpm workspace (`core`/`mcp`/`cli`) + Python `ingest` package.
3. Land one trivial red→green test per language + the top-level green gate.
4. First milestone push to GitHub.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this file (current phase + next action).
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (why).
4. Skim project memories and `git log --oneline -15`.
5. Continue from **Next action** above.

## Known open questions

- Exact stack versions — pending design-research synthesis.
- npm publishing: scope packages under `@strummer/*` (bare `strummer` is taken
  on npm). Confirmed name is fine for repo + Homebrew tap.
