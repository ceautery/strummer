# ADR 0020 — Onboarding tutorial (a runnable, resettable sample)

- **Status:** Accepted
- **Date:** 2026-06-06

## Context

Sackville is feature-complete across three pillars + cross-cutting verification,
but a newcomer (human or agent) has no guided, hands-on path from "installed" to
"I used it to find and fix a real bug." The `examples/` directory holds static
fixtures (an API collection, a browser flow, LSP demo projects) — none is a
*runnable application with a defect to find*, and none chains the pillars into a
single workflow.

We want a tutorial that:

1. Installs a library's documentation into the docs SQLite index.
2. Uses the **CLI** (`sackville-cli`) to find and fix a problem.
3. Repeats the same fix through the **MCP** server from Claude Code.
4. Is **resettable** so the lesson can be re-run.

A research pass (see STATUS) established there is **no core-code gap** — offline
docs ingestion (`build --index/--db` + `--embedder fake`), `search`/`get`, and the
verification CLIs all exist. The work is *content*: a sample app, a bundled
offline docset, a reset mechanism, and guard tests.

## Decisions

### 1. A pure-TypeScript "todo-core" CLI as the sample

`examples/tutorial/todo/` — a tiny, dependency-free `TodoList` core
(`add`/`toggle`/`remove`/`filter`) plus a thin persisting CLI. Pure TS so the
guard can import it with zero install, and small enough to read in one sitting.
The "classic TODO-MVC" shape, minus a UI (Sackville is headless/CLI-first).

### 2. The defect is a *logic* bug hidden by a *test gap*

`filter('active')` uses an inverted predicate (returns completed todos). The
shipped test suite passes because it never asserts the `active` path — so the bug
is invisible to a green run and is exactly what `coverage` (an uncovered branch)
and `mutate` (a surviving mutant) surface. This makes the tutorial demonstrate
Sackville's value proposition: **green tests are not proof**. The "obvious next
feature" is a `clear-completed` command, built the same way.

The source carries **no spoiler comment** (the hunt must be real); the guard test
pins the bug so a well-meaning "fix" can't silently break the tutorial.

### 3. The app ships intentionally broken — so it lives *outside the gate*

`examples/` is not a pnpm workspace member and is not in the root Vitest
`include`, so the broken app and its own (gap-having) test suite never run in
`pnpm gate`. **Biome still lints `examples/`**, so the sample is style-clean —
only its *behavior* is wrong. We do **not** exclude it from Biome; keeping it
lint-clean is part of the example's quality.

### 4. Docs ingestion is offline and bundled

The library's docs ship as a hand-authored **local-DevDocs** pair
(`docs/todo-core/index.json` + `db.json`), ingested with `--embedder fake` — zero
network, no model download, deterministic. (The README points at the `--slug`
DevDocs flow as the "for real libraries" path.) This matches the "bundled offline
docset" decision and keeps the tutorial reproducible in CI.

### 5. Reset via git, with a tarball fallback

`reset.sh` runs `git checkout` on the example subtree and clears the `todos.json`
state file; if the directory isn't a git checkout (downloaded tarball) it tells
the user to discard edits manually.

### 6. Two guard tests keep it honest (CLAUDE.md "each example is guarded")

- **TS guard** (`test/tutorial-todo.test.ts`, in the main suite): the files the
  tutorial references exist; the docset's `index.json` paths and `db.json` keys
  agree; and the **pristine bug is present** (`filter('active')` returns the
  completed item while `'completed'`/`'all'` are correct) — with a failure message
  that explains the bug is intentional.
- **Python guard** (`py/sackville_ingest/tests/test_tutorial_todo.py`): actually
  *ingests* the bundled docset with the fake embedder and asserts the index builds
  and an FTS search for `active` returns the semantics page — proving the
  tutorial's ingest command works offline.

## Consequences

- A newcomer can go install → ingest docs → find a bug → fix → verify, twice
  (CLI, then MCP), and reset.
