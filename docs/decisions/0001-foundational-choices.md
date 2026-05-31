# ADR 0001 — Foundational choices

- **Status:** Accepted
- **Date:** 2026-05-31

## Context

Greenfield project "Strummer": an LLM-agent-first developer testing toolkit
covering documentation/idioms, web API testing, and browser/UI testing. Target
platform is macOS; development happens in a Linux dev container. The dev was
asked to pick technologies.

## Decisions

### 1. Name: **Strummer** (kept)

The bare `strummer` npm name is taken by a dormant structural-matching library
(Tabcorp, last publish ~6y ago), and several guitar "Strum/Strummer" VST
plugins exist. None collide with a developer-tooling product, and the
`ceautery/strummer` GitHub repo is clear. **Mitigation:** publish npm packages
under the `@strummer/*` scope; distribute the CLI as `strummer` via a Homebrew
tap.

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
