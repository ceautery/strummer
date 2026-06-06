# Sackville tutorial 2 — when semantic tools earn their keep

A second, **multi-file** tour of Sackville. The [first tutorial](../todo/) used a
64-line app where `grep` and a quick read were honestly enough. This one is
bigger on purpose: a meeting-room scheduler split across several files, with a
bug that a green test suite *and* a coverage report both miss. Finding and fixing
it well is where Sackville's semantic and verification tools stop being optional.

You will:

1. **Install** the app's library docs into a Sackville index — fully offline.
2. **Find** a subtle boundary bug: first reason about it from the **docs**, then
   use **semantic navigation** (`lsp`) to see every place the buggy helper is
   used — its blast radius — before touching it.
3. **Prove the tests are weak** with **mutation testing** (a surviving mutant the
   passing suite never killed), fix the bug, close the gap, and fold it all into
   one **verify** verdict.
4. Repeat the whole loop through the **MCP** server from Claude Code.

The app is intentionally broken in one place. No spoilers in this README — but
the bug is a *single character*, in a helper used from three files, and it is
invisible to line coverage. That combination is the lesson. `./reset.sh` puts it
back when you're done.

> **Time:** ~25 minutes. No API keys. Builds on tutorial 1 but stands alone.

---

## Prerequisites — check these first (saves the most time)

| Need | Why | Check / install |
| --- | --- | --- |
| **Node — an *even-numbered* LTS line (22 or 24)** | `npm i -g @sackville-mcp/cli` pulls `better-sqlite3`, which ships **prebuilt binaries only for LTS Node**. On an **odd** release (19, 21, **23**, …) npm finds no prebuild and compiles from source — which then needs a working C/Python toolchain and is where installs break. | `node --version` → expect `v22.x` or `v24.x`. Manage with `nvm install --lts && nvm use --lts` (or `brew install node@22`). |
| **`uv`** (Python package manager) | Builds the docs index in step 1 (the Python ingester runs under `uv`). | `uv --version`; install with `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh`. |
| **A TypeScript language server** (for the `lsp` steps) | `lsp find-references` drives a real `typescript-language-server` subprocess. | `npm i -g typescript-language-server typescript` (or use any install already on your PATH). |
| **The project's local Stryker** (for the `mutate` step) | Mutation testing spawns Stryker, which runs your tests against mutated code. It is a **dev dependency of this sample** (installed by `npm install` in step 0), so you don't install it globally. | Provided by step 0; nothing extra. |

> **One-line preflight** (run from this directory):
> ```bash
> node --version; uv --version || echo "uv MISSING"; typescript-language-server --version || echo "TS language server MISSING — npm i -g typescript-language-server typescript"
> ```

---

## 0. Setup

From this directory (`examples/tutorial/scheduler/`):

```bash
npm install                # vitest + tsx + Stryker for the sample app (local)
```