- The sample is a permanent, low-maintenance fixture: the guards fail loudly if
  the docset drifts or the bug is "fixed," forcing the tutorial and code to move
  together.
- No production code changed; this is purely additive onboarding content.

## Addendum (2026-06-06) — a level-2, multi-file tutorial

The todo tutorial's own README concedes its weakness: on a 64-line app, `grep`
and a quick read are honestly adequate, so the *semantic* tools (`lsp`,
`mutate`, cross-pillar `verify`) don't visibly earn their keep. We add a second
tutorial that fixes exactly that, reusing every decision above (pure-TS sample
outside the gate, bundled offline docset, `reset.sh`, two guards).

### Decisions (level 2)

1. **A multi-file meeting-room scheduler** (`examples/tutorial/scheduler/`,
   `roomctl`): `Interval` + an `overlaps()` helper, `Booking`, a `Schedule`
   class (`book`/`cancel`/`conflicts`), `freeSlots()`, format utils, CLI — 6
   source files. `overlaps()` is called from **three** files, so the value of
   semantic navigation is real, not contrived.

2. **The defect is a single-character boundary bug that coverage cannot catch.**
   `overlaps` uses `<` where it needs `<=`, so half-open intervals that merely
   *touch* (one ends at the minute the next begins) are wrongly reported as
   overlapping — back-to-back bookings are rejected. The shipped suite passes
   because it tests intervals that *clearly* overlap and *clearly* don't, never
   the boundary. Crucially the buggy line **executes** in those tests, so line
   **coverage reads as fully covered** — the bug is invisible to coverage. This
   is the deliberate contrast with tutorial 1 (whose bug was an *uncovered*
   branch coverage flags): here the headline catch is **mutation testing** — a
   surviving `<`↔`<=` mutant proves the suite never pinned the boundary.

3. **The teaching arc per tool:** `search_docs` confirms the intended
   touching-≠-overlap semantics (version-pinned dependency truth);
   `lsp_find_definition`/`_references` resolve `overlaps` across files and show
   its blast radius (true call sites, none of the comment/doc/test-name noise a
   `grep overlaps` returns); `mutate_run` surfaces the surviving mutant;
   `verify_change` folds the fixed result into one verdict. The CLI pass and the
   Claude-Code/MCP pass mirror each other, as in tutorial 1.

4. **Same honesty guards, one new wrinkle.** A TS guard
   (`test/tutorial-scheduler.test.ts`) pins the bug (`overlaps` returns `true`
   for a touching pair; `Schedule.book` rejects a back-to-back booking) and the
   docset/README sync; a pytest guard
   (`tests/test_tutorial_scheduler.py`) ingests the `scheduler-core` docset
   offline and asserts an FTS search for `overlap` finds the semantics page. The
   sample carries **no spoiler comment**; `overlaps`'s doc-comment points the
   reader at the `scheduler-core` docs for the boundary rule rather than stating
   it.

5. **Mutation testing is a sample dev dependency, not a global install.** The
   sample's `package.json` pins `@stryker-mutator/core` +
   `@stryker-mutator/vitest-runner`; a bundled `stryker.config.json` wires the
   vitest runner. `sackville-cli mutate run` supplies `--reporters json --mutate
   src/interval.ts` itself and reads `reports/mutation/mutation.json` — so the
   README's `mutate run` step works against the local Stryker with no extra
   setup. (As with the todo tutorial's coverage step, the Stryker *run* is not
   executed in `pnpm gate` — only the guards are; runtime tool/version compat is
   an operator concern, surfaced in Troubleshooting.)

### Consequences (level 2)

- Tutorial 1 stays the 15-minute on-ramp (docs + coverage + the loop); tutorial
  2 is the ~25-minute follow-on where `lsp` blast-radius and `mutate` are the
  point, on code big enough that reading-by-eye stops being enough.
