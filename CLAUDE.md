# CLAUDE.md — how we build Strummer

This file is the contract for how work is done in this repo. Read it fully at
the start of every session. If you are resuming cold, also read `STATUS.md`,
`ROADMAP.md`, and the project memories before touching anything.

## What Strummer is

An LLM-agent-first developer testing & verification toolkit, delivered as a
headless **MCP server** + a human **CLI**. Three pillars (docs, API testing,
browser testing) plus cross-cutting verification tools. See `README.md` for the
vision and `ARCHITECTURE.md` for the technical design.

## Prime directives (non-negotiable)

1. **TDD always: red → green → commit.** Write a failing test first. Make it
   pass with the smallest change. Only then commit. No production code without a
   test that demanded it.
2. **Nothing is committed or pushed unless linters and test suites are 100%
   green.** This is a hard gate. "Green" means every package, both languages.
3. **Brainstorm before building; develop with subagents.** Non-trivial work
   starts with a short design pass and makes **liberal use of Dynamic Workflows
   ("fan out")** — parallel research, parallel implementation of independent
   units, adversarial verification of findings.
4. **Aspirational by default.** "Not needed for v1" is an anti-pattern here.
   Design for the top-tier tool; stage the work in `ROADMAP.md`, don't amputate
   it.
5. **Commit directly to `main`. Push to GitHub at milestones** (not every
   commit). Remote: `https://github.com/ceautery/strummer`.
6. **Update notes after every milestone**: memories, `ROADMAP.md`, `STATUS.md`.
   A milestone is not done until the notes reflect reality.

## The two questions that must always have a fresh, correct answer

- **"What phase are we on?"** → the top of `STATUS.md`. Keep it current.
- **"Pick up from where we left off."** → `STATUS.md` (current phase + next
  action) → `ROADMAP.md` (the plan) → project memories → recent git log. These
  must be enough to resume from a fresh session with zero in-memory context. If
  they aren't, that's a bug in the notes — fix it.

## Architecture rules

- **Agent-first.** Every capability is an MCP tool/resource with a structured,
  token-efficient output. Large artifacts (doc bodies, traces, screenshots,
  request logs) are returned by **handle/resource link**, not inlined.
- **Polyglot boundary is a file.** Python (ingestion/indexing) and TypeScript
  (serving) communicate through a **SQLite database on disk** (FTS5 + optional
  `sqlite-vec`), never a live RPC. Each side's green gate is independent.
- **Version-pinned, not "latest".** The docs pillar must answer for the version
  of a dependency that is *actually installed* in the target project.

## Toolchain & commands

> Exact versions and the definitive list live in `ARCHITECTURE.md`. This section
> is the muscle-memory cheat sheet; keep it in sync when the scaffold changes.

- **TypeScript:** Node 22, pnpm workspaces. Lint/format: **Biome**. Test:
  **Vitest** (the TDD loop). 
- **Python:** docs-ingestion package. Lint/format: **Ruff**. Test: **pytest**.
- **The green gate (run before every commit):**
  ```
  pnpm gate
  ```
  Runs Biome (lint+format) → tsc typecheck (all TS packages) → Vitest, then
  Ruff (lint+format) → pytest. Defined in `scripts/gate.sh`. Nothing commits or
  pushes unless this is 100% green.

## Working with Dynamic Workflows

- Use fan-out for: broad research before a design decision, implementing several
  independent units in parallel, and adversarially verifying findings/claims
  before trusting them.
- Prefer `pipeline()` (no barrier) unless a stage genuinely needs all prior
  results at once.
- Keep the human in the loop between phases: read results, decide, then fan out
  the next phase.

## Definition of done for a milestone

