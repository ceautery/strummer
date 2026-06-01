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

Cross-cutting verification tools (see [`ROADMAP.md`](./ROADMAP.md)): dependency/version
intelligence, coverage-aware impact-scoped test runs, flaky-test detection & quarantine,
mutation testing, and semantic code navigation via an LSP bridge have **all shipped** —
**Phase 4 is complete** (all five pillars: engine + agent surface). (Visual-regression
diffing and API contract/schema testing already shipped inside the browser and API pillars.)

## Status

Under active development. The **docs/idioms pillar is complete** (version-pinned
hybrid search over MCP + CLI, multi-ecosystem version detection, DevDocs + Dash
adapters). The **API-testing pillar's core is complete** too — `.bru` runner,
secrets, deny-by-default mutation safety, captures/chaining, QuickJS scripts,
OpenAPI/GraphQL contract validation, and both an MCP tool surface and a
`strummer api …` CLI. The **browser/UI pillar (`@strummer/browser`, on
`playwright-core`) is feature-complete on both surfaces** — the engine (browser
lifecycle manager, ARIA-snapshot capture + imperative step tools, deny-by-default
action gate, two-tier SSRF defense sharing `@strummer/safety`, and an artifact
pipeline of trace/console/network by handle), a session-oriented **MCP surface**
(`registerBrowserTools` + the `strummer-browser-mcp` bin) with a per-session mutex
and the `strummer://browser/run/{runId}/{kind}` resource, the full **secret
boundary** (`{{secret:NAME}}` fill, origin-scoped `httpCredentials`, `storageState`
by handle, redaction across console/network/snapshot/reads/trace), and operator
hardening (service-worker block, WebRTC-egress neutralization, session wall-clock +
max-pages + max-contexts caps). The complete **deny-by-default gating bundle**
(downloads quarantine, uploads confined to an allowlist dir, dialog dismiss, auth via
`httpCredentials`), an on-demand **screenshot** step tool, **browser assertions**
(reusing a shared `@strummer/assert` operator core — one assertion engine across
pillars — with auto-waiting), a **trace-query** tool (action timeline from a
trace.zip), a **Lighthouse perf audit**, **network heavy mode** (HAR capture —
redacted, by handle — and `routeFromHAR` replay for deterministic offline runs),
**persisted `.bru` browser-step flows** (replayable, semantic-locator-keyed — over
both `strummer browser run` and the MCP `browser_run_flow` tool), **video capture**
(webm by handle), **vision/coordinate caps** (operator-gated coordinate click/move
for canvas / non-AX-tree UI), **visual-regression diffing** (`browser_visual_compare`
via pixelmatch, baseline by handle), a human **`strummer browser` CLI** (snapshot/
audit/screenshot/run), and a **container-hardening ADR** (the deployment/kernel
boundary, [ADR 0007](./docs/decisions/0007-container-hardening.md)) have all landed,
along with **multi-engine** (Chromium + Firefox + WebKit;
[ADR 0009](./docs/decisions/0009-multi-engine.md)) — so the browser pillar is
feature-complete. Strummer is **headless-only**: developer live-view was dropped in
favor of LLM-first observability — the trace/HAR/console/video artifacts let the
agent answer "what happened on this page" better than a human watching it render
([ADR 0008](./docs/decisions/0008-headless-only-llm-first-observability.md)).

**Phase 4 (cross-cutting verification) is complete** — all five pillars shipped (engine +
agent surface); only explicitly-staged, non-blocking tails remain. The sequence was locked
by a research + adversarial-verification fan-out
([ADR 0010](./docs/decisions/0010-phase4-cross-cutting-verification.md)):
dependency intelligence ∥ coverage → flaky-test detection → mutation testing → an LSP
bridge (last). The first pillar, **`@strummer/deps` (dependency/version
intelligence)**, has its pure, offline core complete — deprecation, OSV vulnerability
matching (incl. CVSS-vector severity scoring), on-disk OSV-snapshot loading, freshness
(`behindBy`), a vuln-aware `minimumSafeUpgrade` target, and a composed `auditDependency`
verdict for the version *actually installed*. Its **agent surface has shipped** — the
`audit_dependency`/`audit_project`/`changelog_diff` MCP tools (artifacts by handle over
the shared `@strummer/artifacts`) + the `strummer-deps-mcp` bin. A human `strummer deps`
CLI and the Python/PyPI + RubyGems advisory adapters are next.

The parallel track, **`@strummer/coverage`**, is also complete — the "forgotten
assertion" catch: given a diff it reports the lines a change *added* that no test
exercised (`parseUnifiedDiff` + `uncoveredNewLines` + `uncoveredInDiff`, with an explicit
non-executable third state), plus a gated, impact-scoped `runScoped` that runs only the
tests a change touches (`vitest related`) with coverage. Agent surface: the
`uncovered_in_diff` (read-only) + `run_scoped` (operator-gated) MCP tools +
`strummer-coverage-mcp` bin.

The **test-quality chain is complete through mutation**. **`@strummer/flake`**
(flaky-test detection) is done — a pure Wilson/binomial classifier
(`flaky`/`reliable`/`broken`/`insufficient-data` + a `flakeScore`), a private
`better-sqlite3` run-history store, `vitest --reporter=json` ingestion, an
operator-gated quarantine with mandatory expiry, a gated suite-repeat runner, and the
`flake_status`/`flake_candidates`/`flake_release`/`flake_run`/`flake_quarantine` MCP
surface + `strummer-flake-mcp` bin. **`@strummer/mutate`** (mutation testing) is done —
a pure `summarizeMutation` over the mutation-testing-elements report schema (score +
survivor list), a gated, diff-scoped `runMutation` spawning `stryker run`, and the
`mutate_summarize`/`mutate_run` MCP surface + `strummer-mutate-mcp` bin (the
Stryker/Vitest-4 compat blocker was resolved — [ADR 0010 update](./docs/decisions/0010-phase4-cross-cutting-verification.md)).

The last pillar, **`@strummer/lsp`** (semantic code navigation — the documented,
fenced exception to the no-live-RPC rule), is **done**: design locked in
[ADR 0011](./docs/decisions/0011-lsp-bridge.md) (a research + 2-critic adversarial
fan-out), shipped as five slices — the pure position-encoding core (utf-8/16/32) and
LSP-result normalizers, a `vscode-jsonrpc` client (encoding negotiation, tri-state
readiness, deadlock-safe replies), the `(language, projectRoot)`-keyed manager (per-file
mutex, in-flight-aware reaper) + operator-bound server registry, the gated `query.ts`
engine, and the `lsp_find_definition`/`lsp_find_references`/`lsp_hover` (gated as a group)
+ always-on `lsp_languages` MCP surface + `strummer-lsp-mcp` bin. The whole pillar is
tested against a fake in-process JSON-RPC peer replaying recorded real-server payloads —
no real language server runs in the green gate. The capability-gated read tails
(`lsp_type_definition`/`_document_symbols`/`_call_hierarchy`) and **write-mode**
(`lsp_rename` — dry-run by default, applies to disk only behind a separate
`STRUMMER_LSP_ALLOW_WRITE` gate; single- and multi-file via a sorted multi-URI lock with
stage-then-commit + staleness guards) have since landed (ADR 0011 addendum). Staged next:
write-mode resource-ops + multi-file conflict reconciliation, `workspace/symbol`,
diagnostics, multi-root, and a `strummer lsp` CLI.

**The single source of truth for "what phase are we on" is [`STATUS.md`](./STATUS.md).**

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