- Still purely additive: no production code changed; gate green at 1647 TS + 47
  Py after the two new guards.

## Addendum 2 (2026-06-06) — a level-3 api + browser + verify tutorial

Tutorials 1–2 cover the `docs`, `coverage`, `lsp`, `mutate`, and `verify`
pillars on pure-logic samples. The **api** and **browser** pillars — contract
validation and browser flows, plus the cross-pillar **capture→contract** bridge
(ADR 0013 §5e/5f) — had no tutorial. We add a third, reusing every decision above
(sample outside the gate, bundled offline docset, `reset.sh`, two honesty guards).

### Decisions (level 3)

1. **A zero-dependency storefront** (`examples/tutorial/storefront/`): a plain
   Node `server.js` (no framework, no `npm install`) serving a JSON API
   (`GET /account`) and the HTML pages a browser flow walks (`/login` →
   `/dashboard`), plus its OpenAPI contract (`openapi.json`), a `.bru` api
   request, a persisted browser flow, and the offline `storefront-core` docset.
   Both pillars need a *live target*, so unlike tutorials 1–2 the sample is a
   server you run — but it stays dependency-free so the only prerequisite is Node.

2. **The defect is a contract-type lie invisible to the running app.** `account.js`
   returns `balance` as the string `'10000'` where the contract declares an
   integer (cents). The dashboard coerces it (`'10000' / 100`), so the UI renders
   `$100.00` and a login flow passes — yet the API violates its own contract. This
   is the deliberate contrast with tutorials 1–2: the bug is not a failing test,
   an uncovered branch, or an unpinned boundary — it lives in the gap between what
   the API *sends* and what it *promised*, visible only to a tool that knows the
   contract.

3. **The teaching arc per tool:** `search_docs` confirms `balance` is an integer
   (cents); `api run --openapi` catches the drift on the live response **while
   every assertion passes** (the smoke-test trap); `api validate-capture` finds
   the same breach in a **committed recording of a passing browser flow** (the
   capture→contract bridge — "absence is never a pass"); `verify_change` folds it
   into one verdict. A bonus step drives the live login flow with a real browser
   (`verify run --flow`). CLI and Claude-Code/MCP passes mirror each other.

4. **The committed HAR makes the headline run without a browser.** The
   capture→contract step uses a checked-in `storefront.har.zip` (generated from
   the real server, Playwright-shaped inline-text bodies via `fflate`), so steps
   1–6 need no browser engine; only the bonus step requires
   `npx playwright install chromium`. This mirrors the Phase-5a
   `widgets-capture.har.zip` fixture convention.

5. **Same honesty guards.** A TS guard (`test/tutorial-storefront.test.ts`, main
   suite) pins the bug two ways — the buggy response and the committed HAR both
   drift to a `response-schema` finding through the shipped validators, and the
   corrected (number) response validates clean — plus docset/README sync. A pytest
   guard (`tests/test_tutorial_storefront.py`) ingests the `storefront-core`
   docset offline and asserts an FTS search for `balance` finds the page. No
   spoiler comment beyond `account.js`'s own marker.

### Consequences (level 3)

- **One real product bug fixed (dogfooding).** Driving the bonus
  `verify run --flow` path live surfaced that the verify **CLI**'s browser-capture
  runtime (`captureRuntimeFromFlags`) was built incomplete versus `sackville
  browser run` and the browser MCP server: it threaded no `--allow-unsafe` (so a
  flow's `fill`/`click` dry-ran and any real flow failed the completeness guard)
  and wired no secret resolver/redactor (so `{{secret:NAME}}` failed closed). Both
  fixed TDD (`captureGateOptionsFromFlags` + `browserCaptureSecretsFromEnv`, pure
  + unit-tested); the MCP path was already correct. So this addendum is *not*
  purely additive — it carries a small `@sackville-mcp/cli` fix.
- Gate green at 1700 TS + 48 Py after the two new guards + the CLI fix's tests.
