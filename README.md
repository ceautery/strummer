# Strummer

[![CI](https://github.com/ceautery/strummer/actions/workflows/ci.yml/badge.svg)](https://github.com/ceautery/strummer/actions/workflows/ci.yml)

**An LLM-agent-first developer testing & verification toolkit.**

Strummer gives a coding agent (Claude Code) the capabilities it struggles with
on its own: knowing the *current, version-pinned* idioms of the languages and
libraries in front of it, and *exercising* the software it writes — across web
APIs and real browsers — then reading the results back in a form it can act on.

Strummer is primarily a **headless [MCP](https://modelcontextprotocol.io)
server**: every capability is exposed as agent-native tools and resources, with
structured, token-efficient output. Humans drive the same core through a CLI.

## The strings

| Pillar | What it does | Prior art it learns from |
| --- | --- | --- |
| **Docs / idioms** | Version-pinned documentation search for the libraries actually installed in a project. | GitBook, DevDocs, Swagger UI, Dash |
| **API testing** | Git-friendly request collections, environments, assertions, and an agent-drivable runner. | Postman, Insomnia, Bruno |
| **Browser / UI testing** | Orchestrated Playwright flows with traces, screenshots, and console/network capture as agent-readable artifacts. | Playwright, Selenium, Cucumber |

Planned cross-cutting verification tools (see [`ROADMAP.md`](./ROADMAP.md)):
semantic code navigation via an LSP bridge, coverage-aware impact-scoped test
runs, visual regression diffing, API contract/schema testing, traffic→test
generation, mutation testing, and flaky-test detection.

## Status

Under active development. The **docs/idioms pillar is complete** (version-pinned
hybrid search over MCP + CLI, multi-ecosystem version detection, DevDocs + Dash
adapters). The **API-testing pillar's core is complete** too — `.bru` runner,
secrets, deny-by-default mutation safety, captures/chaining, QuickJS scripts,
OpenAPI/GraphQL contract validation, and both an MCP tool surface and a
`strummer api …` CLI. The **browser/UI pillar (`@strummer/browser`, on
`playwright-core`) is under active construction** — the engine has the browser
lifecycle manager, ARIA-snapshot capture + imperative step tools, a
deny-by-default action gate, and a two-tier SSRF defense (route allowlist + a
DNS-pinning proxy, sharing `@strummer/safety` with the API pillar); the
artifact-capture pipeline and the MCP/CLI surface come next. **The single source
of truth for "what phase are we on" is [`STATUS.md`](./STATUS.md).**

## Architecture at a glance

- **Polyglot core.** TypeScript owns the MCP server, CLI, the API-testing engine,
  and (later) browser testing. **Python owns documentation ingestion** (scraping,
  parsing, indexing, embeddings).
- **The boundary is a file, not a service.** For docs, Python builds a SQLite
  index (FTS5 + optional `sqlite-vec` vectors) on disk; the TypeScript server
  reads it at query time. No Python process sits in the request path. See
  [`ARCHITECTURE.md`](./ARCHITECTURE.md).
- **Target platform: macOS** (developed inside a Linux dev container).

## Try it (docs pillar)

```bash
# one-time setup
pnpm install && pnpm build          # TypeScript packages
( cd py/strummer_ingest && uv sync )  # Python ingester

# build a version-pinned React docs index (Python ingester)
cd py/strummer_ingest
uv run strummer-ingest build --slug react   --library react --out ../../data/react.sqlite
uv run strummer-ingest build --slug react~18 --library react --out ../../data/react.sqlite --append

# search it from the terminal (hybrid FTS + vector ranking)
cd ../..
export STRUMMER_INDEX=$PWD/data/react.sqlite
node packages/cli/dist/bin.mjs versions react
node packages/cli/dist/bin.mjs search "run code after render" --library react --installed ^18.0.0

# or expose it to an agent over MCP
claude mcp add strummer -- strummer-mcp $STRUMMER_INDEX
```

The CLI (`@strummer/cli`) and MCP server (`@strummer/mcp`) are thin surfaces over
`@strummer/core`; query embedding lives in `@strummer/embed`; ingestion is the
Python `py/strummer_ingest`.

## For contributors / agents

Read [`CLAUDE.md`](./CLAUDE.md) first — it defines how work is done here (TDD,
the always-green gate, milestone discipline, and how to resume cold).

## License

[Apache-2.0](./LICENSE) © 2026 Curtis Autery. See [`NOTICE`](./NOTICE) — indexed
third-party documentation remains under its own upstream license.