> This is a plain `npm install` into a **local** `node_modules` here — it does
> not touch the parent Sackville repo. If a later `npm test` can't find vitest,
> see [Troubleshooting](#troubleshooting) — it's a `node_modules`/PATH quirk.

Install the Sackville CLI if you don't have it:

```bash
npm i -g @sackville-mcp/cli   # provides `sackville-cli`
```

> If this fails compiling `better-sqlite3`, you're on an **odd-numbered Node** —
> switch to an LTS line (see [Prerequisites](#prerequisites--check-these-first-saves-the-most-time)).

Meet the app — `roomctl`, a meeting-room scheduler that persists to
`schedule.json`. It refuses to double-book a room:

```bash
npm run roomctl -- book Oak 09:00 10:00 "standup"
npm run roomctl -- book Oak 09:30 10:30 "design sync"   # overlaps → rejected
npm run roomctl -- ls
```

```
booked #1 Oak  09:00–10:00  standup
could not book: conflicts with #1 (standup)
#1 Oak  09:00–10:00  standup
```

Good so far — a 09:30 meeting really does clash with a 09:00–10:00 one.

---

## 1. Install the library's docs into a Sackville index

The app is built on a small library, `scheduler-core`. Its documentation ships
with this tutorial as a local DevDocs pair (`docs/scheduler-core/index.json` +
`db.json` — [what is that?](#appendix-the-docs-format)). Build a searchable index
— **fully offline**; `--embedder fake` keeps it instant (no model download):

```bash
( cd ../../../py/sackville_ingest && uv sync )   # one-time — needs `uv`

uv run --project ../../../py/sackville_ingest sackville-ingest build \
  --index docs/scheduler-core/index.json \
  --db    docs/scheduler-core/db.json \
  --library scheduler-core --version 0.1.0 \
  --home https://example.com/scheduler-core/ \
  --embedder fake \
  --out scheduler-core.sqlite
```

---

## 2. The symptom, and what the docs say

Two meetings **back-to-back** in the same room shouldn't clash — one ends at
exactly the minute the next begins. Try it:

```bash
npm run roomctl -- book Oak 10:00 11:00 "retro"
```

```
could not book: conflicts with #1 (standup)
```

That's wrong: `#1` is 09:00–**10:00**, and this booking starts at **10:00**. They
touch but don't overlap. Or *should* they? Don't guess — ask the library's own
documentation (you're searching *your dependency's* docs, exactly as you would
for React or an internal package):

```bash
export SACKVILLE_INDEX=$PWD/scheduler-core.sqlite
sackville-cli search "do touching intervals overlap" --library scheduler-core
```

> **First run may pause** while `search` downloads a ~130 MB embedding model
> once, then caches. It falls back to full-text search if offline (this index was
> built with `--embedder fake`, so FTS alone finds the hit). Don't Ctrl-C.

The `overlaps` page is unambiguous: **intervals are half-open, so two that merely
touch — one ends as the other begins — do *not* overlap.** The app disagrees.
Now the question is *where the rule lives* and *what depends on it*.

---

## 3. Find the blast radius — semantic navigation, not `grep`

The conflict rule is enforced by a helper called `overlaps`. In a multi-file
project, before you change a shared helper you want to know **every** place it's
called — change it blindly and you might fix one caller and break another.

`grep overlaps` is noisy here: it also matches the word in comments, in the docs
page, and in test names. Ask the language server for the *real* references
instead. First, jump from a call site to the definition:

```bash
sackville-cli lsp definition typescript src/schedule.ts 24 64 \
  --project $PWD --allow-run
```

That resolves across files to `src/interval.ts` — where `overlaps` is defined.
Now list every true reference to that symbol:

```bash
sackville-cli lsp references typescript src/interval.ts 23 17 \
  --project $PWD --allow-run
```

You get exactly the call sites that matter — `overlaps` is used in
`src/schedule.ts` (the `book` guard **and** `conflicts`) and in
`src/availability.ts` (`freeSlots`). Three call sites in two files, plus the
definition: that's the blast radius of any change to this one helper, and none of
the comment/doc/test-name noise a text search would dump on you.

> `lsp` spawns a code-indexing daemon, so it needs the operator flag
> `--allow-run`. The `<line> <col>` are **1-based**; point them at the `overlaps`
> identifier. (Coordinates above match the pristine files; after `./reset.sh`
> they're stable.)

Open `src/interval.ts` and read `overlaps`. It's a few lines — and the boundary
comparison is where the docs and the code disagree.

---

## 4. Green tests, still wrong — mutation testing

Run the suite:

```bash
npm test
```

Green. Every test passes — yet the scheduler is wrong. So is the suite *complete*?
Try the obvious next move from tutorial 1, coverage:

```bash
npx vitest run --coverage
```

`src/interval.ts` reads as **fully covered** — the `overlaps` line *runs* in
plenty of tests. Coverage is the wrong instrument for this bug: the line executes,
it just executes a comparison the tests never pin at the boundary. **A covered
line is not a tested behavior.**

Mutation testing asks the sharper question — *if I corrupt this code, does a test
notice?* Run it scoped to the helper:

```bash
sackville-cli mutate run $PWD --file src/interval.ts --allow-run
```

Stryker mutates `overlaps` every way it can, re-running your tests against each
version. Most mutants are **killed** (a test caught them). But one **survives**:
flipping the boundary comparison (`<` ↔ `<=`) changes nothing your tests assert —
the suite stays green either way. That surviving mutant points straight at the
untested boundary, which is the bug *and* the missing test, in one shot.

> `mutate run` *runs* your tests many times, so it needs `--allow-run`. It reads
> Stryker's JSON report from `reports/mutation/mutation.json`; the bundled
> `stryker.config.json` wires the vitest runner. If you'd rather see Stryker's own
> output, `npm run mutate` runs it directly.

---

## 5. Fix it, and close the gap

Open `src/interval.ts` and fix `overlaps` so that intervals which merely touch do
**not** overlap (the half-open rule the docs describe). Then add the assertion the
suite was missing — a boundary test for `overlaps` (and ideally one for
`Schedule.book` accepting a back-to-back booking) — in `test/schedule.test.ts`.

Re-run the tools that caught it:

```bash
npm test                                                  # still green
npm run roomctl -- book Oak 10:00 11:00 "retro"           # now accepted
sackville-cli mutate run $PWD --file src/interval.ts --allow-run   # mutant now killed
```

```
booked #2 Oak  10:00–11:00  retro
```

---

## 6. Prove the change — one verdict

`verify run` drives the pillars you ask for and folds them into a single verdict.
Its rule is **absence is never a pass**: a pillar with no signal is
`inconclusive`, never green.

```bash
sackville-cli verify run $PWD --mutate --mutate-tool stryker --allow-run
```

Exit `0` = pass, `1` = fail, `2` = inconclusive. With the boundary test added, the
mutation pillar now reports its survivor killed, and the verdict is a real pass —
not "the tests happened to be green."

---

## 7. Now do it through the MCP, from Claude Code

Everything above maps to MCP tools an agent drives directly. Point Claude Code at
the aggregate server with this project's docs index and the verification pillars
wired in:

```bash
claude mcp add sackville \
  --env SACKVILLE_INDEX=$PWD/scheduler-core.sqlite \
  --env SACKVILLE_TOOLSETS=docs,lsp,mutate,verify \
  --env SACKVILLE_LSP_ALLOW_RUN=1 \
  --env SACKVILLE_LSP_PROJECT_ROOTS=$PWD \
  --env SACKVILLE_LSP_SERVERS='{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}' \
  --env SACKVILLE_MUTATE_ALLOW_RUN=1 \
  --env SACKVILLE_MUTATE_PROJECT_ROOTS=$PWD \
  --env SACKVILLE_VERIFY_ENABLE_RUN=1 \
  -- npx -y sackville-mcp
```

Then run `./reset.sh` and ask Claude Code, in this directory:

> *"`roomctl book Oak 10:00 11:00 retro` is rejected as a conflict with the
> 09:00–10:00 booking, but back-to-back meetings shouldn't clash. Use the
> Sackville tools to confirm what `overlaps` should do, find every place it's
> used, prove the tests don't cover the boundary, fix it, add the missing test,
> and verify the change."*

With the bundled `sackville` skill loaded (`.claude/skills/sackville/`), Claude
reaches for Sackville's tools instead of `grep`:

| Step | Tool the agent uses |
| --- | --- |
| Confirm the half-open / touching semantics | **`search_docs`** → **`get_doc`** |
| Resolve `overlaps`'s definition across files | **`lsp_find_definition`** |
| See every call site (the blast radius) | **`lsp_find_references`** |
| Show the suite doesn't pin the boundary | **`mutate_run`** (surviving mutant) |
| Fold the fix into one verdict | **`verify_change`** |

> **Why this app and not the todo one for the agent demo.** On the 64-line todo
> app, an agent could just read the file. Here the helper is small but its
> *callers are spread across files*, and the failing behavior is invisible to a
> green suite and to coverage — so `lsp_find_references` (true call sites, no
> noise) and `mutate_run` (a behavior no test pinned) give the agent signal it
> can't get by reading. That's when the tools earn their keep.

---

## 8. Build the obvious next feature

Try the loop again on a feature: add a **`move <id> <start> <end>`** command that
reschedules a booking (cancel + re-book at the new time, refusing the move if it
would conflict). Search the docs for the model, write the boundary test *first*
(a move to a back-to-back slot must succeed), wire it in `src/cli.ts`, then
`verify run` it green.

---

## Reset

```bash
./reset.sh        # restores the pristine (buggy) app + clears run state
```

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `npm i -g @sackville-mcp/cli` dies compiling `better-sqlite3` | Odd-numbered Node with no prebuilt binary. Switch to an **LTS Node** (`nvm use --lts`, or `brew install node@22`) and reinstall. |
| `npm test` can't find vitest though `node_modules/vitest` exists | This example sits inside the Sackville **pnpm** workspace; an `npm` run from here can resolve against the parent tree. Run from a clean shell in this directory, `rm -rf node_modules && npm install` here, then `npm test`. (`npx vitest run` also sidesteps it.) |
| `lsp` says `refused: … (pass --allow-run)` | Add `--allow-run` — it spawns a language server, an operator-gated action. |
| `lsp` exits `2` ("server still indexing") | The TS server was still loading the project. Re-run the command; it's near-instant once warm. |
| `lsp` finds nothing / errors spawning | `typescript-language-server` isn't on your PATH. `npm i -g typescript-language-server typescript`. |
| `mutate run` says it produced no JSON report | Stryker couldn't start or its tests errored. Ensure `npm install` ran here (Stryker + vitest are local dev deps), then retry. `npm run mutate` shows Stryker's own diagnostics. |
| `search` seems to hang on first use | It's downloading the ~130 MB query-embedding model once; it caches after. FTS works without it. |

---

## Appendix: the docs format

The search in step 2 worked because we indexed `scheduler-core`'s docs. You can do
the **same for any library your project depends on**. There are two ways in:

**1. A published library → pull from DevDocs by slug** (no files to author):

```bash
uv run --project ../../../py/sackville_ingest sackville-ingest build \
  --slug react --library react --version 18 --out react.sqlite
```

**2. Your own / internal library → author a DevDocs-format pair.** That's what
`docs/scheduler-core/` is — two JSON files:

- **`index.json`** — the table of contents. An `entries[]` array; each entry has a
  `name`, a `path` (the lookup key), and a `type` (`Guide`, `Function`, `Method`,
  …, used for the `[type]` column and `--type` filtering).
- **`db.json`** — the bodies: a flat object mapping each `path` to an **HTML**
  fragment. The ingester strips it to text, splits it into searchable chunks, and
  (unless `--embedder fake`) embeds each chunk.

For the full schema and a worked example, see the [tutorial 1 appendix](../todo/README.md#appendix-the-docs-format-and-indexing-your-own-app).

---

## What you just used

| Pillar / tool | What it did here |
| --- | --- |
| **docs** (`search_docs` / `sackville-cli search`) | the *intended* semantics of a dependency, ingested offline |
| **lsp** (`lsp_find_definition` / `_references`) | true cross-file call sites — the blast radius, without `grep` noise |
| **mutate** (`mutate_run`) | proved the green suite never tested the boundary (a surviving mutant) |
| **verify** (`verify_change` / `verify run`) | one composed verdict; absence is never a pass |

This extends [tutorial 1](../todo/), which covers `coverage` and the find→fix→prove
loop on a smaller app. The same shape reaches API contract validation, browser
flows, dependency/CVE audits, and flaky-test detection — see the repo
[`README.md`](../../../README.md).
