# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**Phase 4 — Cross-cutting verification: UNDERWAY (4 of 5 pillars complete; LSP — the last —
in progress, slices 1–2 landed).** _(`@strummer/deps`, `@strummer/coverage`, `@strummer/flake`,
and `@strummer/mutate` are all COMPLETE (engine + agent surface); `@strummer/lsp` is the only
remaining candidate — design locked in **ADR 0011**, slice 1 (pure encoding + normalize) and
slice 2 (`client.ts` — the LSP JSON-RPC client over the fake-peer harness) landed. Design pass
done via the `phase4-design-research` fan-out — 5 parallel research
streams → synthesis → 3 adversarial critics → corrected synthesis; captured in **ADR
0010**. Sequence (by leverage-per-effort): **`@strummer/deps` (dependency/version
intelligence) first** ∥ `@strummer/coverage` (parallel track), then `@strummer/flake`
→ `@strummer/mutate` (after a Stryker/Vitest-4 compat spike) → `@strummer/lsp` (last —
the only candidate that breaks ARCHITECTURE §1's no-live-RPC rule). Cross-cutting
decisions in ADR 0010: extract a shared **`@strummer/artifacts`** (parameterized
prefix) before the first handle-emitting slice; **explicit pins, no transitive
imports**; **paired deny-by-default operator gate** for any code-running surface;
**TS/Vitest first, Python staged**. **Slice 1 landed:** `@strummer/deps`
`auditDeprecation(packument, installedVersion)` — a pure, offline deprecation reducer
(version-scope wins over package-scope; npm empty-string un-deprecate idiom honoured)
over committed npm-packument fixtures. **Slice 2 landed:** `matchVulnerabilities`
— a pure OSV version-range matcher (the documented sort-events-then-scan algorithm;
SEMVER/ECOSYSTEM via `semver`, `fixed` exclusive vs `last_affected` inclusive,
explicit `versions`, ecosystem+name filter; severity bucketed
`critical|high|moderate|low|unknown`) over committed OSV-advisory fixtures.
`semver ^7.8.1` added as the package's first explicit pinned dep (matches `core`).
**Slice 3 landed:** `loadOsvSnapshot(dir, ecosystem)` — reads an operator on-disk OSV
snapshot (`<dir>/<ecosystem>/all.zip`, fflate-unzipped, one advisory JSON per entry)
→ `{ecosystem, advisories (sorted by id), snapshotDate (newest advisory `modified`)}`
feeding `matchVulnerabilities`; fails loud on an absent ecosystem snapshot; zero
network (real FS round-trip in tests). `fflate ^0.8.3` added as an explicit pinned
dep (matches `browser`). **Slice 4 landed:** `auditDependency(input)` — the
agent-facing roll-up composing `auditDeprecation` + `matchVulnerabilities` + freshness
(latest / latestSameMajor / isOutdated via `semver`, prereleases excluded) into one
verdict (`worstSeverity`, conservative newest-same-major `recommendedTarget`,
`snapshotDate`, `hasFindings`); pure (caller gathers inputs). **The deps engine's pure
core is complete.** **Slice 5 landed (agent surface):** `audit_dependency` (single
package) + `audit_project` (compact npm-manifest roll-up; per-package error non-fatal)
MCP tools in `packages/mcp/src/deps.ts` (`registerDepsTools`/`createDepsServer`) +
`strummer-deps-mcp` bin (`bin-deps.ts`). The surface wires the I/O the pure core needs —
detect the INSTALLED version (`core.detectInstalledVersion`, ecosystem-mapped npm→node) →
an **injected** packument fetch (so the surface stays offline/deterministic in tests) →
the operator OSV snapshot (`loadOsvSnapshot`) → pure `auditDependency`; reports
`osvSnapshotLoaded` so "no known vulns" is never authoritative absent a snapshot, and
fails clearly when the version can't be detected or network is off. The bin is the sole
reader of namespaced `STRUMMER_DEPS_*` (`OSV_DB_DIR`, `ALLOW_NETWORK` **off by default**,
`NPM_REGISTRY`, `ALLOW_PRIVATE`) and the sole builder of the **SSRF-pinned**
(`@strummer/safety` `resolveAndPin`, private blocked by default) npm packument fetcher;
safety/network are operator-set, never agent inputs. The first **handle-emitting** deps
slice (`changelog_diff` + by-handle `audit_project` detail) is deferred to the shared
`@strummer/artifacts` extraction. **Shared `@strummer/artifacts` extraction DONE** (ADR
0010 cross-cutting): the on-disk `ArtifactStore` moved out of `@strummer/browser` into a
new shared package with a **parameterized** `strummer://<prefix>/<id>/<kind>` handle
prefix (browser keeps `browser/run`; deps/coverage emit their own — e.g.
`strummer://deps/...`). Behavior-preserving — browser is a thin subclass that bakes in
the `browser/run` prefix so every call site is unchanged; the full browser suite is the
regression guard. **`changelog_diff` landed (first handle-emitting deps slice):** a
pure `sliceChangelog(markdown, {from, to?})` core in `@strummer/deps` (versioned ATX
headings — Keep-a-Changelog `## [x.y.z] - date` + plain `## vX.Y.Z`; returns the
sections in `(from, to]`, or `> from` when `to` is omitted, newest-first, semver-ordered;
date tokens/"Unreleased" never become versions; unparseable bounds throw) + a
`changelog_diff` MCP tool that detects the installed `from`, fetches the changelog via an
**injected** fetcher, slices it, and returns a compact summary with the sliced markdown
stored **by handle** in `@strummer/artifacts` (`deps` prefix) — served by a new
`strummer://deps/{id}/{kind}` resource. Deny-by-default: the tool + resource register only
when BOTH a fetcher and an artifact store are configured. Bin adds
`STRUMMER_DEPS_ARTIFACT_DIR` (→ `ArtifactStore(dir,'deps')`) + a SSRF-pinned GitHub-raw
CHANGELOG fetcher (packument repo → `raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>`,
`resolveAndPin` per attempt, private blocked by default). It is the first consumer of the
extracted `@strummer/artifacts`. **`audit_project` full detail by handle also landed:**
when an artifact store is configured, `audit_project` stores the full per-package
`DependencyAudit` verdicts (vulnerability lists, deprecation messages, freshness) as one
JSON blob by handle and surfaces `detailHandle` (inline result stays a compact roll-up;
without a store, `detailHandle` is omitted — `audit_project` is not gated on artifacts).
The `strummer://deps/{id}/{kind}` resource now serves both audit detail + changelog slices
(decoupled from the changelog fetcher; emits each artifact's own contentType). The
vuln-aware `minimumSafeUpgrade` target also landed (lowest release clearing all known
vulns, distinct from `recommendedTarget`), and the `behindBy` freshness metric
(`FreshnessVerdict.behindBy`: upgrade distance by semver component — releases/major/minor/
patch). **CVSS-vector → bucket scoring also landed** (pure `cvssV3BaseScore` v3.0/3.1 base
formula; `matchVulnerabilities` derives the severity bucket from a CVSS vector when no
qualitative GHSA string is present, so a vector-only advisory is no longer `unknown`).
**Track A `@strummer/coverage` is now open (slice 1):** the pure `uncoveredNewLines` differ
classifies a diff's added lines against an istanbul `FileCoverage` as covered / uncovered /
`nonExecutable` and surfaces the executable-but-unhit lines (the forgotten-assertion catch);
the no-statement `nonExecutable` third state + a guard test address ADR 0010's documented
correctness trap. **Slice 2 landed:** `parseUnifiedDiff` extracts per-file new-side added
lines from a unified diff (count-tracking hunk state machine; handles multi-file/prefix-less/
new/deleted files). **Slice 3 landed:** `uncoveredInDiff` joins the two halves — parse the
diff → match each file to its `coverage-final.json` entry (path reconciliation: exact
`<projectRoot>/<path>` else a unique path-suffix match, ambiguous refused) → classify →
report every executable-but-unhit new line + per-file breakdown + aggregate summary. The
pure offline core of the forgotten-assertion catch is complete. **Slice 4 landed:**
`runScoped` runs only the tests a change touches (`vitest related`) with v8 JSON coverage
→ feeds `coverage-final.json` into `uncoveredInDiff`; behind a paired deny-by-default
operator gate (`allowRun` + `allowedRoots` + timeout, `CoverageGateError`), with the
`vitest` run an injected `TestRunner` (default spawns a subprocess — the child-process
boundary that dodges Vitest-in-Vitest; engine unit-tested with a fake runner, no real spawn
in the gate). **MCP surface landed:** `uncovered_in_diff` (free, read-only) + `run_scoped`
(gated, registered only when the operator set `allowRun` + a non-empty root allowlist) in
`packages/mcp/src/coverage.ts` + the `strummer-coverage-mcp` bin (`STRUMMER_COVERAGE_ALLOW_RUN`
/ `_PROJECT_ROOTS` / `_TIMEOUT_MS`, wires the live vitest runner). **The coverage pillar's
agent surface is complete.** **`@strummer/flake` is now open (slice 1):** the pure
`wilsonInterval(failures, runs, z=1.96)` (Wilson score interval for a binomial proportion,
clamped to [0,1], degenerate-zero for zero runs — chosen over naive p̂=failures/runs, which
is overconfident at small n and collapses at the p̂=0/1 boundaries) + `classifyHistory`/
`classifyHistories` over per-test run histories → `FlakeVerdict {state, runs, passes,
failures, failureRate, wilson, flakeScore}`. Policy: a **mixed** history is `flaky` at any
run count (observed inconsistency = flaky); an all-pass/all-fail history is `reliable`/
`broken` only after it clears `minRuns` (default 5), else `insufficient-data`; empty →
`insufficient-data`. `flakeScore` = the Wilson lower bound of the failure rate — the
conservative, sample-size-aware magnitude the (later, operator-gated) quarantine slice
thresholds on. Pure/offline over a committed `run-history.json` fixture shaped like the
future private better-sqlite3 history store ({passed, at} runs; `at` ignored). No runtime
deps yet (better-sqlite3 arrives with the history-DB slice). **`@strummer/flake` is now
COMPLETE (engine + agent surface), slices 2–6:** slice 2 `HistoryStore` — the private
better-sqlite3 run-history DB (append-only `test_run` + `flake_meta`; record/history/
classify; a SECOND SQLite owner per ADR 0010, outside the docs-pillar invariant); slice 3
`parseVitestJson` + `ingestReport` — pure parser of a `vitest run --reporter=json` report
→ RecordedRuns (stable `<relFile> > <ancestorTitles>title` ids, skipped/pending/todo
dropped), over a committed real-shaped fixture; slice 4 `Quarantine` — the only WRITE
surface, paired deny-by-default gate adapted here (`allowQuarantine` + load-bearing
`maxExpiryMs`; expiry MANDATORY, refused past the cap, no permanent quarantine; reads/
`release` ungated + expiry-aware; pure `quarantineCandidates` proposes, never `broken`/
`reliable`); slice 5 `runAndRecord` — the gated vitest runner (spawn `--reporter=json`,
`repeat`×suite, record, classify; mirrors coverage's runScoped — paired `allowRun`+
`allowedRoots` gate, injected TestRunner so no real spawn in the gate); slice 6 the MCP
surface + `strummer-flake-mcp` bin (`flake_status`/`flake_candidates`/`flake_release`
always on; `flake_run` behind the run gate; `flake_quarantine` behind the quarantine gate;
bin requires `STRUMMER_FLAKE_DB` + the two independent paired gates). **`@strummer/mutate`
is now COMPLETE (engine + agent surface):** the **Stryker/Vitest-4 compat spike resolved
positively** (ADR 0010 update 2026-06-01 — vitest-runner 9.x declares `vitest >=2.0.0` +
ships Vitest 4/4.1 support, so thin-wrap is viable and Stryker stays an injected,
operator-spawned runner, NOT a gate dep); slice 1 pure `summarizeMutation` over the stable
mutation-testing-elements report schema (no `@stryker-mutator` import) → mutationScore
(detected/valid) + mutationScoreBasedOnCoveredCode + per-file metrics + an actionable
`survivors` list (Survived + NoCoverage — the complement to coverage's forgotten-assertion
catch); slice 2 the gated `runMutation` (spawn `stryker run --reporters json`, read,
summarize; paired `allowRun`+`allowedRoots` gate + injected MutationRunner so no real
Stryker in the gate; diff-scoped via `mutateFiles`→`--mutate` + `--incremental`) + the
`mutate_summarize`(free)/`mutate_run`(gated) MCP surface + `strummer-mutate-mcp` bin. With LSP
slices 1–2 (encoding/normalize + `client.ts`) now also landed, **618 TS + 45 Py green**.)_

**Phase 3 — Browser/UI testing pillar: FEATURE-COMPLETE.** _(Latest: **multi-engine**
(item 34, ADR 0009) — firefox/webkit support via `engine.ts` (`resolveEngine` +
`engineLauncher`/`engineLaunchOptions`); the injected-`launch()` `BrowserManager`
is unchanged (engine-agnostic), selection lives at the launch seam; bin
`STRUMMER_BROWSER_ENGINE`, CLI `--engine`. The SSRF proxy applies to every engine;
chromium-only hardening args stay chromium (firefox/webkit lean on the Tier-1 route
allowlist + proxy — chromium is the hardened default); Lighthouse perf stays
chromium. Verified end-to-end (firefox + webkit drive navigate→snapshot→click). On
top of **visual regression** (33), the **container-hardening ADR** (32),
**vision/coordinate caps** (31), and **video capture** (30). **Developer live-view
was DROPPED — headless only** (ADR 0008: LLM-first; trace/HAR/console/video answer
"what happened" better than watching pixels). Only the explicitly-aspirational
bucket remains — `@playwright/mcp` embed, autonomous self-healing, cross-pillar
contract tie-in.)_ The agent surface AND the human `strummer browser`
CLI both ship over the engine; the full gating bundle (downloads/uploads/dialog/
auth) is done, plus trace-query, browser assertions, Lighthouse perf,
**network heavy mode (HAR capture + replay)**, and **persisted `.bru` browser-step
flows**. Visual regression and multi-engine have since landed; Phase 3 is
feature-complete (only the explicitly-aspirational bucket remains). Design locked by a 5-stream
research workflow w/ adversarial verification (`docs/research/2026-05-31-pillar3-
browser-testing.md`); captured in **ADR 0006 (+ dated updates) + ARCHITECTURE §10
+ ROADMAP Phase 3**. A new pure-TS **`@strummer/browser`** built **thin on stable
`playwright-core` 1.60.0** (NOT a wrap of `@playwright/mcp`, which pins an alpha
core + inlines artifacts); ARIA-snapshot-first driving; artifacts by handle;
deny-by-default operator-set safety. Shipped slices (all TDD, real-chromium tested
against in-process fixtures):

1. a11y-audit summarizer + on-disk `ArtifactStore`.
2. `BrowserManager` (shared browser, ephemeral context/session, idle reaper, caps).
3. ARIA-snapshot capture + serializer — Strummer mints its own ref-ids over the
   public `ariaSnapshot()` YAML (1.60.0 lacks `_snapshotForAI`/snapshot-refs; ADR
   update 2026-06-01); token-capped diff + full-snapshot handle.
4. `PageDriver` step tools (navigate/click/fill/select/press/waitFor/snapshot +
   free reads) over generation-tagged refs.
5. `BrowserGate` deny-by-default action gate — navigation allowlist + mutation
   dry-run (one-shot route capture+abort) vs execute; operator-set.
6. Shared **`@strummer/safety`** (SSRF range classifier + `Redactor` moved from
   `api`) + Tier-1 `installSafetyRoutes` allowlist (allowlist-authoritative).
7. Tier-2 `createSsrfProxy` — loopback DNS-pinning forward proxy; `allowPrivate`
   opt-in for local-app testing (never link-local/metadata).
8. Dry-run preview redaction completeness (`url` + `postData`, slice 8a) + the
   **artifact-capture pipeline** `RunRecorder` (slice 8b): trace.zip / console /
   network by `strummer://browser/run/<id>/<kind>` handle with compact summaries;
   text channels redacted before write; per-channel enable flags.
9. **Engine hardening for the MCP surface (Milestone A, slices A1–A6)** — surfaced
   by a fan-out design+adversarial-review workflow (`browser-mcp-design`): snapshot
   redaction seam (secrets reflected in the DOM no longer leak into the snapshot/
   artifact), per-generation immutable artifact handles (no overwrite), bounded
   diff output, dry-run popup-block + `crossOriginEgress` flag, no-snapshot vs
   stale-ref error, `BrowserManager.onReap` flush hook.
10. **Browser MCP surface (Milestone B)** — `registerBrowserTools`/
   `createBrowserServer` (`packages/mcp/src/browser.ts`): 15 session-oriented tools
   over a surface session registry + per-session async mutex; server-minted UUID
   sessionId+runId (never agent input); reads redacted at the surface; reaper
   reconciliation via `manager.onReap` + `hasSession` eviction; the two-variable
   `strummer://browser/run/{runId}/{kind}` resource. No tool input can flip a
   safety flag.
11. **`strummer-browser-mcp` server bin (Milestone C)** — `bin-browser.ts`
   (`buildBrowserServerFromEnv`, exported + unit-tested): namespaced
   `STRUMMER_BROWSER_*` operator env with no api-var fallback; **mandatory**
   DNS-pinning SSRF proxy (no disable env) + Chromium `--proxy-bypass-list=
   <-loopback>` (loopback also traverses the proxy); trace-off-by-default; sandbox
   on by default (`--no-sandbox` opt-in); SIGINT/SIGTERM shutdown.

12. **Browser secret boundary — `{{secret:NAME}}` fill resolution** (`bffdf07`):
   `browser_fill`/`browser_fill_form` resolve `{{secret:NAME}}` to the operator
   secret server-side at the fill boundary (cleartext typed into the input, never
   in a tool arg or agent-visible result; redactor scrubs it everywhere); fails
   closed on an unknown name; the bin wires `resolveSecret` from the same
   `STRUMMER_BROWSER_SECRET_*` map as the redactor.
13. **Browser secret boundary — origin-scoped `httpCredentials`** (`4841fb2`):
   `BrowserManager` applies operator HTTP Basic creds (optionally origin-scoped) to
   every session context; bin parses `STRUMMER_BROWSER_HTTP_USERNAME/PASSWORD/
   ORIGIN`, registers the password with the redactor, and keeps it out of the
   config (config exposes `{username, origin}` only).
14. **Browser secret boundary — `storageState` by handle** (`24e47ff`):
   operator-gated `browser_save_storage_state` captures the context storageState to
   an operator-path artifact, returns a handle + cookie/origin counts (never
   inlined); the resource refuses the password-equivalent `storage-state` kind.
   Bin gates it behind `STRUMMER_BROWSER_ALLOW_STORAGE_STATE` (default off).
15. **Browser secret boundary — trace-internal redaction** (`acc6536`):
   `RunRecorder.stop` unzips the trace.zip (fflate), scrubs its text entries (JSONL
   metadata + DOM/sources snapshots), and re-zips before write; binary resources
   pass through. **ADR 0006 §6 secret boundary is now COMPLETE.**
16. **Browser hardening — `serviceWorkers:'block'` + WebRTC** (`9207224`):
   `BrowserManager` blocks service workers on every context (no SW cache/intercept
   bypassing the Tier-1 SSRF layer); the bin adds
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (WebRTC limited to
   proxied UDP — no P2P egress bypassing the SSRF proxy, no local-IP leak).
17. **Browser caps — session wall-clock + max-pages** (`f0fc419`):
   `BrowserManager` reaps a session past `maxSessionMs` (wall-clock, even when
   active) and closes pages opened beyond `maxPages` per context; bin-set via
   `STRUMMER_BROWSER_SESSION_MS`/`STRUMMER_BROWSER_MAX_PAGES`, default no cap.
18. **On-demand screenshot step tool — operator-gated:** `PageDriver.screenshot()`
   captures a PNG to the `ArtifactStore` under an immutable indexed handle
   (`screenshot-s<n>`), returns a summary (handle/byteSize/contentType/fullPage),
   never inlines the image, and does NOT re-snapshot (refs preserved). MCP
   `browser_screenshot` is **off by default** (`allowScreenshots`) — a screenshot
   is unredactable pixels, so it is gated like the trace.zip; the run-artifact
   resource serves PNGs as a base64 blob (`image/png` → binary). Bin-wired via
   `STRUMMER_BROWSER_ALLOW_SCREENSHOTS` (default off).
19. **Dialog gating — deny-by-default:** `PageDriver` installs a `page.on('dialog')`
   handler that **dismisses** alert/confirm/prompt/beforeunload by default (a
   `confirm` returns false, so a destructive flow gated behind it cannot proceed)
   and records each as a `DialogEvent {type, message(redacted), accepted}` drained
   onto the triggering step's `StepResult.dialogs`. Operator opt-in
   `BrowserGate.allowDialogs` flips to **accept**; bin-wired via
   `STRUMMER_BROWSER_ALLOW_DIALOGS` (default off). Registering the handler overrides
   Playwright's auto-dismiss, so the page never hangs.
20. **Download gating — deny + opt-in quarantine:** `BrowserManager` creates contexts
   with `acceptDownloads:false` by default (Playwright **cancels** every download —
   race-free deny). An operator quarantine dir (`STRUMMER_BROWSER_DOWNLOAD_DIR`)
   flips `acceptDownloads:true` and sets `PageDriver.downloadDir`; a started download
   is saved there under a **sanitized, indexed** name (`<n>-<basename>`, no traversal)
   and recorded as a `DownloadEvent {suggestedFilename(redacted), savedAs, byteSize,
   accepted}`. Surfaced by the race-free **`browser_downloads`** read tool
   (`collectDownloads(waitMs?)` awaits in-flight saves; optional bounded wait) —
   **metadata only, bytes never served** to the agent.
21. **Upload gating — confined to an operator allowlist dir:** `PageDriver.uploadFiles`
   (MCP `browser_upload`) sets files on a file-input ref but is **deny-by-default** —
   it requires an operator `uploadDir` and every requested path must resolve to
   within it (no `..` traversal, no absolute escape), throwing `GateError` otherwise.
   This is the exfiltration control: an agent cannot upload arbitrary local files
   (`~/.ssh/id_rsa`, `/etc/passwd`). Selecting a file makes no network request; the
   later submit is gated separately by the mutation gate. Bin-wired via
   `STRUMMER_BROWSER_UPLOAD_DIR` (unset ⇒ uploads denied). **The downloads/uploads/
   dialog/auth gating bundle is now COMPLETE** (auth = origin-scoped `httpCredentials`).
22. **Human `strummer browser` CLI:** `@strummer/cli` gains `browser snapshot|audit|
   screenshot <url>` (`packages/cli/src/browser.ts`) — single-shot page inspection
   over the engine (navigate once + read; per-snapshot refs needn't outlive the
   process). Reuses the bin's egress boundary: a gated `BrowserManager` + **mandatory**
   `createSsrfProxy` (`--proxy-bypass-list=<-loopback>` + WebRTC arg); the typed
   host is auto-allowed (explicit operator intent) plus `--allow-host`; flags
   `--allow-private`/`--no-sandbox`/`--headed`/`--json`/`--out`/`--full-page`.
   `audit` exits 1 on a11y violations (CI-usable). Real-chromium CLI tests.
23. **Browser assertions — one assertion engine across pillars.** Factored a shared
   **`@strummer/assert`** package (the pillar-agnostic operator core: `AssertionOp` +
   `applyOp`, moved out of `@strummer/api`, which now consumes it — behavior-preserving,
   mirroring the `@strummer/safety` extraction). `@strummer/browser` `assertions.ts` +
   `PageDriver.assert(specs)` evaluate declarative assertions against the live page:
   sources `url`/`title`/`ariaSnapshot` (page) + `text`/`value`/`visible`/`count`
   (element, by `ref` or `role`+`name`), each **auto-waiting** via a fast poll
   (count-gated probes; the loop owns waiting, never Playwright's default timeout) up
   to its timeout — so a condition that becomes true after an async update still
   passes. Observed string values are redacted; `pass` reflects the true (raw) value.
   MCP `browser_assert` tool (free read) returns `{pass, results}`.
24. **`browser_trace_query` — trace.zip → action timeline.** `@strummer/browser`
   `trace.ts`/`queryTrace(zip, opts)` parses a captured Playwright trace.zip's `.trace`
   **JSONL directly** (no `npx playwright trace` subprocess — its `open` is a GUI
   viewer and there are NO `console`/`network`/`errors` subcommands; those live inside
   the trace). Pairs `before`/`after` events by `callId` into an **action timeline**
   (`api` = `class.method`, timing, error, optional params) + console + an errors list
   + `{playwrightVersion, browserName}`; filters `apiFilter`/`errorsOnly`/`limit`/
   `includeParams`. MCP `browser_trace_query` resolves the stored (already-redacted)
   trace by `runId` — **no live session needed** (query after close); errors actionably
   when trace capture was off. Schema probed against the 1.60.0 pin.
25. **`browser_perf_audit` — Lighthouse perf over the node API.** `@strummer/browser`
   `perf.ts`/`auditPerf(url, opts)` runs **Lighthouse 13.3.0** (`onlyCategories:
   ['performance']`) by launching its own Chrome via **`chrome-launcher`** at the
   operator chromium path + **operator-supplied flags** (the bin passes the mandatory
   SSRF proxy + loopback-bypass + WebRTC arg, so Lighthouse's navigation traverses the
   same egress boundary). Returns `{performanceScore, metrics[FCP/LCP/TBT/CLS/SI/TTI],
   lighthouseVersion}`; the full LHR **JSON + HTML** reports are stored by handle
   (`perf` / `perf-html`), **redacted before write**. MCP `browser_perf_audit` is
   standalone (mints its own `runId`, no session), **allowlist-gated** at the surface
   (`gate.checkNavigation`); the bin binds the real audit closure (absent ⇒ "not
   enabled"). Per ADR 0006 callers assert metric **shape/thresholds, never exact
   scores**. Feasibility + LHR shape probed against the pin.

26. **Network heavy mode — HAR capture** (`a6ead53` + `c6a5303`). New
   `@strummer/browser` `har.ts`: `finalizeHar` reads the HAR `.zip` Playwright
   writes on context close, redacts every text entry (`.har` JSON + persisted text
   bodies, via fflate) BEFORE surfacing, stores by
   `strummer://browser/run/<id>/har` handle, returns a compact summary
   (entryCount/byStatus/byMethod/byteSize), and removes the raw staged file.
   `BrowserManager` gains operator `harDir` → `recordHar` (content:'attach',
   mode:'full') at newContext, plus an **`onClosed`** hook firing AFTER
   `context.close()` (HAR is only on disk post-close — opposite timing to the
   recorder's `onReap`); shutdown fires it too. MCP surface: `onReap` now only
   flushes the recorder, `onClosed` finalizes the HAR + does registry cleanup, so
   the explicit close, idle reaper, and shutdown all finalize (no unredacted HAR
   lingers); `browser_close_session` surfaces the `har` handle/summary. Bin:
   `STRUMMER_BROWSER_HAR_DIR`. HAR is a heavy secret surface (registered-secret
   redaction only) so capture is operator-gated **off** by default, like the trace.
27. **Network heavy mode — HAR replay** (`ca88685`). `PageDriver.replayFromHar`
   arms `page.routeFromHAR(notFound:'abort')` so a session is served from a recorded
   HAR instead of the network — deterministic offline runs, zero egress (unmatched
   requests aborted). **Deny-by-default**: requires an operator replay dir and the
   HAR must resolve within it (reuses `uploadFiles`' path confinement). MCP
   `browser_replay_har` (call before navigate). Bin:
   `STRUMMER_BROWSER_REPLAY_HAR_DIR`. Real-chromium proof: record a HAR, shut the
   server down, replay → page still loads from the HAR. **Network heavy mode is now
   COMPLETE.**

28. **Persisted `.bru` browser-step flows** (`227263a`/`d7ad2a4`/`e23427e`; mirrors
   ADR 0004). New `@strummer/browser` `flow.ts`: a Bruno-openable `<name>.bru`
   (meta) + `<name>.strummer.yml` sidecar holding ordered `steps`, keyed by
   `SemanticLocator {role,name?,nth?}` (NOT ephemeral refs, so a flow is stable
   across runs). `loadFlow`/`loadFlowCollection` parse + validate (fail-loud);
   `runFlow(driver, flow, opts)` replays sequentially with `{{var}}` interpolation +
   fail-closed `{{secret:NAME}}` resolution (driver redactor scrubs cleartext;
   assert expected-values get vars only, never secrets — no cleartext `expected`
   leak). A step that throws stops the flow `ok:false`; a failed assertion fails the
   flow but continues. PageDriver gained semantic-locator action methods
   (`clickAt`/`fillAt`/`selectAt`/`pressAt`) driving via `getByRole` directly,
   reusing the same mutation gate; factored a shared `locatorFor()`; `waitFor` takes
   `nth`. Surfaced by **`strummer browser run <flow.bru>`** (`@strummer/cli`,
   --var/--unsafe/--allow-host/--json, exit-nonzero on failure, env-secret redaction)
   + bundled `examples/browser/login/` with an offline guard test.

29. **MCP `browser_run_flow` + `browser_list_flows`** (the deferred flow follow-up,
   so the agent surface reaches parity with `strummer browser run`). The agent passes
   a flow **name** (resolved against `loadFlowCollection(flowsDir)` — a Map-key lookup,
   so there is NO caller-supplied path / traversal surface) + non-secret `{{var}}`s;
   the flow replays on the named session's gated `PageDriver` behind the per-session
   mutex, so it composes with `browser_replay_har`/artifacts/close. `{{secret:NAME}}`
   resolves from the operator secret store (fail-closed); the driver redacts surfaced
   values and the surface additionally redacts step `error` strings. Deny-by-default:
   no operator flows dir ⇒ both tools report "not enabled". Bin: `STRUMMER_BROWSER_
   FLOWS_DIR`. (TDD, real-chromium against the in-process fixture.) Both surfaces are
   documented side-by-side in `examples/browser/README.md` (CLI `strummer browser run`
   + the MCP `browser_list_flows`→`browser_run_flow` sequence over the login example).

30. **Video capture (webm) — operator-gated.** New `@strummer/browser` `video.ts`:
   `finalizeVideo` reads the `.webm` Playwright writes on context close, stores it by
   `strummer://browser/run/<id>/video` handle (NO redaction — video is unredactable
   pixels, so it is gated **off** by default like the trace/screenshots), returns a
   compact summary (`byteSize`/`video/webm`), and removes the temp recording.
   `BrowserManager` gains `videoDir`/`videoSize` → `recordVideo:{dir,size?}` per
   context; the MCP surface finalizes the video in the **same `onClosed` hook as the
   HAR** (resolved via `page.video().path()`, since Playwright auto-names the file —
   the HAR's deterministic `harPathFor` has no video analogue) and surfaces the
   `video` handle in `browser_close_session`; the run-artifact resource serves
   `video/*` as a base64 blob. Bin: `STRUMMER_BROWSER_VIDEO_DIR` (+ `_VIDEO_WIDTH`/
   `_HEIGHT` size cap; the session wall-clock cap bounds duration). Real-chromium
   tested (asserts the EBML/webm container magic). **ffmpeg is present in the cache**
   (Playwright needs it for video). Operator enablement + the on-close `video` handle
   are documented in `examples/browser/README.md` ("Recording the run as video").

31. **Vision/coordinate caps — operator-gated.** `PageDriver.mouseClick(x,y)` /
   `mouseMove(x,y)` drive the raw pointer at a viewport CSS-pixel coordinate, for
   canvas / non-AX-tree UI the ARIA-snapshot path can't reach (coords come from a
   screenshot). `mouseClick` is a **mutation routed through the existing gate**
   (dry-run vs execute — distinct method name from the semantic-locator `clickAt`);
   `mouseMove` is non-mutating positioning (hover egress still governed by the
   always-on Tier-1 routes + SSRF proxy). MCP `browser_vision_click`/
   `browser_vision_move` are **off by default** (`allowVision`) — a blind click on a
   *point* sidesteps the accessible-tree safety story, so it is an explicit operator
   opt-in, **decoupled from `allowScreenshots`** (read-only pixels out vs blind input
   in). Bin: `STRUMMER_BROWSER_ALLOW_VISION`. Real-chromium tested via a
   document-level coordinate recorder (execute lands the coord; locked gate ⇒ dryRun).

32. **Container-hardening ADR — `docs/decisions/0007-container-hardening.md`.**
   The deployment-security posture (the container/kernel boundary **behind** the
   in-process spine, for when a renderer RCE bypasses the documented-API defenses):
   keep the Chromium sandbox by default, resolving the sandbox-in-container tension
   via **unprivileged user namespaces** (so **no `SYS_ADMIN`**; `--no-sandbox` only a
   documented operator fallback); non-root + no-new-privileges; `cap_drop: ALL`; a
   default-derived **seccomp** profile pinned to the Playwright image; read-only
   rootfs + minimal tmpfs/volume mounts (incl. the `/dev/shm` footgun — `--shm-size`,
   **not** `--ipc=host`); **WebRTC + QUIC disabled**; container-level **egress
   firewalling** as defense-in-depth behind the SSRF proxy (metadata unreachable). A
   threat→boundary table maps each risk across the two layers. A **design doc** (no
   code/tests) — extends ADR 0006 §7's one-liner; referenced from ARCHITECTURE §10 +
   ROADMAP. The dev harness (`docker/`) stays separate (gitignored).

33. **Visual regression — `compareScreenshots` engine + `browser_visual_compare`.**
   `@strummer/browser` `visual.ts` (pixelmatch 7.2.0 + pngjs 7.0.0): a **pure,
   deterministic** pixel diff — diff count/ratio, `maxDiffPixelRatio`/`maxDiffPixels`
   budget, pixel-rect `mask[]` (dynamic regions), size-mismatch hard-fail, diff PNG.
   `PageDriver.screenshot()` gained stable-capture options (`animations:'disabled'`/
   `caret:'hide'`/`clip`). MCP `browser_visual_compare` (operator `baselineDir`,
   **deny-by-default**): captures the current page, diffs vs `<name>.png`, stores the
   diff PNG by `visual-diff-s<n>` handle on mismatch; `update:true` records a baseline
   (**separately** operator-gated `allowBaselineUpdate` — an agent can't rewrite the
   golden). Bin: `STRUMMER_BROWSER_BASELINE_DIR` + `_ALLOW_BASELINE_UPDATE`. The
   flake-prone part — **committing** cross-platform baselines — is deferred (operator-
   managed, generated in the pinned Docker image keyed by name/browser/platform), so
   the green gate stays deterministic: tested with in-memory PNGs + a real-chromium
   **self-captured** baseline (nothing committed to the repo).

34. **Multi-engine (firefox/webkit) — operator-selected.** New `@strummer/browser`
   `engine.ts`: `resolveEngine` (default chromium, throws loud on a typo) +
   `engineLauncher`/`engineLaunchOptions`. The injected-`launch()` `BrowserManager`
   is unchanged (already engine-agnostic) — selection lives only at the launch seam.
   The Tier-2 SSRF **proxy applies to all engines** (`proxy.server`); the
   **chromium-only** hardening CLI args (`--proxy-bypass-list=<-loopback>`,
   `--force-webrtc-ip-handling-policy`, `--no-sandbox`) are emitted **only for
   chromium** (firefox/webkit reject them) — those engines lean on the always-on
   **Tier-1 route allowlist** + the proxy, so chromium stays the hardened default.
   Bin `STRUMMER_BROWSER_ENGINE` (resolved early, before the proxy is allocated;
   `config.engine` + per-engine `launchArgs`); CLI `--engine chromium|firefox|webkit`
   (unknown ⇒ clean exit-1). **Lighthouse perf stays chromium** (Chrome-only),
   whatever the session engine. One engine per server instance. Cross-engine probe
   confirmed `serviceWorkers:'block'`/`httpCredentials`/`route`/`ariaSnapshot` are
   identical on firefox/webkit (manager + driver needed no changes). TDD: engine
   unit tests + a **real cross-engine** test driving navigate→snapshot→click→
   re-snapshot on firefox AND webkit (`skipIf` the binary is absent → chromium-only
   envs stay green); bin/CLI wiring tests. CI + the dev image install all three
   engines. (ADR 0009.)

**(Point-in-time at Phase-3 close: 390 TS + 45 Py green; the authoritative current
count is the one in the Phase-4 current-phase block at the top of this file.)** _(Latest milestone:
**multi-engine** (item 34, ADR 0009) — firefox/webkit support landed; Phase 3 is
now FEATURE-COMPLETE. On top of **Pillar 2 fully COMPLETE** (request-body matrix +
keyring wiring, SSRF range-block + redirect re-check, contract reach, import).
**Developer live-view was DROPPED** (ADR 0008, headless-only/LLM-first).)_
**Next action:** Phase 4 is underway (ADR 0010). `@strummer/deps` slices 1–4 (pure core:
`auditDeprecation`, `matchVulnerabilities`, `loadOsvSnapshot`, `auditDependency`) **and
slice 5 (the agent surface)** are landed: `audit_dependency` + `audit_project` MCP tools
(`packages/mcp/src/deps.ts`) + the `strummer-deps-mcp` bin (`bin-deps.ts`, namespaced
`STRUMMER_DEPS_*`, network off by default, SSRF-pinned packument fetch via
`@strummer/safety` `resolveAndPin` — **note:** `assertSsrfAllowed` does NOT exist on
`safety`, only in the api package). **The shared `@strummer/artifacts` extraction is now
DONE** (parameterized `strummer://<prefix>/<id>/<kind>`; browser rewired as a thin
subclass, behavior-preserving), **and `changelog_diff` (the first handle-emitting deps
slice) is DONE**: pure `sliceChangelog` core + the `changelog_diff` MCP tool (injected
fetcher → slice → store by handle in `@strummer/artifacts` `deps` prefix → compact
summary) + the `strummer://deps/{id}/{kind}` resource + bin wiring
(`STRUMMER_DEPS_ARTIFACT_DIR` + SSRF-pinned GitHub-raw CHANGELOG fetch), **and by-handle
full `audit_project` detail is DONE** (`detailHandle` → the `strummer://deps` resource),
**and the vuln-aware `minimumSafeUpgrade` target is DONE** (`auditDependency.minimumSafeUpgrade`:
lowest stable release newer than installed that re-matches ZERO advisories — re-evaluated
per candidate against the full set, so a release fixing the original vuln but hit by another
is skipped; distinct from the conservative same-major `recommendedTarget`; surfaced in
`audit_dependency` + the `audit_project` roll-up), **and the `behindBy` freshness metric is
DONE** (`FreshnessVerdict.behindBy`: upgrade distance by semver component), **and
CVSS-vector → bucket scoring is DONE** (pure `cvssV3BaseScore`; `matchVulnerabilities`
falls back to the CVSS vector's bucket when no qualitative GHSA string is present).
**Next for deps:** the staged **Python/PyPI + RubyGems advisory adapters** (the non-npm
ecosystems — `audit_project` is npm-only today; `detectInstalledVersion` already dispatches
by ecosystem). **Track A `@strummer/coverage` is open** — slices 1–3 landed (`uncoveredNewLines` differ,
`parseUnifiedDiff`, and the `uncoveredInDiff` integrator) — **the pure offline core of the
forgotten-assertion catch is complete**, **the live `runScoped` engine (slice 4)
landed**, **and the MCP surface + `strummer-coverage-mcp` bin landed** — so **the
`@strummer/coverage` pillar (engine + agent surface) is complete** (`uncovered_in_diff`
free/read-only + gated `run_scoped`). **Next for deps/coverage:** the staged
**Python/PyPI + RubyGems advisory adapters** (deps) and, optionally, a `strummer coverage`
human CLI / `istanbul-lib-coverage` for `CoverageMap` merging. **`@strummer/flake` is now
COMPLETE (engine + agent surface)** — the pure Wilson classifier (slice 1) + the private
better-sqlite3 `HistoryStore` (slice 2) + `parseVitestJson`/`ingestReport` (slice 3) + the
operator-gated `Quarantine` with mandatory expiry (slice 4) + the gated `runAndRecord`
vitest spawner (slice 5) + the MCP surface/`strummer-flake-mcp` bin (slice 6:
`flake_status`/`flake_candidates`/`flake_release` always on, `flake_run` + `flake_quarantine`
each behind their own paired gate). **`@strummer/mutate` is now COMPLETE (engine + agent
surface)** — the Stryker/Vitest-4 spike resolved (thin-wrap viable; Stryker injected, not a
gate dep), pure `summarizeMutation` over the mutation-testing-elements schema, the gated
diff-scoped `runMutation` (spawn `stryker run`), and the `mutate_summarize`/`mutate_run` MCP
surface + `strummer-mutate-mcp` bin.

**LAST Phase-4 candidate: `@strummer/lsp` — semantic code navigation. DESIGN DONE (ADR
0011); coding NOT started.** The design pass ran as the `lsp-bridge-design` fan-out (3
research streams → synthesis → 2 adversarial critics — the adversarial pass materially
reshaped it, ADR-0010 style). Locked decisions (full detail in **ADR 0011**): it is the
**documented, fenced exception** to ARCHITECTURE §1's no-live-RPC rule (the LSP subprocess
must never touch the docs SQLite; results ephemeral); the right analogy is the **browser
subprocess** (resident, code-executing → runs inside the ADR-0007 hardened container), NOT
the test-runner — `allowRun`+`allowedRoots` is load-bearing *because indexing executes
project code*; the **operator binds a JSON `language→{command,args[]}` registry**, the agent
picks only a *language*; **v1 reads-only**; the green gate uses a **fake in-process JSON-RPC
peer replaying recorded real-server payloads** (no real server in `pnpm gate` — a deliberate,
stricter posture than coverage/flake/mutate). The adversarial pass forced these into the
design: **position-encoding is the #1 silent-wrong trap** (a pure `toLspCharacter` for
utf-8/16/32 with non-BMP fixture tests; read back the negotiated `positionEncoding`, fail
loud on unsupported); **tri-state results** (ok / not_ready / no_result — never collapse
"still indexing" into "no definition"), one operator deadline with `$/progress`-gated retry
inside it; a **per-(server,uri) mutex** + open-once/refcount docs + in-flight-aware reaper;
**`serverInfo.version` provenance + v1 warn-on-toolchain-mismatch** (honoring "answer for the
installed version"); `vscode-jsonrpc` + `vscode-languageserver-protocol` as **explicit pins**
(the playwright-core pattern, not a hand-roll); **MVP = `lsp_find_definition`/
`lsp_find_references`/`lsp_hover`** (hover restored, call-hierarchy staged behind capability
detection). **`@strummer/lsp` slice 1 is LANDED:** the pure `encoding.ts`
(`toLspCharacter`/`fromLspCharacter` for utf-8/16/32 with non-BMP fixtures + cross-encoding
round-trip; `resolvePositionEncoding` fail-loud-on-unsupported; `toLspPosition`/
`fromLspPosition` with LF/CR/CRLF split + BOM strip) + `normalize.ts` (`normalizeLocations`
Location-vs-LocationLink, `normalizeHover`, `normalizeDocumentSymbols` hierarchical-vs-flat,
tri-state `decideStatus`) — no spawn/network, 31 tests, 605 TS + 45 Py green. **Slice 2 is
LANDED:** `client.ts` — the LSP JSON-RPC client over an injected `serverSpawn` seam
(`defaultServerSpawn` = real `child_process.spawn`). Handshake advertises
`positionEncodings:["utf-16","utf-8"]` → reads back the negotiated `positionEncoding`
(absent ⇒ spec-default utf-16) + `serverInfo` provenance + capabilities; sends `initialized`;
`ensureOpen` does `didOpen` full-text once, refcounted, **no `didClose` by default**;
navigation requests (`definition`/`references`/`hover`) are **capability-gated** (`LspUnsupportedError`)
and **tri-state** — empty-while-`$/progress`-indexing ⇒ `not_ready` (returned fast), empty-while-ready
⇒ `no_result`, with bounded backoff retry living strictly **inside the single operator deadline**
via the **injected clock** (`now`/`delay`; production never calls `setTimeout` directly except the
default `delay` seam); deadlock-safe `null` replies to inbound `workspace/configuration` (array of
null) / `window/workDoneProgress/create` / `client/{register,unregister}Capability`; results carry
`{serverInfo, encoding}`. `vscode-jsonrpc ^8.2.1` + `vscode-languageserver-protocol ^3.17.5` added
as **explicit pins** (method names via the protocol package's `*Request.method` constants; transport
imported from `vscode-jsonrpc/node.js` — the explicit `.js` subpath NodeNext-ESM requires for a
CJS-without-`exports` dep). Tested against a **fake in-process JSON-RPC peer** (paired
`PassThrough` duplex streams à la vscode-jsonrpc's TestDuplex) replaying **RECORDED real-server
payloads** captured out-of-gate from `typescript-language-server` 5.3.0 (definition returned as
a real `LocationLink[]`, references as `Location[]`, hover as `MarkupContent`, a genuine indexing
`$/progress` begin/end pair; provenance in `test/fixtures/README.md`). 13 client tests, **618 TS +
45 Py green**. **Next action: code ADR-0011 slice 3 — `manager.ts` + `registry.ts`**
(`LanguageServerManager` keyed by `(language, projectRoot)`, shared across MCP sessions, longer
idle TTL than browser's; **per-`(server, uri)` async mutex** serializing the open+query critical
section; in-flight-aware reaper that never reaps `inFlight > 0`, sends LSP `shutdown`→`exit` with a
clock-driven grace before `dispose()`; `rootUri`/`workspaceFolders` pinned to the allowlisted root;
the operator-bound JSON `language→{command,args[],initializationOptions}` registry). Then gated
`query.ts` (`lspQuery` mirroring `runScoped` — `LspGateError`/`assertAllowed`/deadline/injected
spawn) → MCP surface + `strummer-lsp-mcp` bin. **Phase-4 staged tails** (not blocking LSP): deps PyPI/RubyGems
adapters; coverage `strummer coverage` CLI / `istanbul-lib-coverage` merging; flake Python
(pytest-json) adapter; mutate Python (mutmut/cosmic-ray) adapter + a `strummer mutate` CLI.
Phase 3
has no remaining required tail — only the explicitly-aspirational bucket
(`@playwright/mcp` embed, autonomous self-healing, cross-pillar contract tie-in). The
deferred `browser_run_flow`
follow-up (item 29), **video capture** (item 30), **vision/coordinate caps** (item
31), the **container-hardening ADR** (item 32, ADR 0007), and **visual regression**
(item 33) are now done. See the detailed "Next action" section below + ROADMAP.

**Phase 2 — Web API testing pillar: core deliverables COMPLETE** (engine +
contract validation + MCP tools + CLI all shipped & CI-gated; only optional tail
items remain). **Pillar 1 (docs/idioms) is functionally complete _and all its
deferred polish is done_** (non-Node version detection, TOC-bleed/symbol
ingestion refinements, Dash docset adapter). Pillar 2 design is locked (ADR 0004
+ 0005 + ARCHITECTURE §9, grounded by a 4-stream research workflow archived in
`docs/research/2026-05-31-pillar2-api-testing.md`).

**`@strummer/api` so far (TDD, offline tests):**
- Loads Bruno `.bru` + `*.strummer.yml` sidecar; var interpolation; **undici**
  runner; declarative assertions (status/jsonpath/header); body by
  `strummer://run/<id>/body` handle.
- **Secrets:** `{{secret:NAME}}` resolved at the transport boundary from a
  `SecretStore` (`StaticSecretStore`/`EnvSecretStore`/`KeyringSecretStore`-lazy/
  `ChainedSecretStore`); **fails closed** on a missing secret; a `Redactor`
  scrubs values + base64/url encodings from request/headers/body before anything
  reaches the agent.
- **Mutation safety:** GET/HEAD/OPTIONS run; POST/PUT/PATCH/DELETE **dry-run** by
  default and only send with `allowUnsafe` + a host allowlist (`checkGate`).
- **Captures + chaining:** sidecar `captures` extract values from a response
  (`extractCaptures`); `runSequence` threads them into later requests' scope.
- **Request bodies (full matrix):** `.bru` `body:json/text/xml/sparql` (raw),
  `form-urlencoded`, **graphql** (`{query, variables}` JSON envelope — variables
  interpolated then JSON-parsed; empty block omitted), **multipart-form** (text +
  file parts via undici `FormData`, file bytes read from disk, undici mints the
  boundary), and **file** (raw bytes under the declared content-type). All sent
  via undici; vars/secrets interpolated in every part; the agent-facing preview
  summarizes file/binary parts by name + byte size (never inlines bytes) and is
  redacted. File paths resolve against the collection dir (operator-authored
  config; egress separately gated, so not sandboxed). _(Closed a latent graphql
  gap + an uncaught `formUrlEncoded`/`multipartForm` camelCase-discriminator
  regression via an alias map; `PreparedBody.content` is now
  `string | Buffer | FormData` with a separate redaction-safe `preview`.)_
- **Environments:** `environments/<Env>.bru` loaded into `collection.environments`;
  `runRequest`/`runSequence` take `env` (lowest precedence; runtime vars win).
- **Scripts (QuickJS sandbox):** sidecar `preScript`/`postScript` run in a WASM
  isolate (`quickjs-emscripten`, 1s interrupt) with a curated `bru`/`expect`/
  `test`/`console` API — data crosses the boundary only as JSON (no host
  bindings). Pre-script sets vars used in interpolation; post-script sees `res`,
  records `scriptTests` (redacted), and `bru.setVar` feeds captures/chaining.
- **Contract validation (ADR 0005, ajv-direct not openapi-backend):** the
  `schema` assertion source validates a body (or jsonpath subtree) against an
  inline JSON Schema via **ajv 2020-12** (`schema.ts`/`validateSchema`).
  `validateOpenApiResponse` matches path-template + status (incl. `2XX`/`2xx`
  ranges + `default`) and validates the body against the **OpenAPI 3.1** response
  schema (local `#/components/schemas` `$ref`s rewritten into `$defs`); surfaces
  drift as `missing-operation`/`undocumented-status`/`response-schema` findings.
  `validateGraphqlOperation` (graphql-js) catches query-vs-schema drift incl.
  missing root types, plus response `errors`. Shared `ContractResult`/
  `ContractFinding`. Adversarially verified (3 bugs found + fixed: lowercase
  `2xx`, `$defs` clobber, mutation/subscription drift miss).
- **MCP tools + CLI commands (fan-out, two independent surfaces over the
  engine):**
  - **MCP** (`@strummer/mcp` `registerApiTools`/`createApiServer`, new
    `strummer-api-mcp` bin): tools `list_requests`, `get_request` (reports
    required secret **names** only, never values), `run_request`, `run_collection`,
    `validate_response` (OpenAPI or GraphQL), + `strummer://run/{runId}/body`
    resource over a shared `ArtifactStore`. **`allowUnsafe`/`allowedHosts` are
    operator-set via `ApiToolsOptions` (env on the bin), never agent inputs** —
    the safety gate can't be self-authorized.
  - **CLI** (`strummer api …`): `list`, `get`, `run` (`--var k=v`, `--env`,
    `--unsafe`, `--allow-host`, `--openapi <spec>` for live response validation,
    `--json`), `run-collection` (`--stop-on-failure`), `validate --graphql
    <schema> --query <q>` (offline drift). Exit 0 only when sent + assertions
    pass (+ contract valid when checked).
- A runnable sample collection (`examples/api/jsonplaceholder`) + an API-testing
  quickstart in `packages/cli/README.md`; an offline guard test keeps the sample
  in sync with the `.bru` format.
- **127 TS + 45 Py tests** (1 skipped real-embed), all green. Contract validators
  adversarially verified; both API bins smoke-tested end-to-end.

**Pillar 2 tail: COMPLETE.** All previously-deferred items have landed:
- **Keyring** secret store wired into both surfaces (CLI `--keyring`, MCP
  `STRUMMER_KEYRING`; chains the OS keyring ahead of `STRUMMER_SECRET_<NAME>`).
- **SSRF range-block** on every request (`assertSsrfAllowed` via `@strummer/safety`
  `resolveAndPin`; metadata/link-local always refused, loopback/private gated by
  `allowPrivate` — default permissive, `STRUMMER_BLOCK_PRIVATE` / `--block-private`
  to harden) **+ opt-in redirect following** (`maxRedirects`) re-checking SSRF +
  the mutation allowlist + stripping credential headers on a host change.
- **Contract reach** (ADR 0005): external local-file `$ref` deref (JSON+YAML,
  cycle-guarded; remote http stays out — SSRF), OpenAPI 3.0 `nullable` shim,
  `operationName`-scoped GraphQL.
- **Import**: Postman/Insomnia/OpenAPI/HAR → `.bru` (`import.ts`, native + CLI
  `api import`). The only remaining body types are the request-body matrix, which
  is also COMPLETE (graphql/multipart-form/file; form-urlencoded regression fixed).

Remaining ADR-0005-documented out-of-scope (not blocking): remote (http) `$ref`
deref; non-schema `$ref`s; ajv `strict:false`. Import defers multipart/file
bodies + non-header auth.

Decided (ADR 0004): new pure-TS **`@strummer/api`** package; **Bruno `.bru`** +
thin model (via `@usebruno/lang`); Strummer assertions/captures in a **sidecar
`*.strummer.yml`**; **deny-by-default** mutation safety (dry-run + allowlist +
`--unsafe`); secrets via `@napi-rs/keyring` + env fallback, value-redacted;
**QuickJS-sandboxed** JS scripts in v1. Engine: **undici 8**.

## Milestone log (historical)

> Pillar-by-pillar history. The **authoritative current state + test counts** are
> in the top block above; test counts in these bullets are point-in-time.

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
- **Hybrid search shipped:** `core.searchDocs` fuses FTS5/bm25 with `sqlite-vec`
  KNN via reciprocal rank fusion (optional `queryVector`). The MCP server embeds
  queries in-process with transformers.js (`Xenova/bge-small-en-v1.5`), which
  reproduces the Python-`fastembed` vectors exactly (cosine 1.0, ADR 0003) — so
  the server stays a self-contained Node process, no Python at serve time.
  Verified on the real index: `useState` now ranks the useState hook #1; pure
  semantic queries ("share state between components") hit the right guide.
- **Version-pinning shipped:** `core.resolveVersion` (semver; exact →
  nearest-same-major → refuse, never silently wrong) + `listVersions`. The
  ingester `build --append` puts multiple versions in one index; the real
  `data/react.sqlite` now holds **19.2 + 18.3.1 + 17.0.2** (2,905 fragments).
  `search_docs` takes `installed` (version/range) → resolves → filters and
  reports `resolvedVersion`/`versionNote`; new `list_versions` tool. Verified:
  installed `^18.2.0` → React 18.3.1 docs; `16.8.0` → flagged, not silently 19.x.
- **Auto-detect installed version shipped:** `core.detectInstalledVersion`
  (node_modules → package-lock.json → package.json range; works for npm/pnpm/
  yarn). New `detect_version` MCP tool; `search_docs` gains a `project` input
  (precedence version > installed > project). Verified end to end: pointing at a
  project with React 18 installed, with no version supplied, returns React
  18.3.1 docs.
- **`@strummer/cli` shipped:** `strummer search|get|versions|detect` over `core`
  (hybrid via `@strummer/embed`, `--json`, version flags). The query embedder was
  extracted into **`@strummer/embed`** (transformers.js, dynamic import) shared
  by cli + mcp.
- **CI gate:** `.github/workflows/ci.yml` mirrors `pnpm gate` (both toolchains)
  on push/PR.
- Dev container provisions pnpm + uv. **39 TS + 36 Py tests** (1 skipped real
  embed), all green. **Pillar 1 (docs/idioms) is functionally complete.**

## Next action

**Phase 3, Slice 1 (a11y-audit summarizer): DONE & committed** (`@strummer/browser`
scaffolded; `ArtifactStore`/`summarizeA11y`/`auditA11y`, TDD against an offline
fixture + real headless Chromium; CI + docker harness provision Chromium). The
slice deliberately deferred visual baselines + Lighthouse scores (the flaky parts).

**Slice 2 (browser lifecycle manager): DONE.** `BrowserManager` — lazy single
shared browser, ephemeral isolated context per session, `maxContexts` cap,
idle-TTL `sweepIdle` + `startReaper`, per-context default timeouts,
`closeSession`/`shutdown`. (Fake browser + deterministic clock + real-chromium
integration.)

**Slice 3 (ARIA-snapshot capture + serializer): DONE.** `snapshot.ts` —
`buildSnapshot`/`captureSnapshot`/`diffSnapshots`. NOTE the empirical revision of
the ADR open fork: `playwright-core` 1.60.0 has **no** `_snapshotForAI` and **no**
ref-ids in `ariaSnapshot()`, so Strummer parses the public `ariaSnapshot()` YAML
and **mints its own ref-ids** → semantic-locator descriptors `{role,name,nth}`
(per-snapshot, non-persisted), token-capped serialize + full-snapshot handle +
ref-independent diff. (See ADR 0006 update 2026-06-01.)

**Slice 4 (imperative step tools): DONE.** `PageDriver` (`driver.ts`) — navigate,
click, fill, fillForm, selectOption, press, waitFor, snapshot, and free reads
(getText/getValue/getAttribute). Refs resolve via the snapshot descriptors to
`getByRole(role,{name}).nth(n)` with auto-waiting; each navigating/mutating step
re-captures under a new snapshot **generation** (refs like `s2e3`) and returns a
scoped diff + capped snapshot + handle, so a stale ref from an earlier snapshot
**fails loudly** instead of matching a different element. Real-chromium tested
against an in-process fixture (fill/click/select/press/wait_for/stale-ref).
**155 TS + 45 Py green.**

This completes a usable interaction unit (lifecycle + snapshot + step tools) —
slices 2–4 pushed to `main`.

**Slice 5 (deny-by-default action gate): DONE.** `BrowserGate` (`gate.ts`,
operator-set `{allowUnsafe, allowedHosts}`) + `PageDriver` wiring: reads free;
`navigate` gated by host allowlist (`checkNavigation` → `GateError`); mutating
interactions (click/fill/fillForm/selectOption/press) **dry-run by default** — a
one-shot `page.route` captures + aborts the first would-be request and returns a
`{dryRun, wouldRequest}` preview — and **execute** only with `allowUnsafe` + an
allowlisted current host (hard-deny otherwise). Gate omitted ⇒ raw ungated layer
(the MCP surface always supplies one). Pure policy tests + chromium integration
(navigate allow/deny, dry-run captures+blocks a POST, execute sends it). **161 TS
+ 45 Py green.** Committed to `main`; **not yet pushed** — push after the SSRF
slice rounds out the safety story.

**Slice 6 (`@strummer/safety` + Tier-1 SSRF): DONE.** New shared **`@strummer/safety`**
package (factored per ADR 0006): SSRF range classifier (`isBlockedIp`/
`isBlockedHost`/`isBlockedHostLiteral` via `ipaddr.js`, fail-closed) +
`resolveAndPin` (DNS resolve → refuse blocked range → pinned IP, the Tier-2
decision core) + the `Redactor` (moved from `@strummer/api`, re-exported there —
behavior-preserving). **Tier-1** `installSafetyRoutes` (deny-by-default
`browserContext.route`, wired into `BrowserManager` when a gate is set) governs
every request and is **allowlist-authoritative** (ADR 0006 update 2026-06-01:
literals blocked by deny-by-default rather than unconditionally, so localhost
apps stay testable). **174 TS + 45 Py green.** Committed to `main`; the
`@strummer/safety` extraction (77c7ff7) + Tier-1 are being pushed together as the
milestone.

**Slice 7 (Tier-2 DNS-pinning SSRF proxy): DONE.** `createSsrfProxy`
(`proxy.ts`) — a loopback forward proxy (HTTP absolute-form + HTTPS `CONNECT`)
passed as Chromium's `proxy.server`; calls `@strummer/safety` `resolveAndPin` per
request/CONNECT (resolve once → refuse blocked range → connect to the **pinned**
IP), closing allowlisted-hostname DNS-rebinding (the gap Tier-1 can't see). HTTP
rebind → 502; redirects re-checked (each hop is a fresh proxy request). The
safety classifier gained `classifyAddress` (`global`/`private`/`blocked`) + an
operator **`allowPrivate`** opt-in (permits loopback/RFC1918 for local-app
testing, **never** link-local/metadata). Direct HTTP-client-through-proxy tests +
a real Chromium-through-proxy test (hostnames, so no loopback-bypass). **181 TS +
45 Py green.** The **two-tier SSRF defense is now complete.** Committed to `main`;
pushing as the milestone.

**Slice 8a (dry-run redaction completeness): DONE.** `PageDriver`'s dry-run
preview now applies the `redact` hook to the would-be request **`url`** as well as
its `postData` (a secret in a GET query string previously leaked into the preview);
the option doc records that the server bin wires the real `@strummer/safety`
`Redactor` there. Test wires a real `Redactor` through the hook → both body and
`?token=` query scrubbed. (ef5cd81)

**Slice 8b (artifact-capture pipeline): DONE.** `RunRecorder` (`recorder.ts`) —
attaches to a page + its context tracer for a run's lifetime and captures three
channels, each returned **by handle** (`strummer://browser/run/<id>/<kind>`) with
a compact summary (never inlined): a Playwright **trace.zip**
(screenshots+snapshots+sources), the **console** stream (incl. uncaught
`pageerror`s, tallied `byType`), and the **network** log (method/url/status/
failure, tallied `byStatus` + `failed`). Text channels pass through the operator's
`redact` hook **before** write (so a registered secret never lands in an artifact
via a logged value or query string); trace is binary (deep trace-internal
redaction is the secret-boundary slice). Per-channel enable flags. Real-chromium
tested against a fixture that logs a secret, fetches a secret-bearing URL, and
throws. **184 TS + 45 Py green.** (9a0a810)

**Browser MCP surface — design locked by the `browser-mcp-design` fan-out**
(3 design proposals → 2 adversarial critics → synthesis; ~407k tokens). Decisions:
**MCP surface only this pass (no CLI)**; safety/operator-config-first spine (one
operator `BrowserGate` threaded into the manager AND every driver; namespaced
`STRUMMER_BROWSER_*` env, no fallback to the api bin's vars); handle-resource
egress (one `strummer://browser/run/{runId}/{kind}` ResourceTemplate); explicit
session-lifecycle tools with distinct mutating verbs. Plan staged into 3
milestones:

**Milestone A — engine hardening: DONE (slices A1–A6, pushed).** A1 snapshot
redaction seam, A2 per-generation immutable handles, A3 bounded diff, A4 dry-run
popup-block + `crossOriginEgress`, A5 no-snapshot vs stale-ref error, A6
`BrowserManager.onReap` flush hook. (The critic's "dry-run aborts only the first
request" was a verified misread — the route aborts every request; only the capture
is first-only.)

**Milestone B — MCP surface: DONE (pushed).** `registerBrowserTools`/
`createBrowserServer` (`packages/mcp/src/browser.ts`): process-lifetime singletons
(one BrowserManager, one operator gate, one ArtifactStore, one Redactor) + a
`Map<sessionId, BrowserSession>` with a per-session async mutex; 15 tools
(`browser_open_session`/`list_sessions`/`navigate`/`snapshot`/`click`/`fill`/
`fill_form`/`select`/`press`/`wait_for`/`get_text`/`get_value`/`get_attribute`/
`audit_a11y`/`close_session`); server-minted UUID sessionId+runId (1:1, never agent
input); reads redacted at the surface; reaper reconciliation via `manager.onReap`
(flush recorder) + `hasSession` eviction; the two-variable resource template over
the shared store. **Tested with real headless chromium + `InMemoryTransport`** (the
repo's established offline/deterministic browser-test posture — chosen over the
fake-launch suggestion as far more faithful + already CI-provisioned). Engine fix
this milestone demanded: `PageDriver` resolves a ref's locator **eagerly** so a
no-snapshot/stale-ref error propagates instead of being swallowed by the dry-run
try/catch.

**Milestone C — server bin: DONE (pushed).** `bin-browser.ts`
(`buildBrowserServerFromEnv`, exported + unit-tested; executable tail guarded by an
`import.meta` main-module check): sole reader of `STRUMMER_BROWSER_*` env + sole
constructor of the egress boundary; **mandatory** `createSsrfProxy` (no disable
env) + Chromium launch with `--proxy-bypass-list=<-loopback>` (loopback also
traverses the pinning proxy — closes the documented bypass); trace-off-by-default;
sandbox on by default (`--no-sandbox` opt-in); `startReaper`; SIGINT/SIGTERM
shutdown → `manager.shutdown()` then `proxy.close()`; `strummer-browser-mcp` bin +
package.json deps/build inputs. Built bin smoke-starts clean.

**Secret boundary (ADR 0006 §6): COMPLETE.** `{{secret:NAME}}` fill resolution
(`bffdf07`, fail-closed, bin-wired) + origin-scoped `httpCredentials` (`4841fb2`,
per-context via `BrowserManager`, password redacted/out-of-config) + `storageState`
by handle (`24e47ff`, operator-gated, counts+handle only, resource-refused) +
trace-internal redaction (`acc6536`, fflate unzip→scrub text entries→rezip) — on
top of console/network (8b), dry-run preview (8a), snapshot (A1), and surface-read
(Milestone B) redaction. Scheduled refinements (not blocking): HAR bodies;
`storageState`/userDataDir **import** for operator login-reuse.

**Hardening — `serviceWorkers:'block'` + WebRTC: DONE (`9207224`).** SWs blocked on
every context; WebRTC limited to proxied UDP via a launch arg. **Caps — session
wall-clock + max-pages: DONE (`f0fc419`).** `maxSessionMs` reaps active-but-old
sessions; `maxPages` closes excess pages per context; both operator-set, default
no cap.

**On-demand screenshot step tool: DONE.** `PageDriver.screenshot()` → PNG to the
`ArtifactStore` under an immutable `screenshot-s<n>` handle (summary only, never
inlined; does NOT re-snapshot so refs survive); MCP `browser_screenshot` gated
**off by default** (`allowScreenshots`) because a screenshot is unredactable pixels
(same posture as the trace.zip); the resource serves PNGs as a base64 blob;
bin-wired via `STRUMMER_BROWSER_ALLOW_SCREENSHOTS` (default off).

**Dialog gating: DONE.** `PageDriver` installs `page.on('dialog')` →
dismiss-by-default (override of Playwright's auto-dismiss, so the page never hangs)
+ record `DialogEvent {type, message(redacted), accepted}` onto
`StepResult.dialogs`; `BrowserGate.allowDialogs` flips to accept; bin-wired via
`STRUMMER_BROWSER_ALLOW_DIALOGS` (default off).

**Download gating: DONE.** `BrowserManager` contexts are `acceptDownloads:false` by
default (Playwright cancels — race-free deny); an operator quarantine dir
(`STRUMMER_BROWSER_DOWNLOAD_DIR`) flips it on + sets `PageDriver.downloadDir`, where
a download is saved under a sanitized indexed name and recorded as a `DownloadEvent`.
Surfaced by the race-free `browser_downloads` read tool (metadata only — bytes never
served).

**Upload gating: DONE.** `PageDriver.uploadFiles` / MCP `browser_upload` —
deny-by-default (requires operator `STRUMMER_BROWSER_UPLOAD_DIR`); every path must
resolve within that dir (no traversal/absolute escape) so an agent can't exfiltrate
arbitrary local files. **The downloads/uploads/dialog/auth gating bundle is COMPLETE.**

**Human `strummer browser` CLI: DONE.** `browser snapshot|audit|screenshot <url>`
over a gated manager + mandatory SSRF proxy; typed host auto-allowed; `audit` exits
1 on violations. (`packages/cli/src/browser.ts`, real-chromium tested.)

**Browser assertions: DONE.** Shared **`@strummer/assert`** (operator core extracted
from `@strummer/api`) + `@strummer/browser` `assertions.ts`/`PageDriver.assert` (page
+ element sources, auto-wait poll, redacted actual) + MCP `browser_assert`. One
assertion engine across pillars.

**`browser_trace_query`: DONE.** `queryTrace` parses a trace.zip's `.trace` JSONL
into an action timeline (before/after by callId) + console + errors; MCP
`browser_trace_query` reads the stored redacted trace by runId (no live session).
Direct parser, no GUI subprocess. (`trace.ts`, real-chromium tested.)

**`browser_perf_audit`: DONE.** `auditPerf` runs Lighthouse 13.3.0 (perf category)
via chrome-launcher with the operator's proxied/hardened flags; summary (score +
core web-vitals) inline, full LHR JSON+HTML by handle (redacted). MCP
`browser_perf_audit` is standalone + allowlist-gated; bin binds the audit closure.
(`perf.ts`, real-Lighthouse tested; assert shape not scores.)

**Network heavy mode — HAR capture + replay: DONE** (`a6ead53`/`c6a5303`/`ca88685`).
`har.ts` `finalizeHar` (redact-before-surface, store by handle, compact summary) +
`BrowserManager` `harDir`/`onClosed` (after-close finalize on close/reap/shutdown);
`PageDriver.replayFromHar` (`routeFromHAR` notFound:abort, offline determinism,
operator replay-dir confinement). MCP `browser_close_session` surfaces the HAR,
`browser_replay_har` arms replay. Bin: `STRUMMER_BROWSER_HAR_DIR` /
`STRUMMER_BROWSER_REPLAY_HAR_DIR`. Operator-gated, deny-by-default.

**Persisted `.bru` browser-step flows: DONE** (`227263a`/`d7ad2a4`/`e23427e`).
`flow.ts` (model + `loadFlow`/`loadFlowCollection` + `runFlow`); PageDriver
`clickAt`/`fillAt`/`selectAt`/`pressAt` semantic-locator methods; `strummer browser
run <flow.bru>`; `examples/browser/login/`. Steps key off semantic locators, not
refs.

**MCP `browser_run_flow` + `browser_list_flows`: DONE** (the deferred flow
follow-up). Agent surface for persisted flows: `browser_list_flows` lists the
operator's flows (name + step count); `browser_run_flow` replays one **by name**
(no caller path) on a session's gated driver behind the per-session mutex, with
caller `{{var}}`s + operator-resolved `{{secret:NAME}}` (fail-closed) + surface
error redaction. Deny-by-default via `STRUMMER_BROWSER_FLOWS_DIR`. Agent surface
now at parity with `strummer browser run`.

**Next (later Phase 3):** nothing required remains — Phase 3 is **feature-complete**.
**Multi-engine** (item 34, ADR 0009) landed: firefox/webkit via `engine.ts`, bin
`STRUMMER_BROWSER_ENGINE` + CLI `--engine`, proxy cross-engine, chromium-only
hardening args, perf stays chromium; verified end-to-end (firefox + webkit drive a
fixture). **Developer live-view was DROPPED** (ADR 0008 — headless-only, LLM-first:
trace/HAR/console/video answer "what happened" better than watching a render). Video
capture (30), vision/coordinate caps (31), container-hardening ADR (32, ADR 0007),
and visual regression (33) are done. Only the explicitly-aspirational bucket is left
(`@playwright/mcp` embed, autonomous self-healing, cross-pillar contract tie-in).
TDD red→green; `pnpm gate` 100% green before each commit.

---

Pillar 2 (`@strummer/api`) is **COMPLETE — engine + agent/human surfaces + the
full optional tail**. All five formerly-deferred tail items have landed (TDD,
all green):
1. ~~Keyring secret store into CLI/MCP~~ **DONE** (CLI `--keyring`, MCP
   `STRUMMER_KEYRING`; `resolveSecretStore({keyring})` chains keyring → env).
2. ~~SSRF range-block + post-redirect re-check~~ **DONE** (`assertSsrfAllowed`
   on every request via `@strummer/safety`; opt-in `maxRedirects` with per-hop
   SSRF + allowlist re-check + cross-origin credential strip).
3. ~~Request **body types**: multipart-form, file, graphql~~ **DONE**.
4. ~~Import: Postman/Insomnia/OpenAPI/HAR → `.bru`~~ **DONE** (`import.ts`,
   native — converters unavailable offline — + CLI `api import`).
5. ~~Contract-validation reach (ADR 0005)~~ **DONE**: external local-file `$ref`
   deref, OpenAPI 3.0 `nullable` shim, `operationName`-scoped GraphQL. (Remote
   http `$ref` + non-schema `$ref` remain out of scope by design — SSRF.)

Next: Phase 3 is feature-complete (multi-engine done, ADR 0009; live-view dropped,
ADR 0008). Recommended — start **Phase 4** (cross-cutting verification) with a
design pass, or pick up the explicitly-aspirational browser bucket — see ROADMAP.

Deferred Pillar-1 polish — **all DONE**: non-Node version detection (Python/Ruby
in `detectInstalledVersion`, wired into MCP/CLI); ingestion TOC-bleed + richer
`symbol` (`split_sections` strips on-page TOC lists; `symbol_from_heading`);
**Dash docset adapter** (`dash.iter_fragments` + `build --docset`, searchIndex
schema). Remaining Pillar-1 nice-to-haves: Homebrew tap; Dash Core Data docsets.

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
- Captured/script-set values flow through `response.captured` unredacted (needed
  for chaining); the MCP/CLI surface layer must decide how to expose them.

## Resolved (was open)

- **Repo license: Apache-2.0** (ADR 0002; `LICENSE` + `NOTICE` committed).
- **Version-pin fallback** (nearest-same-major → refuse) validated on the real
  React index: `^18.2.0` → 18.3.1, `16.8.0` → flagged.
