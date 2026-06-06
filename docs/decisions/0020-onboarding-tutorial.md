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
