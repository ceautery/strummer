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
  safety, scripts, contract validation — response (`validateOpenApiResponse`/
  `validateGraphqlOperation` — which ALSO validates GraphQL request `variables` against the
  operation's declared types, ADR 0015: per-variable `getVariableValues` loop, findings
  reconstructed from name+type (never echoing values), custom-scalar/non-object/multi-op-ambiguity
  → `unverified` folded into the bridge's `noSignal`; wired through the capture bridge + MCP
  `validate_response.variables` + CLI `api validate --variables` + live `api run --graphql`) AND
  request (`validateOpenApiRequest` in
  `request-contract.ts`, ADR 0014: body + path/query/header SCALAR params over the shared
  `resolveOpenApiOperation`/`normalizeOpenApiSchema` seams; the `unverified` flag the
  capture bridge folds into `noSignal` so a present-but-uncheckable request can't pass;
  ALSO wired into live `api run --openapi` via `runRequestForContract` — an out-of-band
  channel surfacing the un-redacted sent request facts at prepare time, `RunResult`
  UNCHANGED, findings redacted via the run's resolved secrets, authoritative; ADR 0016
  added NON-SCALAR params v1 — query `form` ARRAYS explode=true via `validateQueryArray`
  (≥2 occ = the array, sound count; single occ wrapped only when comma-free + no
  cardinality, else `unverified`; `nonScalarType`/`array-values` `ParamLookup` state, a
  scalar param that gets repeated keys folds to `unverified`) + undocumented-param
  SUPPRESSION around object query params (form/explode object ⇒ suppress whole pass;
  deepObject ⇒ exclude `name[...]` keys; unresolved `$ref` ⇒ suppress); rest of the
  style/explode matrix [explode=false comma-arrays, path/header arrays, object
  reconstruction] STAGED, no new finding kind, signature unchanged),
  SSRF + redirect re-check, import
  Postman/Insomnia/OpenAPI/HAR; plus the Phase-5f HAR-synthesis half — `har-synth.ts`'s
  pure fflate-only `redactHarZip`/`summarizeHar` (the shared blanket-redaction pass that
  `@strummer/browser` `finalizeHar` now delegates to) + `synthesizeRedactedHarZip`
  (RunResult→consume-bridge HAR, redact folded in), the runner's out-of-band
  `runRequestForHar`/`runSequenceForHar` capture channel (per-hop records + the real wire
  request body + `redirectTruncated`; `RunResult` UNCHANGED), and the `runRequestToHar`/
  `runSequenceToHar` produce driver — drive the runner → synthesize+redact+store → validate
  via the shipped `validateCapturedTraffic`, with TRANSPORT-completeness guards that throw ⇒
  inconclusive), `browser` (browser/UI engine: lifecycle,
  ARIA-snapshot + step tools, action gate, two-tier SSRF, a11y audit, HAR
  capture/replay, video capture, visual regression, persisted `.bru` flows,
  multi-engine chromium/firefox/webkit — on `playwright-core`, headless-only; plus the
  Phase-5e shared `driveBrowserFlowToHar` (drive a flow → capture+redact its HAR; the
  flow-completeness guard — never validate a partially-failed flow's HAR; consumed by both
  the verify MCP bin AND the `strummer verify run --flow` CLI)),
  `safety` (shared SSRF range classifier + secret redaction, used by `api` +
  `browser`), `assert` (shared declarative-assertion operator core — `AssertionOp`
  + `applyOp` — used by `api` + `browser`), `artifacts` (shared on-disk artifact
  store — `strummer://<prefix>/<id>/<kind>` by-handle egress, parameterized prefix;
  extracted from `browser` per ADR 0010), `diff` (Phase-5d shared changed-set primitive —
  pure, ZERO-dependency `parseUnifiedDiff` (per-file new-side added lines) + `changedFiles`
  (all non-deleted touched paths, the scope primitive); extracted out of `coverage` the moment
  a 2nd consumer appeared, mirroring safety/assert/artifacts — its zero deps are what let
  `verify` consume it without dragging in spawn code), `severity` (the shared, pure
  ZERO-dependency severity scale — `QualitativeSeverity`/`QUALITATIVE_RANK` + the verdict
  scale `Severity`(=`|'none'`)/`SEVERITY_RANK`/`maxSeverity`/`atLeast`; extracted out of
  `deps` so `verdict` (a re-export shim) and `deps` (`SeverityBucket`=`|'unknown'`,
  `BUCKET_RANK`=`{...QUALITATIVE_RANK,unknown:0}`) build on ONE base — the load-bearing
  `none`≠`unknown` distinction kept, deps' `unknown`→no-signal pillar), `deps` (Phase-4 dependency/version
  intelligence: deprecation/vuln/freshness for the *installed* version; pure offline
  core + on-disk OSV snapshot + `audit_dependency`/`audit_project` MCP surface; plus the
  Phase-5d pure `changedDependencies(diff, ecosystem)` block-aware npm manifest diff over `diff`),
  `coverage` (Phase-4 track A: the forgotten-assertion catch — `uncoveredNewLines` +
  `uncoveredInDiff` pure differs over `@strummer/diff`'s `parseUnifiedDiff`, plus gated impact-scoped
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
  SHA-256 digests; the `lsp_rename` MCP tool (no `write` input). `workspace/symbol` DONE
  (`lsp_workspace_symbols` — file-less project-wide search, optional anchor file for tsserver's
  lazy project model). `diagnostics` DONE (`lsp_diagnostics`) — `documentDiagnostics` dispatches by
  capability: PULL (`textDocument/diagnostic` request) when the server advertises `diagnosticProvider`
  (rust-analyzer), else PUSH (`publishDiagnostics`, tsserver); empty `full` report = clean = ok.
  Multi-ROOT DONE (`workspaceRoots[]` / `--workspace-root`; server keyed by the sorted root group).
  Write-mode resource-ops DONE (`lsp_rename` applies Create/Rename/DeleteFile incl. cross-root),
  plus the resource-op SAFE-SUBSET v1 cuts (`ignoreIfExists`/`ignoreIfNotExists` no-ops + editing a
  file also renamed/deleted in one batch via a per-file `Fate` VFS; conflicting batches REFUSED).
  `strummer lsp` CLI DONE. Dynamic `didChangeWorkspaceFolders` DONE (grow-only warm-server reuse: a
  query whose root group is a SUPERSET of a warm same-language server's folders extends it in place +
  re-keys it instead of respawning; capability-gated on `workspaceFolders.changeNotifications`;
  ambiguous-tie/no-cap ⇒ spawn fresh; allowlist + write-mode confinement unchanged; live-verified vs
  rust-analyzer). Destructive `overwrite` DONE (ADR 0011 addendum): a Create/Rename `overwrite:true`
  truncate-and-replaces an EXISTING regular file behind a SEPARATE self-enforcing gate
  (`allowDestructiveResourceOps`); destroyed bytes audited (`(overwritten)` digest row) + surfaced as
  `overwritten[]`; symlink/dir targets refused (lstat), overwrite-create kept out of `created` (a
  later delete stays real), queried-file drift guard, destructive batch escalates the completeness
  guard. Plus a conservative toolchain-mismatch `versionWarning` (toolchain-identity servers only;
  tsserver excluded). Staged-as-refused-by-design: recursive/dir delete; the FULL toolchain
  cross-version matrix),
  `verdict` (Phase-5 cross-pillar verification, COMPLETE: the pure unified change-verdict reducer
  — `Severity`/`SEVERITY_RANK`/`maxSeverity`, the five `from*` pillar adapters (contract/coverage/
  deps/flake/mutate), and `composeVerdict`; **type-only pillar imports, zero runtime pillar deps**
  (the built `.mjs` has NO imports — never drags `better-sqlite3`/`playwright-core` in; pillars are
  `external` in the tsdown build). The load-bearing invariant: **absence is never a pass** (missing/
  no-signal ⇒ `inconclusive`, never `pass`); deps `'unknown'` ⇒ no-signal; mutation survivors drive
  warn/fail; NO baked-in `failAtOrAbove` (caller declares the cut). Design = ADR 0013. **Phase-5f added
  `fromCaptureVerdict`** — folds the FULL `CaptureContractVerdict` (its `clean` flag), so a capture with a
  valid entry alongside a no-signal/unresolved one (which push NO `ContractResult`) is `inconclusive`, not
  a pass — closing a confirmed latent absence-as-pass hole in the shipped 5e produce + consume paths. The
  capture→contract bridge half lives in `@strummer/api` `har-capture.ts` (`harEntriesToFacts` +
  `validateCapturedTraffic` reuse the shipped `validateOpenApiResponse` over a stored HAR; surfaced
  as the gated `validate_capture`)),
  `verify` (Phase-5 milestone 5c run-driving orchestration, COMPLETE: a RUNTIME package — the gated
  `orchestrate(request, options)` that DRIVES the pillars and folds them into one verdict in a single
  call. Imports ZERO spawn-capable code: each requested pillar is an injected `run` thunk producing its
  native result, mapped via `@strummer/verdict`'s `from*` adapters; the built `.mjs` imports only
  `node:crypto` + `@strummer/verdict`. Per-pillar failure isolation (per-task catch); a rejection
  BRANDED a gate denial via `Symbol.for('strummer.gate-denial')` ⇒ `skipReason:'gate-not-set'` (the three
  engine `*GateError` classes set the brand — verify recognizes a real denial without importing engine
  code, reusing `assertAllowed`, no drift), any other ⇒ redacted `errorReason`; injected `idFactory`
  (default `randomUUID`). "Compose, never widen": `orchestrate` invokes each thunk with ZERO args and has
  no `allowRun`/`allowedRoots` knob. Surfaced as the deny-by-default `verify_change` MCP tool +
  `bin-verify` "both required" env gate (`STRUMMER_VERIFY_ENABLE_RUN` AND each pillar's OWN
  `*_ALLOW_RUN` — never verify-scoped renames) + `strummer verify run` CLI. **Phase-5d landed
  diff-scoping + deps run-wiring:** `verify_change` derives `changedFiles` from a supplied `diff` (via
  `@strummer/diff`) so ONE diff scopes coverage/mutate/flake; the reusable `auditProjectDependencies`
  runner (`mcp/deps.ts`, optional `names` scope) is wired into `bin-verify` `rd.deps` gated by
  `STRUMMER_DEPS_ALLOW_NETWORK` composed under `ENABLE_RUN` (deps' gate is NETWORK, not spawn) +
  `strummer verify run --deps`; the deps runner scopes to `changedDependencies(diff)`. **Phase-5e landed
  verify-DRIVEN live capture (browser-spawn):** `verify_change`'s `contract` input + `strummer verify run
  --flow` DRIVE an operator-authored browser flow → capture the HAR → validate it (the consume-only path
  stays). `ContractCaptureContext` is a `consume|produce` discriminated union; produce composes the FULL
  browser gate (`ALLOWED_HOSTS`+`HAR_DIR`+`FLOWS_DIR`, no new env) behind `ENABLE_RUN`+`ALLOW_CAPTURE`;
  the shared `@strummer/browser` `driveBrowserFlowToHar` gates on FLOW COMPLETENESS (never validates a
  partial HAR) over the single-source `buildBrowserRuntimeFromEnv` (egress) with a union redactor at both
  finalize + validate; the produced HAR handle is surfaced for audit. **Phase-5f landed the SECOND produce
  source — verify-DRIVEN API-RUNNER capture:** `verify_change`'s `contract.request` + `strummer verify run
  --request` DRIVE the `@strummer/api` runner for an operator-authored request (by NAME) → synthesize +
  redact + store its HAR (via `@strummer/api` `har-synth.ts`) → validate. `ContractCaptureContext` gains a
  `produce-api` variant (EXACTLY ONE of request/flow/harHandle); `bin-verify` composes the api pillar's OWN
  gate (`STRUMMER_ALLOW_UNSAFE`/`_ALLOWED_HOSTS`/`_BLOCK_PRIVATE` + `{{secret:NAME}}`) + the ratified
  `STRUMMER_API_COLLECTIONS_DIR` (by-NAME, traversal refused). Transport guards throw ⇒ inconclusive; the
  contract thunk now surfaces the FULL verdict so `@strummer/verdict` `fromCaptureVerdict` folds
  `clean===false` to inconclusive (consume + both produce paths). Design = ADR 0013 Addenda 2+3+4),
  `mcp` (server), `cli` (terminal — `search`/`get`/`versions`/`detect`, `api`,
  `browser`, AND the Phase-4 verification CLIs `mutate`/`coverage`/`flake`/`deps`/`lsp`,
  each a thin human wrapper over its engine; the human is the operator, so run/write
  gates are straight-through flags (`--allow-run`/`--allow-write` etc.) and
  runners/fetchers/LSP-servers are injectable so the suite never spawns/fetches —
  ADR 0010/0011 no-real-spawn-in-gate; `lsp` builds the real manager/engine from
  flags and shuts it down per single-shot invocation).
- `py/strummer_ingest/` — Python ingester (uv).
- `schema/` — the SQLite contract (`*.sql` + `*.json`).
- `examples/` — runnable samples (e.g. `examples/api/jsonplaceholder`,
  `examples/browser/login`, `examples/lsp/greeter` — a tiny TS project for the
  `strummer lsp` quickstart, and `examples/lsp/pygreeter` — its Python counterpart
  (drives `pyright-langserver`; the engine is language-agnostic)), used by the
  `@strummer/cli` quickstarts; each guarded by an offline test so the sample + its docs
  can't drift.
- `.github/workflows/ci.yml` — CI mirroring `pnpm gate` on push/PR.
- The Linux dev-container harness (`docker/`, `docker-compose.yml`) that hosts
  Claude Code is **untracked** (gitignored) — local tooling for creating the
  container, not part of Strummer.
