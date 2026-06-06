# Sackville tutorial — find a bug, fix it, prove it

A hands-on tour of Sackville on a tiny, runnable TODO app. You will:

1. **Install** the app's library docs into a Sackville docs index — fully offline.
2. **Find** a real bug the test suite hides — first with the **CLI**
   (`sackville-cli`), then with **Claude Code** through the **MCP** server.
3. **Fix** it, **build** the obvious next feature, and **prove** the change with
   one verification command.

The app is intentionally broken in one place. Finding that place is the point —
so no spoilers here. When you're done, `./reset.sh` puts it back so you (or a
teammate) can run it again.

> **Time:** ~15 minutes. **Needs:** Node ≥ 22, `uv` (for the Python ingester),
> and Sackville. No API keys. Building the docs index and running the app are
> fully offline; the CLI's `search` downloads a small (~130 MB) query-embedding
> model once on first use, and falls back to full-text search if it can't.

---

## 0. Setup

From this directory (`examples/tutorial/todo/`):

```bash
npm install                # installs vitest + tsx for the sample app
```

Install the Sackville CLI if you don't have it:

```bash
npm i -g @sackville-mcp/cli   # provides `sackville-cli`
```

Meet the app — a four-command todo list that persists to `todos.json`:

```bash
npm run todo -- add "buy milk"
npm run todo -- add "write tests"
npm run todo -- done 2
npm run todo -- ls
```

```
[ ] #1 buy milk
[x] #2 write tests
```

---

## 1. Install the library's docs into a Sackville index

The app is built on a small library, `todo-core`. Its documentation ships with
this tutorial as a local DevDocs pair (`docs/todo-core/index.json` + `db.json`).
Build a searchable index from it — `--embedder fake` keeps it instant and offline
(no model download):

```bash
( cd ../../../py/sackville_ingest && uv sync )   # one-time

uv run --project ../../../py/sackville_ingest sackville-ingest build \
  --index docs/todo-core/index.json \
  --db    docs/todo-core/db.json \
  --library todo-core --version 0.1.0 \
  --home https://example.com/todo-core/ \
  --embedder fake \
  --out todo-core.sqlite
```

> **Real libraries:** for a published package, skip the bundled files and pull
> its docs straight from DevDocs with `--slug` (e.g.
> `sackville-ingest build --slug react --library react --out react.sqlite`).

---

## 2. Find the bug — with the CLI

Something's off: `ls --active` should show the todos you still have to do.

```bash
npm run todo -- ls --active
```

```
[x] #2 write tests
```

That's backwards — it's listing the **completed** todo. Is that really how
`active` is supposed to behave? Ask the docs you just indexed:

```bash
export SACKVILLE_INDEX=$PWD/todo-core.sqlite
sackville-cli search "active filter todos" --library todo-core
```

The top hit explains it: **active returns todos that are NOT done.** The code
disagrees. Now confirm *why the tests didn't catch it*. Run them:

```bash
npm test
```

Green. Every test passes — yet the app is wrong. A green run is not proof; it
only proves what you *asserted*. Let Sackville show the gap by running the suite
impact-scoped, with coverage, over the file you're about to touch:

```bash
sackville-cli coverage run-scoped $PWD \
  --changed-file src/todo.ts \
  --allow-run
```

It reports `src/todo.ts` lines that ran in production paths but that **no test
executed** — and the uncovered line is inside the `active` branch of `filter`.
That's your bug, and your missing test, in one shot.

> `coverage run-scoped` *runs* tests, so it needs the operator flag `--allow-run`.
> Pure, no-spawn alternative: `vitest run --coverage` then
> `sackville-cli coverage uncovered-in-diff --diff <your.diff> --coverage coverage/coverage-final.json`.

---

## 3. Fix it, and close the test gap

Open `src/todo.ts` and fix the `active` case of `filter` so it returns todos that
are **not** done. Then add the assertion the suite was missing — a test for
`filter('active')` — in `test/todo.test.ts`.

Re-run:

```bash
npm test
npm run todo -- ls --active
```

```
[ ] #1 buy milk
```

---

## 4. Prove the change — one verdict

`verify run` drives the pillars you ask for and folds them into a single verdict.
Its rule is **absence is never a pass**: a pillar with no signal is
`inconclusive`, never green.

```bash
sackville-cli verify run $PWD \
  --coverage --changed-file src/todo.ts \
  --allow-run
```

Exit `0` = pass, `1` = fail, `2` = inconclusive.

---

## 5. Now do it through the MCP, from Claude Code

Everything above maps to MCP tools an agent drives directly. Point Claude Code at
the aggregate server with this project's docs index wired in:

```bash
claude mcp add sackville \
  --env SACKVILLE_INDEX=$PWD/todo-core.sqlite \
  --env SACKVILLE_TOOLSETS=docs,coverage,lsp,verify \
  --env SACKVILLE_COVERAGE_ALLOW_RUN=1 \
  --env SACKVILLE_COVERAGE_PROJECT_ROOTS=$PWD \
  --env SACKVILLE_LSP_ALLOW_RUN=1 \
  --env SACKVILLE_LSP_PROJECT_ROOTS=$PWD \
  --env SACKVILLE_LSP_SERVERS='{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}' \
  -- npx -y sackville-mcp
```

Then run `./reset.sh` and ask Claude Code, in this directory:

> *"`todo ls --active` is showing completed todos. Use the Sackville tools to
> find out what `active` should do, locate the bug, fix it, add the missing test,
> and verify the change."*

With the bundled `sackville` skill loaded (`.claude/skills/sackville/`), Claude
reaches for Sackville's tools instead of `grep`:

| Step | Tool the agent uses |
| --- | --- |
| Learn the intended `active` semantics | **`search_docs`** → **`get_doc`** |
| Find where `filter` is defined / used | **`lsp_find_definition`**, **`lsp_find_references`** |
| See the untested branch | **`run_scoped`** (`SACKVILLE_COVERAGE_*`) |
| Confirm the fix holds | **`verify_change`** |

Same destination as the CLI pass — driven by the agent, in structured,
token-efficient calls.

---

## 6. Build the obvious next feature

Try the loop again on a feature instead of a bug: add a **`clear-completed`**
command (removes every done todo). Search the docs for the model, add the
`clear-completed` case to `src/cli.ts` (and a `clearCompleted()` method to
`TodoList` if you like), write the test first, then `verify run` it green.

---

## Reset

```bash
./reset.sh        # restores the pristine (buggy) app + clears todos.json
```

Run it any time to start the tutorial fresh.

---

## What you just used

| Pillar / tool | What it did here |
| --- | --- |
| **docs** (`search_docs`/`sackville-cli search`) | version-pinned API truth, ingested offline |
| **lsp** (`lsp_find_definition`/`_references`) | semantic navigation instead of text search |
| **coverage** (`run_scoped`/`uncovered_in_diff`) | the forgotten-assertion catch |
| **verify** (`verify_change`/`verify run`) | one composed verdict; absence is never a pass |

This is a sliver of Sackville. The same shape extends to API contract validation,
browser flows, dependency/CVE audits, flaky-test detection, and mutation testing —
see the repo [`README.md`](../../../README.md).
