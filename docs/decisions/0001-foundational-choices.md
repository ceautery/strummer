# ADR 0001 — Foundational choices

- **Status:** Accepted
- **Date:** 2026-05-31

## Context

Greenfield project "Sackville": an LLM-agent-first developer testing toolkit
covering documentation/idioms, web API testing, and browser/UI testing. Target
platform is macOS; development happens in a Linux dev container. The dev was
asked to pick technologies.

## Decisions

### 1. Name: **Sackville** (renamed from *Strummer*, 2026-06-05)

Originally **Strummer**, but the bare `strummer` npm name was taken by a dormant
structural-matching library (`tabdigital`, last publish 2019) with offshoots
(`strummer-middleware`), forcing an `@strummer/*`-scope-only distribution and
muddying discovery. Picking a common word was the mistake. **Renamed to
`sackville`** (the Sackville-Baggins of *The Lord of the Rings* — apt for a
verification toolkit): the bare `sackville` npm name **and** the `@sackville`
scope are **verified available** (registry 404, no offshoots), and `ceautery`
owns the GitHub org.

**Naming shape** (so the bare name does the most good for an agent-first product):

- The bare **`sackville`** npm package **is the aggregate MCP server**, so client
  onboarding is the clean `npx -y sackville` in `.mcp.json` (its primary bin is
  `sackville`; `sackville-mcp` is an alias; per-pillar bins are `sackville-<pillar>-mcp`).
- The **library graph + the human CLI publish under `@sackville/*`** (`@sackville/core`,
  `@sackville/api`, …, `@sackville/cli` whose bin is `sackville-cli` to avoid colliding
  with the server's bare `sackville` bin).
- Homebrew remains a candidate **secondary** channel for the CLI.

Mechanics of the rename (blast radius, the `SACKVILLE_*` env / `sackville://` URI /
`@sackville/*` scope / `sackville_ingest` Python package) were a single gate-verified
pass; see the project memory + STATUS.

### 2. Stack: **Polyglot core**

TypeScript owns the MCP server, CLI, and (later) the API and browser pillars —
it is the native home of Playwright, the MCP SDK, and the Bruno ecosystem.
Python owns documentation ingestion (scraping, parsing, indexing, embeddings),
where its libraries are strongest.

### 3. Human surface for v1: **Headless MCP server + CLI**

Agent-first is the whole point. A GUI/TUI can be layered over the same core
later without re-architecting; it is not in the v1 surface.

### 4. First vertical slice: **Docs / idioms pillar**

Foundational, lowest external dependency, highest daily value to the agent, and
it immediately exercises the polyglot boundary.

### 5. Polyglot boundary: **a SQLite file, not a live RPC**

Python builds a SQLite index (FTS5 + optional `sqlite-vec` vectors) on disk; the
TypeScript MCP server opens it read-only at query time. No Python process in the
request path.

**Rationale:** each language keeps an independent "always-green" gate; ingestion
is reproducible and cacheable; "pick up where we left off" reduces to "the index
is built or it isn't." If query-time embedding ever becomes necessary, we add a
thin Python index-service then — not now.

## Consequences

- Two toolchains to keep green (Biome/Vitest + Ruff/pytest); accepted cost.
- The SQLite schema is a real interface contract and must be versioned/tested
  from both sides.
- macOS specifics to honor: Homebrew distribution, Keychain-backed secrets for
  the API pillar, `sqlite-vec` arm64 portability.
