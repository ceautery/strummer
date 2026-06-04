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
**Phase 4 is complete** (all five pillars: engine + agent surface). **Phase 5 (cross-pillar
verification) is complete too** — the pillars now *compose*: a captured run's traffic is
validated against the API contract (the capture→contract bridge) and folds with the four
Phase-4 signals into one change verdict ([ADR 0013](./docs/decisions/0013-cross-pillar-verification.md)).
(Visual-regression diffing and API contract/schema testing already shipped inside the browser
and API pillars.)

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
the shared `@strummer/artifacts`) + the `strummer-deps-mcp` bin — plus the Python/PyPI +
RubyGems advisory adapters (`audit_dependency` + `audit_project` across all three
ecosystems) and a human **`strummer deps` CLI** (`audit`/`audit-project`/`changelog`). All
four Phase-4 verification pillars now also ship a human `strummer <pillar>` CLI
(`mutate`/`coverage`/`flake`/`deps`), each a thin wrapper over its engine.

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
stage-then-commit + staleness guards) have since landed (ADR 0011 addendum), as has a human
**`strummer lsp` CLI** (single-shot navigation + `rename`, the engine injectable so the gate
never spawns a real server). Since then **`workspace/symbol`** search (`lsp_workspace_symbols`),
**`diagnostics`** (`lsp_diagnostics` — `documentDiagnostics` dispatches by capability: the PULL
model `textDocument/diagnostic` for servers advertising `diagnosticProvider` (rust-analyzer), else
the PUSH model `publishDiagnostics` (tsserver)), **multi-root**
workspaces (`workspaceRoots[]` / `--workspace-root`, one server bound to many folders — including
write-mode rename), **resource-operation write-mode** (`lsp_rename` applies
`CreateFile`/`RenameFile`/`DeleteFile` interleaved with text edits — e.g. a module rename that
renames its backing file — verified live against rust-analyzer), and its **safe-subset v1 cuts**
(`ignoreIfExists`/`ignoreIfNotExists` as no-ops + editing a file also renamed/deleted in one batch,
via a per-file `Fate` projection; conflicting batches refused) have all landed. The resource-op
work also generalized the readiness model to servers that signal not-ready via an error. Most
recently, **dynamic workspace-folder changes** (`didChangeWorkspaceFolders`) landed as grow-only
warm-server reuse — a query whose root group is a superset of a warm same-language server's folders
extends that server in place (capability-gated; ambiguous-tie/no-cap ⇒ spawn fresh) instead of
respawning and re-indexing; verified live against rust-analyzer. Most recently, **destructive
`overwrite`** landed (ADR 0011 addendum): a Create/Rename `overwrite:true` truncate-and-replaces an
EXISTING regular file behind a separate, self-enforcing operator gate
(`allowDestructiveResourceOps`), auditing the destroyed bytes and surfacing an `overwritten[]` list —
designed via an adversarial fan-out that caught two data-loss blockers (a symlink-clobber audit lie;
an overwrite-create that silently no-op'd a following delete), so symlink/dir targets stay refused and
the completeness guard escalates on a destructive batch. A conservative toolchain-mismatch warning
also lands. Staged-as-refused-by-design: recursive/dir delete (the least-reversible op) and the full
toolchain cross-version resolution matrix.

**Phase 5 (cross-pillar verification) is complete** — the pillars now compose
([ADR 0013](./docs/decisions/0013-cross-pillar-verification.md)). Two milestones, both
compose-only / zero-spawn. **5a — the capture→contract bridge**: `harEntriesToFacts` +
`validateCapturedTraffic` in `@strummer/api` turn a stored browser/API HAR into facts the
*already-shipped* `validateOpenApiResponse` consumes (attach-body resolution, JSON/origin
filter, server-base-path reconciliation, an exercised-operations drift walk) — no request is
re-run; surfaced as the gated `validate_capture` MCP tool (a HAR is operator-gated bytes, so
resolving one needs `STRUMMER_VERIFY_ALLOW_CAPTURE`; every finding message + captured path is
redacted) + the `strummer api validate-capture` CLI. **5b — the unified change verdict**: a new
pure **`@strummer/verdict`** package folds the four Phase-4 signals + the contract sub-verdict
into one `CompositeVerdict` (type-only pillar imports, *zero runtime pillar deps*). The
load-bearing rule: **absence is never a pass** — a missing/no-signal pillar yields
`inconclusive`, never `pass`; there is no baked-in severity threshold (the caller declares the
cut). Surfaced as the `request_verdict` MCP tool + `strummer-verify-mcp` bin + a `strummer verify`
CLI. The shared `@strummer/artifacts` store also gained prefix-qualified, hardened cross-prefix
rehydration so one pillar can resolve another's by-handle artifact. **A Phase-5 tail since landed —
GraphQL drift over captured traffic**: `validateCapturedTraffic`'s contract is now the discriminated
`CaptureContract { openapi?, graphql?: {endpointPath, sdl} }`, GraphQL entries route to the shipped
`validateGraphqlOperation` (never the OpenAPI validator), and absence stays non-passing (GraphQL with
no SDL ⇒ no-signal); backed by a real Playwright `content:'attach'` capture fixture. **5c — run-driving
`verify` has since landed** (ADR 0013 Addendum): a new `@strummer/verify` package + the `verify_change`
MCP tool + `strummer verify run` CLI DRIVE the gated pillars (coverage/flake/mutate + the consume-only
contract) and fold them into one verdict in a single call. The gate contract is **"compose, never
widen"** — `verify` reuses each pillar's *own* gate plus a separate `STRUMMER_VERIFY_ENABLE_RUN`
opt-in ("both required"); a pillar whose gate is unmet is `skipped:gate-not-set`, never run; the
orchestrator imports zero spawn-capable code. **5d — diff-scoping + deps run-wiring has since landed**:
a shared zero-dependency **`@strummer/diff`** (`parseUnifiedDiff` + `changedFiles`) lets `verify_change`
scope coverage/mutate/flake from ONE diff; a pure `changedDependencies(diff)` + a reusable
`auditProjectDependencies` runner wire deps into the run path (`STRUMMER_DEPS_ALLOW_NETWORK` under
`ENABLE_RUN`) + `strummer verify run --deps`. **5e — `verify` driving a LIVE capture has since landed**
(ADR 0013 Addendum 3): `verify_change`'s `contract` input + `strummer verify run --flow` DRIVE an
operator-authored browser flow → capture the HAR → validate it, behind the full browser gate; the shared
`@strummer/browser` `driveBrowserFlowToHar` gates on **flow completeness, not HAR emptiness** (a
partially-failed flow's HAR is never validated — absence stays non-passing), with a union redactor at
both the archive and the findings. **5f — `verify` driving the `@strummer/api` RUNNER to *produce* the HAR
has since landed** (ADR 0013 Addendum 4): the SECOND produce source — `verify_change`'s `contract.request`
+ `strummer verify run --request` DRIVE the api runner for an operator-authored request (by NAME) →
synthesize a HAR (`@strummer/api` `har-synth.ts`: per-hop entries, the real request body for GraphQL, a
shared `redactHarZip` pass `finalizeHar` now delegates to) → validate it, behind the api pillar's own gate
+ `STRUMMER_API_COLLECTIONS_DIR`; transport-completeness guards throw ⇒ inconclusive, and the new
`@strummer/verdict` `fromCaptureVerdict` folds a not-`clean` capture to inconclusive (closing a latent
absence-as-pass hole across the consume + both produce paths). **Two follow-on tails have since landed:**
the shared **`@strummer/severity`** scale was extracted out of `@strummer/deps` into its own pure zero-dep
leaf (`QualitativeSeverity`/`QUALITATIVE_RANK` + the verdict scale; `none`≠`unknown` kept distinct); and
**request-body & parameter contract validation** ([ADR 0014](./docs/decisions/0014-request-contract-validation.md))
— a new `validateOpenApiRequest` sibling validates the request half (body + path/query/header params) and
threads into the capture→contract bridge + verdict (via an `unverified`→`noSignal` fold so a
present-but-uncheckable request can't pass) + a direct `validate_request` MCP tool / `strummer api
validate-request` CLI. Staged (not amputated): the live `api run --openapi` inline request check, non-scalar
OpenAPI param serializations, and the Python second half.

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
