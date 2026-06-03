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

- **`references` is scoped to open files + their import dependencies; `rename` is
  whole-workspace.** `references` on the `Greeter` *declaration* (`greeter.py:9:7`) returns
  only the declaration, because `main.py` (which imports `Greeter`) is not a dependency of the
  open `greeter.py` and pyright does not scan reverse-dependencies for a plain reference search.
  To get the cross-file uses, query `references` from a file that **uses** the symbol (e.g.
  `main.py:3:11`). **`rename`, by contrast, forces a full-workspace scan** — the dry-run above
  correctly edits both files — so a rename is safe and complete even from the declaration. This
  is a pyright capability difference, not a Strummer limitation; cross-file *definition* and
  *type-definition* resolve fine (module resolution).
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
Python note: pyright signals status via `window/logMessage`, not `$/progress`, but it answers
navigation requests completely once the program is loaded, so the wait is rarely observable.)
