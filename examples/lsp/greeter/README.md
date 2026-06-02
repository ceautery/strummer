# greeter — sample project for `strummer lsp`

A tiny, real TypeScript project to drive the [`strummer lsp` CLI](../../../packages/cli/README.md#verification-phase-4-pillars)
against a live Language Server. Two files:

- [`greeter.ts`](./greeter.ts) — a free `hello(name)` function and a `class Greeter`
  whose `greet()` **calls `hello`** (so `call-hierarchy` has a real caller→callee edge).
- [`index.ts`](./index.ts) — `import { Greeter }`, `new Greeter('world')`, `greet()`
  (so `references`/`type-definition` cross files).

This is the same shape the LSP pillar's recorded fixtures were captured against
(see [`packages/lsp/test/fixtures/README.md`](../../../packages/lsp/test/fixtures/README.md));
here it is a project **you run live**, not a recording.

## Prerequisites

`strummer lsp` spawns the operator-bound server as a subprocess — it does **not** bundle
one. Install the TypeScript language server (and TypeScript) so it is on `PATH`:

```bash
cd examples/lsp/greeter
npm install            # installs the pinned typescript + typescript-language-server
export PATH="$PWD/node_modules/.bin:$PATH"
```

(or install `typescript-language-server` globally). The operator registry is in
[`servers.json`](./servers.json) — pass it with `--servers "$(cat servers.json)"` or set
`STRUMMER_LSP_SERVERS` to its contents.

## Driving it

```bash
S="node packages/cli/dist/bin.mjs"             # from the repo root, after `pnpm -r build`
P=examples/lsp/greeter
export STRUMMER_LSP_SERVERS="$(cat $P/servers.json)"

# Which languages are bound (no server spawned):
$S lsp languages

# Navigation needs --allow-run (it spawns a code-executing indexing daemon) and
# --project (the allowlisted root). Positions are 1-based; columns count code points.

# Jump from the hello(...) CALL (greeter.ts:11:12) to its declaration:
$S lsp definition typescript greeter.ts 11 12 --project $P --allow-run

# Every reference to hello (declaration greeter.ts:2:17 + the call in greet):
$S lsp references typescript greeter.ts 2 17 --project $P --allow-run

# Hover type/signature of the Greeter class (greeter.ts:7:14):
$S lsp hover typescript greeter.ts 7 14 --project $P --allow-run

# The file outline (no position):
$S lsp symbols typescript greeter.ts --project $P --allow-run

# Who calls hello? (incoming edge: Greeter.greet → hello)
$S lsp call-hierarchy typescript greeter.ts 2 17 --project $P --allow-run

# Type of the `greeter` value in index.ts (index.ts:3:7) → class Greeter:
$S lsp type-definition typescript index.ts 3 7 --project $P --allow-run

# Rename hello → greetWith (greeter.ts:2:17). DRY-RUN by default — prints the
# proposed edits (the declaration + its call in greet) and writes nothing:
$S lsp rename typescript greeter.ts 2 17 greetWith --project $P --allow-run
# Add --allow-write to actually write the edits to disk, with per-file SHA-256 digests:
$S lsp rename typescript greeter.ts 2 17 greetWith --project $P --allow-run --allow-write
```

### A note on cold, single-shot resolution

Each invocation opens **only the queried file** and asks the server once. `tsserver`
answers an early request from a single-file *inferred* project before it has finished
loading the `tsconfig.json` project, so a **cold** `references`/`rename` sees only the
symbols in the opened file. `hello` lives entirely in `greeter.ts`, so renaming it
rewrites both its uses; but renaming `Greeter` *from `greeter.ts`* rewrites only its
declaration and misses the `index.ts` import/usage (run `references` from each side to
see this — `Greeter` from `index.ts:3:21` finds the two `index.ts` sites, `Greeter` from
`greeter.ts:7:14` finds only the declaration). `type-definition` still crosses files
because that is forward module resolution (the server reads the imported file), not a
project-wide reverse search. Project-wide cross-file rename depends on the full project
being loaded — tracked as a staged LSP tail (project load / multi-root). For now, prefer
single-file symbols (like `hello`) for `--allow-write`, and review the dry-run preview
first.

A result `status` is tri-state — `ok`, `no_result`, or `not_ready` (the server is still
indexing; **retry**). Exit codes: `0` the query ran, `1` denied/refused/error, `2`
`not_ready`. Each invocation is single-shot: the CLI spawns the server, runs one query,
and shuts it down.
