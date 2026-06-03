# pygreeter — Python sample project for `strummer lsp`

A tiny, real Python project to drive the [`strummer lsp` CLI](../../../packages/cli/README.md#verification-phase-4-pillars)
against a live Language Server — the Python counterpart of [`../greeter`](../greeter)
(TypeScript). Two files:

- [`greeter.py`](./greeter.py) — a free `hello(name)` function and a `class Greeter`
  whose `greet()` **calls `hello`** (so `call-hierarchy` has a real caller->callee edge).
- [`main.py`](./main.py) — `from greeter import Greeter`, `Greeter("world")`, `greet()`
  (so `references`/`type-definition`/`rename` cross files).

The LSP engine is **language-agnostic** — there is no Python-specific code in
[`@strummer/lsp`](../../../packages/lsp). All you change versus the greeter quickstart is the
operator-bound server registry ([`servers.json`](./servers.json) binds `python` to
`pyright-langserver`). The recorded fixtures the gate replays for this server live in
[`packages/lsp/test/fixtures/README.md`](../../../packages/lsp/test/fixtures/README.md)
(captured against this exact project); here it is a project **you run live**, not a recording.

## Prerequisites

`strummer lsp` spawns the operator-bound server as a subprocess — it does **not** bundle one.
Install [pyright](https://github.com/microsoft/pyright) (the language server) so
`pyright-langserver` is on `PATH`:

```bash
pip install pyright            # the PyPI wrapper; downloads the matching node bundle on first run
# or:  uv tool install pyright
# or:  npm install -g pyright
```

(this quickstart was verified against **pyright 1.1.410**). The operator registry is in
[`servers.json`](./servers.json) — pass it with `--servers "$(cat servers.json)"` or set
`STRUMMER_LSP_SERVERS` to its contents.

## Driving it

```bash
S="node packages/cli/dist/bin.mjs"             # from the repo root, after `pnpm -r build`
P=examples/lsp/pygreeter
export STRUMMER_LSP_SERVERS="$(cat $P/servers.json)"

# Which languages are bound (no server spawned):
$S lsp languages

# Navigation needs --allow-run (it spawns a code-executing indexing daemon) and
# --project (the allowlisted root). Positions are 1-based; columns count code points.

# Jump from the hello(...) CALL (greeter.py:16:16) to its declaration (greeter.py:4:5):
$S lsp definition python greeter.py 16 16 --project $P --allow-run

# Hover type/signature of the Greeter class (greeter.py:9:7):
$S lsp hover python greeter.py 9 7 --project $P --allow-run

# The file outline (no position):
$S lsp symbols python greeter.py --project $P --allow-run

# Type of the `greeter` value in main.py (main.py:3:1) -> class Greeter:
$S lsp type-definition python main.py 3 1 --project $P --allow-run

# Who calls hello? (incoming edge: Greeter.greet -> hello)
$S lsp call-hierarchy python greeter.py 4 5 --project $P --allow-run

# Search the WHOLE project for a symbol by name (no position). The trailing file is an
# ANCHOR: pyright builds its project lazily, so pass any project file to establish it:
$S lsp workspace-symbols python Greeter greeter.py --project $P --allow-run

# Errors/warnings for a file (no position). The greeter is clean -> 0 problems; introduce a
# type error to see one. pyright PUSHES diagnostics after analysis, so a cold call waits out
# indexing (exit 2 = not_ready, retry):
$S lsp diagnostics python greeter.py --project $P --allow-run

# Rename the Greeter class (greeter.py:9:7) — CROSS-FILE. DRY-RUN by default: prints the
# proposed edits (the declaration + the import & usage in main.py) and writes nothing:
$S lsp rename python greeter.py 9 7 Welcomer --project $P --allow-run
# Add --allow-write to write the edits to disk across both files, with SHA-256 digests:
$S lsp rename python greeter.py 9 7 Welcomer --project $P --allow-run --allow-write
```

## pyright behavior worth knowing

Different language servers answer differently; the engine handles each over the same protocol.
pyright's notable traits (all observed live against this project):

- **`references` AND `rename` are scoped to the OPEN files** (plus the queried file and
  whatever pyright has already analyzed). pyright does **not** scan unopened workspace files for
  uses of a symbol — a `references`/`rename` query on a *declaration* finds only the open file(s).
  Verified: opening more files surfaces exactly those files' uses and **no more** (greeter alone →
  1 ref; greeter + two importers open → 5; etc., scaling linearly with the open set), and a rename
  on a 62-file project from the declaration edits **only the declaration**, missing every importer.
  > **⚠️ This makes a pyright cross-file `rename` potentially INCOMPLETE.** Strummer applies
  > exactly the edit the server returns, so a rename from a declaration can silently rewrite only
  > some files and break the importers it didn't touch. **In this tiny 2-file example the rename IS
  > complete** — but only because pyright auto-analyzes the entire (2-file) workspace; do **not**
  > generalize that to a real project. For a complete cross-file rename with pyright you must have
  > the referencing files open (which defeats "rename everywhere"), or use a server that does
  > whole-project rename (tsserver, rust-analyzer, gopls). An **anchor file does not help** — it only
  > extends coverage to the files you explicitly open, not to the ones you'd need to discover.
  This is a pyright capability limitation, not a Strummer wire bug; cross-file *definition* and
  *type-definition* resolve fine (single-target module resolution, unaffected by the scope).
- **No `serverInfo`.** pyright does not report its name/version over LSP, so results carry a
  `versionWarning` (the answer cannot be attributed to a specific server version). pyright also
  sends no `positionEncoding`, so the engine uses the spec default **utf-16**.
- **PUSH diagnostics.** pyright advertises no pull `diagnosticProvider`, so `lsp_diagnostics`
  uses the push model (`textDocument/publishDiagnostics`); its diagnostic `code` is a **string**
  rule name (e.g. `reportAssignmentType`), not a number.

## Cross-file results & the indexing wait

See the [greeter README](../greeter/README.md#cross-file-results--the-indexing-wait) — the
tri-state (`ok` / `no_result` / `not_ready`), the cold-query indexing pause, `--timeout-ms`,
multi-root (`--workspace-root`), and the exit-code contract all apply identically here. (One
Python note: pyright signals status via `window/logMessage`, not `$/progress`, so the engine's
indexing-wait does not trigger for it; single-target answers — definition/hover/type-definition —
are reliable, but the **whole-workspace** answers, `references` and `rename`, are bounded by the
open-file scope described above, not by the wait.)
