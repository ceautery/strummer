# Sackville

[![CI](https://github.com/ceautery/sackville/actions/workflows/ci.yml/badge.svg)](https://github.com/ceautery/sackville/actions/workflows/ci.yml)

**An LLM-agent-first developer testing & verification toolkit.**

Sackville gives a coding agent (such as Claude Code) the capabilities it is worst
at on its own: knowing the *current, version-pinned* idioms of the libraries
actually installed in a project; *exercising* the software it writes — across web
APIs and real browsers; *navigating* code semantically instead of by text search;
and *verifying* that a change is actually correct, covered, and safe. Every result
comes back in a structured, token-efficient form an agent can act on.

Sackville is primarily a **headless [MCP](https://modelcontextprotocol.io) server**
— every capability is an agent-native tool or resource. Humans drive the same core
through a **CLI** (`sackville-cli`).

> **Status:** alpha. All packages are published to npm at `0.0.1-alpha.4`. The
> single source of truth for "what works today" and "what's next" is
> [`STATUS.md`](./STATUS.md); the design record is the ADR set in
> [`docs/decisions/`](./docs/decisions/).

---

## What's in the box

Sackville is organized as three **pillars** plus a set of **cross-cutting
verification** tools. Each capability is independent — install and enable only
what you need.

| Pillar | What it does | Learns from |
| --- | --- | --- |
| **Docs / idioms** | Version-pinned documentation search for the libraries *actually installed* in a project (hybrid full-text + vector ranking). | DevDocs, Dash, Swagger UI |
| **API testing** | Git-friendly `.bru` request collections, environments, assertions, secrets, an agent-drivable runner, and OpenAPI/GraphQL contract validation. | Postman, Insomnia, Bruno |
| **Browser / UI testing** | Orchestrated Playwright flows with traces, screenshots, HAR, and console/network capture as agent-readable artifacts. | Playwright, Selenium |

| Cross-cutting tool | What it answers |
| --- | --- |
| **`deps`** | Is the *installed* version of this dependency deprecated, vulnerable (OSV/CVSS), or stale? What changed between versions? |
| **`coverage`** | Which lines did this change *add* that no test exercised? (the forgotten-assertion catch) |
| **`flake`** | Is this test flaky, reliable, or broken? (Wilson-scored over run history) |
| **`mutate`** | Are the tests *meaningful* — do they actually catch mutations? |
| **`lsp`** | Where is this symbol defined / referenced? What's its type? Rename it safely. (semantic navigation, not grep) |
| **`verify`** | Fold all of the above into **one change verdict** — and *absence is never a pass*. |

> **New to mutation testing?** The `mutate` pillar deliberately introduces small
> faults into your code — a `<` becomes `<=`, a `true` becomes `false` — and re-runs
> your test suite against each altered copy (a *mutant*). A mutant your tests catch
> is **killed**; one that slips through **survives**, exposing a behavior no test
> actually pins down. Where coverage tells you a line *ran*, mutation testing tells
> you its behavior is *checked* — a green suite full of surviving mutants is
> asserting far less than it appears. It's an old idea (Lipton, 1971) made practical
> only recently by cheaper compute. See **[Mutation testing in Sackville](./docs/mutation-testing.md)**
> for the history and the three engines Sackville drives.

The pillars **compose**: a captured browser/API run's traffic is validated against
the API contract, then folded together with coverage, deps, flake, and mutation
signals into a single verdict. See [ADR 0013](./docs/decisions/0013-cross-pillar-verification.md).

---

## Install & run

Sackville ships as the aggregate MCP server (the unscoped **`sackville-mcp`**
package) plus a library graph and CLI under the **`@sackville-mcp/*`** scope.

### Drive the MCP server from Claude Code

The aggregate server runs straight from npm with `npx` — no local install needed.
The quickest path:

```bash
claude mcp add sackville -- npx -y sackville-mcp
```

Or commit a project-scoped `.mcp.json` so your whole team (and their agents) pick
it up on clone:

```jsonc
{
  "mcpServers": {
    "sackville": {
      "command": "npx",
      "args": ["-y", "sackville-mcp"],
      "env": {
        "SACKVILLE_TOOLSETS": "docs,api,deps,verify",
        "SACKVILLE_INDEX": "/abs/path/to/your-docs.sqlite"
      }
    }
  }
}
```

A bare `npx -y sackville-mcp` is **native-free** and starts with the curated
default toolset — `docs, api, deps, verify` — printing, e.g.:

```
sackville-mcp: enabled [api, deps, verify]; disabled [docs]
```

(`docs` activates once you point `SACKVILLE_INDEX` at a built index; see below.)

### Use the CLI

```bash
# one-off, no install
npx @sackville-mcp/cli search "run code after render" --library react --installed ^18

# or install it
npm i -g @sackville-mcp/cli      # provides the `sackville-cli` command
sackville-cli --help
```

### Heavy pillars are opt-in

The browser, docs, and flake pillars pull native/large dependencies
(`playwright-core`, `better-sqlite3`, the embedding model). They are declared as
**optional peer dependencies**, so a default install stays lightweight. Enable
them by installing the peer and selecting the toolset:

```bash
# example: enable the browser pillar
npm i @sackville-mcp/browser playwright-core
npx playwright install chromium
SACKVILLE_TOOLSETS=api,browser,verify npx -y sackville-mcp
```

---

## Quickstart: the docs pillar end-to-end

The docs pillar is the clearest demonstration of Sackville's polyglot design:
**Python ingests** documentation into a SQLite index; the **TypeScript server/CLI
reads** it. They never talk over a socket — the file *is* the interface.

```bash
# one-time setup
pnpm install && pnpm build               # TypeScript packages
( cd py/sackville_ingest && uv sync )    # Python ingester

# build a version-pinned React docs index (from a DevDocs slug)
cd py/sackville_ingest
uv run sackville-ingest build --slug react   --library react --out ../../data/react.sqlite
uv run sackville-ingest build --slug react~18 --library react --out ../../data/react.sqlite --append

# search it from the terminal (hybrid FTS + vector ranking)
cd ../..
export SACKVILLE_INDEX=$PWD/data/react.sqlite
sackville-cli versions react
sackville-cli search "run code after render" --library react --installed ^18.0.0

# or expose it to an agent over MCP
claude mcp add sackville --env SACKVILLE_INDEX=$SACKVILLE_INDEX -- npx -y sackville-mcp
```

> Tip: `--embedder fake` builds an index instantly and fully offline (no model
> download) — handy for trying things out or for CI. The default `fastembed`
> backend downloads a ~130 MB ONNX model once, then runs locally.

**Index *your own* project's docs, too.** The docs pillar isn't limited to the
public DevDocs catalog. Point `--slug` at any published library you depend on, or
author a small **DevDocs-format pair** (`index.json` + `db.json`) for an internal
library and pass `--index/--db` — then search your *own* APIs the same way. The
[tutorial appendix](./examples/tutorial/todo/README.md#appendix-the-docs-format-and-indexing-your-own-app)
documents the two-file format and how to generate it.

---

## Tutorials: find a bug, fix it, prove it

New to Sackville? Two hands-on, runnable tutorials each ship a tiny app with one
deliberate bug its passing test suite hides. You find and fix the bug **twice** —
first with the CLI, then with Claude Code through the MCP — and each resets with
`./reset.sh`, so you (or a teammate) can run it again.

**1. Start here — [`examples/tutorial/todo/`](./examples/tutorial/todo)** (~15
min). A 64-line TODO-core app with a bug in `filter('active')`. You'll **install
the app's library docs** into a docs index (offline), then find and fix the bug
with the CLI (`sackville-cli search`, `coverage run-scoped`, `verify run`) and
again from Claude Code (`search_docs`, `lsp_*`, `verify_change`), then build the
obvious next feature. Here the bug is an *uncovered* branch — `coverage` catches
it.

```bash
cd examples/tutorial/todo && npm install
# then follow examples/tutorial/todo/README.md
```

**2. When semantic tools earn their keep —
[`examples/tutorial/scheduler/`](./examples/tutorial/scheduler)** (~25 min). A
larger, **multi-file** meeting-room scheduler (`roomctl`) where `grep` and a quick
read stop being enough. The bug is a *single character* — `<` where `<=` belongs —
in an `overlaps()` helper called from three files, so back-to-back bookings are
wrongly rejected. The twist: the buggy line **executes**, so the passing suite
**and** the coverage report both miss it. You reason from the **docs**
(`search_docs` — touching ≠ overlapping), map the helper's blast radius with
**semantic navigation** (`lsp_find_references` across files, no grep noise), then
prove the tests are weak with **mutation testing** (`mutate_run` surfaces a
surviving `<`↔`<=` mutant), fix it, and fold the result into one **`verify_change`**
verdict.

```bash
cd examples/tutorial/scheduler && npm install
# then follow examples/tutorial/scheduler/README.md
```

## Composability

Sackville is deliberately a graph of small packages rather than a monolith.

- **One server, many toolsets.** The aggregate `sackville-mcp` composes every
  enabled pillar onto one stdio process. `SACKVILLE_TOOLSETS` (comma list) selects
  which pillars register; unset means the curated default `docs, api, deps, verify`.
- **Or one process per pillar.** Each pillar also ships its own bin
  (`sackville-docs-mcp`, `sackville-api-mcp`, `sackville-browser-mcp`,
  `sackville-deps-mcp`, `sackville-coverage-mcp`, `sackville-flake-mcp`,
  `sackville-mutate-mcp`, `sackville-lsp-mcp`, `sackville-verify-mcp`) if you'd
  rather isolate a capability.
- **Selection vs. capability are orthogonal.** Choosing to *register* a pillar
  (`SACKVILLE_TOOLSETS`) is separate from *enabling its powers* (its own
  `SACKVILLE_<PILLAR>_*` gates). A registered-but-ungated pillar exposes only its
  read-only tools.
- **Shared cores, no duplication.** SSRF defense + secret redaction
  (`@sackville-mcp/safety`), the assertion engine (`@sackville-mcp/assert`), the
  on-disk artifact store (`@sackville-mcp/artifacts`), the severity scale
  (`@sackville-mcp/severity`), and the diff primitive (`@sackville-mcp/diff`) are
  factored into leaf packages every pillar reuses.

### The safety model: deny-by-default, operator-set

Anything that **runs code, mutates state, or reaches the network** is off until an
**operator** turns it on via environment variables — never via an agent tool input.
An agent cannot self-authorize. A few examples:

| To allow… | The operator sets… |
| --- | --- |
| Sending mutating HTTP requests | `SACKVILLE_API_ALLOW_UNSAFE=1` + `SACKVILLE_API_ALLOWED_HOSTS=…` |
| Running impact-scoped tests | `SACKVILLE_COVERAGE_ALLOW_RUN=1` + `SACKVILLE_COVERAGE_PROJECT_ROOTS=…` |
| LSP navigation / rename | `SACKVILLE_LSP_ALLOW_RUN=1` + `SACKVILLE_LSP_PROJECT_ROOTS=…` (+ `_ALLOW_WRITE` for rename) |
| Resolving a captured HAR | `SACKVILLE_VERIFY_ALLOW_CAPTURE=1` + `SACKVILLE_ARTIFACTS_ROOT=…` |

Gates are **subtractive only** ("compose, never widen"): a higher-level switch
never grants a lower-level capability. Secrets are referenced **by name**; their
values are redacted from every text surface. Large artifacts (doc bodies, traces,
screenshots, reference lists) are returned **by resource handle**
(`sackville://…`), never inlined.

---

## Architecture at a glance — and the *why*

- **Polyglot core.** TypeScript owns the MCP server, CLI, and the API/browser
  engines (the native home of the MCP SDK, Playwright, and the Bruno ecosystem).
  **Python owns documentation ingestion** (scraping, parsing, embeddings), where
  its libraries are strongest.
- **The boundary is a file, not a service.** Python builds a SQLite index; the
  TypeScript server opens it read-only at query time. *Why:* each language keeps
  an independent, always-green test gate; ingestion is reproducible and cacheable;
  and "pick up where we left off" reduces to "the index is built or it isn't."
  See [ADR 0001](./docs/decisions/0001-foundational-choices.md).

### Toolchain choices

| Choice | Why |
| --- | --- |
| **pnpm** (workspaces) | Strict, content-addressed `node_modules` keeps the 19-package graph honest about its dependencies — no phantom imports — and `workspace:*` links are rewritten to real versions only at publish. |
| **Biome** | One fast Rust tool for lint **and** format across all TypeScript, replacing the ESLint + Prettier pair. Faster CI, one config, no plugin drift. |
| **Vitest** (+ v8 coverage) | The native ESM/TypeScript test runner that powers the red→green TDD loop; its coverage output is what the `coverage` pillar consumes. |
| **tsdown** | Emits clean ESM + `.d.ts` (and a shebang CLI bin) per package. Sackville is **ESM-only** by design. |
| **better-sqlite3** | Synchronous, fast, and — unlike Node 22's built-in `node:sqlite` — able to load the `sqlite-vec` extension (which `node:sqlite` only supports on Node ≥ 23.5). |
| **sqlite-vec + FTS5** | Vector KNN *and* full-text search in one embedded file — no vector-DB service to run. Hybrid ranking (RRF) fuses both. |
| **transformers.js** | Lets the Node server embed queries with the *same* model (`bge-small-en-v1.5`) the Python side used for documents (verified cosine 1.0) — so there's **no Python in the serve path**. |
| **uv** (Python) | Fast, reproducible project + lockfile + pinned interpreter. Critically, it provides a CPython whose `sqlite3` allows `enable_load_extension` — the distro-Python build often does not, which is the #1 setup footgun. |
| **Ruff** | One fast Rust tool for Python lint **and** format — the Python mirror of the Biome decision. |
| **fastembed** (ONNX) | Local, offline embeddings after a one-time model download; no embedding API or GPU required. |
| **playwright-core** (pinned) | The browser pillar wraps stable `playwright-core` directly rather than `@playwright/mcp`, so it controls the launch/SSRF/redaction seam. Pinned because the engine relies on internal snapshot behavior. |

Sackville is **headless-only**: developer live-view was deliberately dropped in
favor of LLM-first observability — trace/HAR/console/video artifacts let an agent
answer "what happened on this page" better than a human watching it render
([ADR 0008](./docs/decisions/0008-headless-only-llm-first-observability.md)).

---

## Repo map

| Path | What |
| --- | --- |
| [`packages/`](./packages) | The TypeScript workspace (19 packages: pillar engines, shared cores, the `mcp` server, the `cli`). |
| [`py/sackville_ingest/`](./py/sackville_ingest) | The Python documentation ingester (uv-managed). |
| [`schema/`](./schema) | The SQLite contract (`*.sql` + `*.json`) both languages honor. |
| [`examples/`](./examples) | Runnable samples (API collection, browser flow, LSP projects, MCP config). |
| [`docs/decisions/`](./docs/decisions) | The 19 Architecture Decision Records. |
| [`CLAUDE.md`](./CLAUDE.md) | How work is done here (TDD, the always-green gate, milestone discipline). |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Technical design and the exact stack. |
| [`STATUS.md`](./STATUS.md) | **Current phase + how to resume. Always current.** |
| [`ROADMAP.md`](./ROADMAP.md) | The phased plan. |
| [`RELEASING.md`](./RELEASING.md) | How packages get published (Changesets + OIDC). |

---

## For contributors & agents

Read [`CLAUDE.md`](./CLAUDE.md) first — it is the contract for how work is done
here (test-first, the always-green `pnpm gate`, commit discipline, and how to
resume cold). The development gate is:

```bash
pnpm gate     # Biome + tsc + Vitest, then Ruff + pytest — must be 100% green
```

If you're using Claude Code in this repo, the bundled skill at
[`.claude/skills/sackville/SKILL.md`](./.claude/skills/sackville) teaches the agent
to use Sackville's own tools (semantic LSP navigation over `grep`/`find`,
version-pinned docs search, change verification) and is picked up automatically on
clone.

## License

[Apache-2.0](./LICENSE) © 2026 Curtis Autery. See [`NOTICE`](./NOTICE) — indexed
third-party documentation remains under its own upstream license.
