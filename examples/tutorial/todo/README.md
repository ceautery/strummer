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

> **Time:** ~15 minutes. No API keys.

---

## Prerequisites — check these first (saves the most time)

Two of the steps below build a **native** module (`better-sqlite3`) and run a
**Python** tool. The fastest way through the tutorial is to get these right up
front; most setup pain traces back to one of them.

| Need | Why | Check / install |
| --- | --- | --- |
| **Node — an *even-numbered* LTS line (22 or 24)** | `npm i -g @sackville-mcp/cli` pulls `better-sqlite3`, which ships **prebuilt binaries only for LTS Node**. On an **odd** release (19, 21, **23**, …) npm finds no prebuild and falls back to compiling from source — which then needs a working C/Python build toolchain and is where installs break. | `node --version` → expect `v22.x` or `v24.x`. Manage with `nvm install --lts && nvm use --lts` (or `brew install node@22`). |
| **A working Python (only if a source build happens)** | If Node is odd and the source build kicks in, `node-gyp` shells out to your `python3`. A broken Python breaks the build — e.g. Homebrew's `python@3.14` has shown `Symbol not found: _XML_SetAllocTrackerActivationThreshold` (a stale `expat`). | You usually avoid this entirely by using an LTS Node (no compile). If you hit it on macOS, `brew update && brew upgrade` realigns Node + Python. |
| **`uv`** (Python package manager) | Builds the docs index in step 1 (the Python ingester runs under `uv`). | `uv --version`; install with `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` (see [astral.sh/uv](https://docs.astral.sh/uv/)). |

> **One-line preflight** (run from this directory):
> ```bash
> node --version; uv --version || echo "uv MISSING — see the table above"
> ```
> If `node` is an odd-numbered version, switch to an LTS line **before** the
> `npm i -g` step — it's far easier than fixing a failed native compile.

---

## 0. Setup

From this directory (`examples/tutorial/todo/`):

```bash
npm install                # installs vitest + tsx for the sample app
```

> This is a plain `npm install` into a **local** `node_modules` here — it does
> **not** touch the parent Sackville repo. If a later `npm test` reports it
> *can't find vitest*, see [Troubleshooting](#troubleshooting) — it's a
> `node_modules`/PATH quirk, not a missing install.

Install the Sackville CLI if you don't have it:

```bash
npm i -g @sackville-mcp/cli   # provides `sackville-cli`
```

> If this step fails compiling `better-sqlite3` (`node-gyp`, `prebuild-install`,
> or a Python/`pyexpat` error in the log), you're on an **odd-numbered Node** and
> npm is building from source — switch to an LTS Node (see
> [Prerequisites](#prerequisites--check-these-first-saves-the-most-time)) and
> reinstall. You won't need a compiler at all on LTS.

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
this tutorial as a local DevDocs pair (`docs/todo-core/index.json` + `db.json` —
[what is that?](#appendix-the-docs-format-and-indexing-your-own-app)). Build a
searchable index from it — this is **fully offline**, and `--embedder fake` keeps
it instant (no model download):

```bash
( cd ../../../py/sackville_ingest && uv sync )   # one-time — needs `uv` (see Prerequisites)

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
`active` is supposed to behave? Ask **the app's own library documentation** — the
`todo-core` docs you just indexed (you're searching *your* dependency's docs, not
Sackville's; this is exactly what you'd do against React, Django, or your own
internal libraries):

```bash
export SACKVILLE_INDEX=$PWD/todo-core.sqlite
sackville-cli search "active filter todos" --library todo-core
```

> **First run may pause for a bit — that's expected, don't Ctrl-C.** `search`
> embeds your query with a local model it downloads **once** (~130 MB) on first
> use, then caches. While it downloads it looks idle. If the download can't
> complete it falls back to full-text search automatically. (To skip the model
> entirely — e.g. on CI — this index was built with `--embedder fake`; full-text
> search alone still finds the hit below.)

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

> **It needs to find `vitest`.** `run-scoped` shells out to the project's test
> runner; Sackville now prepends `<project>/node_modules/.bin` to the runner's
> PATH, so the `vitest` you installed in step 0 is found even when `sackville-cli`
> is a *global* install. If you see `scoped run did not produce a coverage report
> … (exit code …)`, read the **runner output tail** that error now prints — the
> usual cause is `vitest` not being installed in the project (re-run `npm install`
> here).

> **Why pass `--changed-file` by hand?** The coverage engine is deliberately
> *pure* — it takes the changed set as input rather than shelling out to `git`
> (so it has no opinion about your VCS, stays safe to run in a sandbox, and works
> on staged-but-uncommitted or even hypothetical changes). When you *do* want it
> scoped to real VCS changes, feed it a diff instead:
> ```bash
> git diff -- src/todo.ts > /tmp/todo.diff
> sackville-cli coverage run-scoped $PWD --diff /tmp/todo.diff --allow-run
> ```
> (A convenience `--git` flag that derives the changed set from `git` directly is
> on the [roadmap](../../../ROADMAP.md).)

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

`verify run` drives the pillars you ask for and folds them into one verdict whose
rule is **absence is never a pass**:

```bash
sackville-cli verify run $PWD \
  --coverage --changed-file src/todo.ts \
  --allow-run
```

```
verdict: INCONCLUSIVE (worst severity none)
  contract: missing — no input supplied
  coverage: pass — all N new executable line(s) covered
  deps:     missing — no input supplied
  flake:    missing — no input supplied
  mutate:   missing — no input supplied
```

Read the **per-pillar breakdown** — that's the primary output: `coverage: pass`
once your new test covers the `active` branch. The **overall** verdict is
`INCONCLUSIVE` (exit `2`), and that's correct: you only ran one pillar, so verify
treats the others as unchecked (absence is never a pass, applied across pillars).
The composite goes green only when every dimension you care about has been checked.
Exit codes: `0` pass, `1` fail, `2` inconclusive.

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

> **A note on a 64-line app.** On code this tiny, a capable agent can (and often
> will) just *read* `todo.ts` and confirm the fix by eye — `grep`/read are
> genuinely adequate here, so don't be surprised if it leans on Sackville less
> than the table implies. The skill is written to make it reach for the tool
> *first* and fall through when a direct read is plainly enough. The payoff scales
> with the code: on a real multi-file project, `lsp_find_references` catches call
> sites a read misses, `search_docs` pins the *installed* API, and `verify_change`
> turns "looks right" into a checked verdict. If you want to *see* the tools drive
> even here, ask explicitly — e.g. *"use `verify_change` to prove it, not just
> `npm test`."*

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

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `npm i -g @sackville-mcp/cli` dies compiling `better-sqlite3` (`node-gyp` / `prebuild-install` / `pyexpat` / `Symbol not found … expat`) | You're on an **odd-numbered Node** (e.g. 23) with no prebuilt binary, so npm compiles from source and trips over your build toolchain / Python. Switch to an **LTS Node** (`nvm use --lts`, or `brew install node@22`) and reinstall — no compiler needed. On macOS, `brew update && brew upgrade` also realigns a stale Python. |
| `npm warn EBADENGINE … vitest … current: node v23.x` | Same root cause (odd Node). It's only a warning, but it's the canary — move to an LTS line. |
| `npm test` says it **can't find vitest** even though `node_modules/vitest` exists | This example sits *inside* the Sackville repo, which is a **pnpm** workspace. If your shell or editor has the parent repo's environment active, an `npm`/`pnpm` run from here can resolve against the parent tree instead of this folder's `node_modules/.bin`. Fix: run from a clean shell **in this directory**, `rm -rf node_modules && npm install` here, then `npm test`. (Running tests directly — `npx vitest run` — also sidesteps it.) |
| `search` seems to hang on first use | It's downloading the ~130 MB query-embedding model once. Wait it out (or pre-warm with any throwaway `search`); it caches after. See the note in [step 2](#2-find-the-bug--with-the-cli). |
| `scoped run did not produce a coverage report … (exit code …)` | The test runner couldn't start or the tests errored. The error now prints a **runner-output tail** — read it. Most often `vitest` isn't installed in this project: re-run `npm install` here. |

---

## Appendix: the docs format, and indexing your own app

The search in step 2 worked because we indexed `todo-core`'s docs. You can do the
**same for any library your project depends on** — that's the whole point of the
docs pillar. There are two ways to get docs in:

**1. A published library → pull from DevDocs by slug** (no files to author):

```bash
uv run --project ../../../py/sackville_ingest sackville-ingest build \
  --slug react --library react --version 18 --out react.sqlite
```

**2. Your own / internal library → author a DevDocs-format pair.** That's what
`docs/todo-core/` is. It's just two JSON files:

- **`index.json`** — the table of contents. An `entries[]` array; each entry has a
  `name` (display title), a `path` (the key used to look up the body), and a
  `type` (`Guide`, `Method`, `Class`, …, used for the `[type]` column and
  `--type` filtering):
  ```json
  {
    "entries": [
      { "name": "TodoList.filter", "path": "api/filter", "type": "Method" }
    ],
    "types": []
  }
  ```
- **`db.json`** — the bodies. A flat object mapping each `path` from `index.json`
  to an **HTML** fragment (headings, `<p>`, `<pre><code>` — exactly what DevDocs
  stores). The ingester strips the HTML to text, splits it into searchable
  chunks, and (unless `--embedder fake`) embeds each chunk:
  ```json
  {
    "api/filter": "<h1>filter(which)</h1><p>Returns the todos matching…</p>"
  }
  ```

Build an index from a pair exactly as in [step 1](#1-install-the-librarys-docs-into-a-sackville-index):

```bash
uv run --project <path>/py/sackville_ingest sackville-ingest build \
  --index path/to/index.json --db path/to/db.json \
  --library my-lib --version 1.2.0 --home https://example.com/my-lib/ \
  --embedder fake --out my-lib.sqlite
```

Then point `SACKVILLE_INDEX` (CLI) or the MCP server's env at the resulting
`.sqlite`. To generate the pair for a real internal library, emit your existing
HTML/Markdown docs into this shape — any script that produces the two JSON files
works; the format is the contract, not the tool that wrote it.

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