- [ ] Feature has tests written test-first; suite is 100% green.
- [ ] Both linters pass (Biome, Ruff) with zero warnings.
- [ ] `STATUS.md` updated (phase, what's done, next action).
- [ ] `ROADMAP.md` reflects any scope/sequence changes.
- [ ] Memories updated for anything non-obvious worth carrying forward.
- [ ] Committed to `main`; pushed to GitHub if this is a milestone boundary.

## Repo map

- `README.md` — vision & overview.
- `CLAUDE.md` — this file; how we work.
- `ARCHITECTURE.md` — technical design, exact stack, the SQLite contract. *(authored after design research; see STATUS.md)*
- `ROADMAP.md` — phased plan.
- `STATUS.md` — current phase + how to resume. **Always current.**
- `docs/decisions/` — Architecture Decision Records (ADRs).
- `packages/` — TS workspace: `core` (docs domain + SQLite), `embed` (query
  embedding), `api` (API-testing engine: `.bru`, runner, assertions, secrets,
  safety, scripts, contract validation, SSRF + redirect re-check, import
  Postman/Insomnia/OpenAPI/HAR), `browser` (browser/UI engine: lifecycle,
  ARIA-snapshot + step tools, action gate, two-tier SSRF, a11y audit, HAR
  capture/replay, video capture, visual regression, persisted `.bru` flows,
  multi-engine chromium/firefox/webkit — on `playwright-core`, headless-only),
  `safety` (shared SSRF range classifier + secret redaction, used by `api` +
  `browser`), `assert` (shared declarative-assertion operator core — `AssertionOp`
  + `applyOp` — used by `api` + `browser`), `artifacts` (shared on-disk artifact
  store — `strummer://<prefix>/<id>/<kind>` by-handle egress, parameterized prefix;
  extracted from `browser` per ADR 0010), `deps` (Phase-4 dependency/version
  intelligence: deprecation/vuln/freshness for the *installed* version; pure offline
  core + on-disk OSV snapshot + `audit_dependency`/`audit_project` MCP surface),
  `coverage` (Phase-4 track A: the forgotten-assertion catch — `parseUnifiedDiff` +
  `uncoveredNewLines` + `uncoveredInDiff` pure differs, plus gated impact-scoped
  `runScoped`; `uncovered_in_diff`/`run_scoped` MCP surface),
  `flake` (Phase-4 test-quality chain, COMPLETE: flaky-test detection — pure Wilson/binomial
  `classifyHistory` → `flaky`/`reliable`/`broken`/`insufficient-data` + `flakeScore`; a private
  better-sqlite3 `HistoryStore` (second SQLite owner per ADR 0010); `parseVitestJson`/
  `ingestReport`; operator-gated `Quarantine` (mandatory expiry); gated `runAndRecord` vitest
  spawner; `flake_status`/`flake_candidates`/`flake_release`/`flake_run`/`flake_quarantine`
  MCP surface),
  `mutate` (Phase-4 test-quality chain, COMPLETE: mutation testing — "are the tests
  meaningful?"; pure `summarizeMutation` over the mutation-testing-elements report schema
  (no `@stryker-mutator` import) → mutationScore + survivors; gated diff-scoped `runMutation`
  spawning `stryker run` (injected runner, not a gate dep); `mutate_summarize`/`mutate_run`
  MCP surface),
  `lsp` (Phase-4, COMPLETE (engine + agent surface) — semantic code navigation via a live LSP
  subprocess; the documented, fenced exception to ARCHITECTURE §1's no-live-RPC rule, design = ADR 0011.
  Slice 1 landed: pure `encoding.ts` (the position-encoding correctness core, utf-8/16/32)
  + `normalize.ts` (Location/LocationLink, hover, document-symbol shapes, tri-state). Slice 2
  landed: `client.ts` — the LSP JSON-RPC client over an injected `serverSpawn` seam (handshake
  advertising `positionEncodings` + read-back; `initialized`; refcounted open-once `didOpen`/
  no-didClose; capability-gated requests; deadlock-safe null replies to inbound server requests;
  tri-state readiness gated on `$/progress` within one operator deadline + injected clock).
  `vscode-jsonrpc` + `vscode-languageserver-protocol` added as explicit pins; tested against a
  fake in-process JSON-RPC peer (paired duplex streams) replaying RECORDED real-server payloads
  (captured from `typescript-language-server` 5.3.0; see `test/fixtures/README.md`). Slice 3
  landed: `registry.ts` (operator-bound JSON `language→{command,args[],initializationOptions?}`;
  command/args structurally separate — no DSL; unbound language refused) + `manager.ts`
  (`LanguageServerManager` keyed by `(language, projectRoot)`, shared/lazy spawn via the
  injected seam, `rootUri` pinned to the allowlisted root, per-`(server,uri)` async mutex,
  in-flight-aware reaper that never reaps mid-request + clock-driven `shutdown`→`exit` grace
  before `dispose()`); shared in-process peer test harness factored to `src/peer.ts`. Slice 4
  landed: gated `query.ts` (`LspQueryEngine` mirroring coverage's `runScoped` — paired
  deny-by-default `allowRun`+`allowedRoots`+deadline gate via `LspGateError`; queried-file
  confinement to the project root; human↔LSP position mapping via `toLspPosition`/`fromLspPosition`
  + the negotiated `client.encoding` — result ranges mapped back per target file, best-effort `+1`
  when unreadable; tri-state passthrough; `serverInfo` provenance + serverInfo-absent
  `versionWarning`; echoes optional `toolchain` provenance). Slice 5 landed (agent surface):
  `lsp_find_definition`/`_references`/`_hover` (gated as a group — no free-read tier) + the
  always-on no-spawn `lsp_languages` (bound languages + live capabilities/`serverInfo.version`
  via `manager.describe()`, never the command/path); large reference lists by handle via
  `@strummer/artifacts` (`lsp` prefix); `packages/mcp/src/lsp.ts` (pure wiring over an injected
  `query`+`describeServers`) + `strummer-lsp-mcp` bin (`STRUMMER_LSP_*`; toolchain provenance via
  `core.detectInstalledVersion`). Capability-gated read tails DONE — `lsp_type_definition`/
  `lsp_document_symbols`/`lsp_call_hierarchy` (real `typescript-language-server` 5.3.0 payload
  fixtures; gate still replays recorded payloads). Write-mode DONE (`lsp_rename`, ADR 0011 addendum,
  slices A–G): dry-run by default + a SEPARATE `STRUMMER_LSP_ALLOW_WRITE` gate enforced to require
  `allowRun`; pure `apply.ts` + `normalizeWorkspaceEdit`; realpath-hardened all-or-nothing
  `confine.ts`; `client.rename`/`prepareRename` + write handshake caps; full-text `didChange`
  doc-sync + inbound `applyEdit` deadlock guard; single- AND multi-file apply via
  `manager.runWithUris` (sorted multi-URI lock) + stage-then-commit-all + staleness guards +
  SHA-256 digests; the `lsp_rename` MCP tool (no `write` input). Staged: write-mode resource-ops +
  multi-file conflict reconciliation, `workspace/symbol`, diagnostics, multi-root, full
  toolchain-mismatch heuristic, a `strummer lsp` CLI),
  `mcp` (server), `cli` (terminal).
- `py/strummer_ingest/` — Python ingester (uv).
- `schema/` — the SQLite contract (`*.sql` + `*.json`).
- `examples/` — runnable sample collections (e.g. `examples/api/jsonplaceholder`,
  used by the `@strummer/cli` API quickstart).
- `.github/workflows/ci.yml` — CI mirroring `pnpm gate` on push/PR.
- The Linux dev-container harness (`docker/`, `docker-compose.yml`) that hosts
  Claude Code is **untracked** (gitignored) — local tooling for creating the
  container, not part of Strummer.
