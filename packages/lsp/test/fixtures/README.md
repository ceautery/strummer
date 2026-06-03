# LSP fixtures — provenance

Per ADR 0011 the deterministic gate replays **recorded real-server payloads**, not
hand-authored guesses (a hand-authored peer is a tautology that only asserts our own
assumptions). These were captured out-of-gate from a real
**`typescript-language-server` 5.3.0** (over `typescript`) driving the tiny project in
the capture harness — class `Greeter` in `greeter.ts`, used via `new Greeter(...)` in
`index.ts`:

- `initialize-result.json` — the genuine `initialize` result. Note this server emits
  **no `serverInfo` and no `positionEncoding`** (⇒ spec-default UTF-16) — exercises the
  absent-provenance / default-encoding paths.
- `definition-locationlink.json` — genuine `textDocument/definition` result, returned as
  **`LocationLink[]`** (`targetUri`/`targetRange`/`targetSelectionRange`) — the trickier
  of the two definition shapes.
- `references-locations.json` — genuine `textDocument/references`, a flat **`Location[]`**.
- `hover-markup.json` — genuine `textDocument/hover`, **`MarkupContent`** (markdown).
- `progress-begin.json` / `progress-end.json` — the genuine `$/progress` work-done
  begin/end pair the server sent while indexing ("Initializing JS/TS language features…").
- `document-symbols-flat.json` / `document-symbols-hierarchical.json` — the two
  `documentSymbol` shapes (slice-1 `normalize` fixtures).

The capability-gated read tails (ADR 0011, staged) were captured from the **same
`typescript-language-server` 5.3.0** driving an *extended* version of the project — a free
`hello(name)` function plus `class Greeter` whose `greet()` calls `hello` (so call-hierarchy
has a real caller/callee edge), `index.ts` doing `const g = new Greeter(...)`:

- `type-definition-locations.json` — genuine `textDocument/typeDefinition` on `g`. Returned
  as a flat **`Location[]`** (the server ignores `linkSupport` for typeDefinition) — exercises
  the non-link branch the definition LocationLink fixture does not.
- `call-hierarchy-prepare.json` — genuine `textDocument/prepareCallHierarchy` on `hello`: a
  **`CallHierarchyItem[]`** (`kind`/`name`/`detail`/`uri`/`range`/`selectionRange`).
- `call-hierarchy-incoming.json` — genuine `callHierarchy/incomingCalls`: `{from, fromRanges}`
  (`greet` calls `hello`).
- `call-hierarchy-outgoing.json` — genuine `callHierarchy/outgoingCalls` from `greet`: `{to,
  fromRanges}`.
- `workspace-symbols.json` — genuine `workspace/symbol` for the query `"Greeter"`. Returned as
  a flat **`SymbolInformation[]`** — each member has a `location: {uri, range}` with the range
  **present** (the server reports `workspaceSymbolProvider: true`, the boolean form; it does NOT
  send the uri-only `WorkspaceSymbol` shape that would require a `workspaceSymbol/resolve`
  round-trip). Two cross-file hits: the `greeter` const in `index.ts` (kind 14, Constant) and
  the `Greeter` class in `greeter.ts` (kind 5, Class); no `containerName`. The uri-only
  `WorkspaceSymbol` (range-absent) variant the server did not emit is exercised by an inline
  hand-authored input in `normalize.test.ts` (it asserts our range-absent policy, not a server
  payload shape — same carve-out as the rename resource-op branch).

- `diagnostics-publish.json` — a genuine `textDocument/publishDiagnostics` notification params
  object. PUSH diagnostics: the server reports problems for an open file via a notification, NOT a
  request (tsserver 5.3.0 advertises **no `diagnosticProvider`**, so the LSP 3.17 pull
  `textDocument/diagnostic` request is unavailable — push is the v1 model). Captured by temporarily
  adding a `const _bad: number = "not a number"` type error to `index.ts`. The observed timing
  settles the readiness model: `didOpen` → `$/progress` begin (+141ms) → end (+554ms, project load)
  → **publishDiagnostics (+617ms, AFTER indexing ends)**, exactly once, `version: undefined`. So
  `documentDiagnostics` opens the file, waits out the project-load `$/progress`, then awaits the
  post-settle publish. One `Diagnostic`: `severity: 1` (Error), `code: 2322` (a number), `source:
  "typescript"`, empty `tags`. A clean file publishes an empty `diagnostics` array (= no problems);
  that and the `relatedInformation`/string-`code` variants are exercised by inline inputs in
  `normalize.test.ts` (policy, not a captured server shape — the same carve-out as elsewhere).

The only edit applied to the captures is normalizing the environment-specific absolute
path prefix to a stable `/project` (structure preserved verbatim).

`initialize-result-utf8.json` is the one **documented synthesized variant**: the genuine
init result with `positionEncoding: "utf-8"` and a `serverInfo` block added, used solely
to exercise the encoding-negotiation read-back and the version-provenance branches. Those
two are stable scalar fields — not the polymorphic result shapes the "no hand-authored
guesses" rule targets — so synthesizing them carries none of the tautology risk.

## Write-mode (`lsp_rename`) captures

Captured from the **same `typescript-language-server` 5.3.0** driving the `greeter.ts` +
`index.ts` project — `class Greeter` (declared in `greeter.ts`, imported and `new`-ed in
`index.ts`) renamed to `Greeter2` at the declaration (`greeter.ts` line 4, char 14). The
client advertised the **new write capabilities** (`textDocument.rename.prepareSupport: true`
+ `workspace.workspaceEdit.documentChanges: true`).

- `initialize-result-rename.json` — the genuine `initialize` result WITH the rename client
  caps advertised. The server now reports `renameProvider: { "prepareProvider": true }` (the
  OBJECT form — versus the bare `true` in `initialize-result.json`, captured before we
  advertised `prepareSupport`), so the prepare step is meaningful and the capability
  shape-detection path is real.
- `prepare-rename.json` — the genuine `textDocument/prepareRename` result. It is a **bare
  LSP `Range`** (chars 13–20 on line 4, the `Greeter` identifier) — NOT `{range, placeholder}`,
  NOT `{defaultBehavior}`, NOT `null`. The prepare normalizer must accept this variant.
- `rename-changes.json` — the genuine `textDocument/rename` result. **It uses the legacy
  `changes` map, NOT `documentChanges`** — even though the client advertised
  `documentChanges: true`. tsserver 5.3.0 returns `changes` for an ordinary rename. Two files
  edited (`greeter.ts` ×1, `index.ts` ×2 — import binding + usage); **no** resource operations
  (`CreateFile`/`RenameFile`/`DeleteFile`) and **no** document `version` fields. This settles
  the resource-op v1-cut: refuse-on-resource-op stays an edge case, not the common path.

`rename-documentchanges.json` is a **documented synthesized variant**: the same Greeter→Greeter2
rename expressed in the `documentChanges` form (`TextDocumentEdit[]` with `version` fields),
used solely to exercise the normalizer's `documentChanges` branch — which the real server did
not return here. It tests shape detection, not a guessed payload, so the carve-out (as with
`initialize-result-utf8.json`) applies. The `needsConfirmation`-annotation branch is exercised by
inline hand-authored inputs in `normalize.test.ts` (it asserts our policy, not a server shape).

## Resource-op write-mode (`RenameFile`) captures — `rust-analyzer`

tsserver does **not** emit file resource operations on an ordinary `textDocument/rename` (confirmed
again after we flipped the client capability `workspace.workspaceEdit.resourceOperations` from `[]`
to `['create','rename','delete']` — tsserver still returns the same `changes` map with no resource
ops; the existing `rename-changes.json` stays valid). To exercise the real resource-op path we
captured from **`rust-analyzer` 0.3.2921-standalone**, whose **module rename renames the backing
file**. The capture project is a minimal no-cargo crate driven via a `rust-project.json`:
`src/main.rs` = `mod greeter;` + `fn main(){ let _g = greeter::Greeter; }`, `src/greeter.rs` =
`pub struct Greeter;`. Renaming the module `greeter` (main.rs line 0, char 4) → `welcome`:

- `initialize-result-rust.json` — the genuine `initialize` result. rust-analyzer negotiates
  **`positionEncoding: "utf-8"`** (so the resource-op path also exercises the utf-8 offset math),
  reports `renameProvider: { "prepareProvider": true }`, and a real `serverInfo`
  (`rust-analyzer` / `0.3.2921-standalone`).
- `rename-renamefile.json` — the genuine `textDocument/rename` result, in **`documentChanges`**
  form: a `TextDocumentEdit` on `main.rs` (the `mod` decl + the `greeter::` path, ×2) **followed by
  a `RenameFile`** (`kind:"rename"`, `oldUri: src/greeter.rs` → `newUri: src/welcome.rs`, **no
  `options`**). This is the real interleaved edits-plus-resource-op shape the apply engine executes.
- `rename-edit-renamefile.json` — the genuine `textDocument/rename` result for the
  **editing-a-renamed-file** safe-subset case. A variant capture project gives the module file a
  self-reference to its own crate path (`src/greeter.rs` = `pub struct Greeter;` +
  `pub fn make() -> crate::greeter::Greeter { Greeter }`). Renaming the module `greeter`→`welcome`
  edits `main.rs` (×2) **and** `greeter.rs` (×1, fixing the `crate::greeter::` self-reference)
  **then** `RenameFile`s `greeter.rs`→`welcome.rs` — so the module file is **edited AND renamed in
  one batch** (`documentChanges` order: edit main, edit greeter, rename greeter→welcome). Replayed
  through both the normalizer (`normalize.test.ts`) and the **apply engine** (`rename.test.ts`,
  rebasing `/project` onto a temp root) to prove the moved `welcome.rs` carries the edited
  `crate::welcome::` content. This is the batch the pre-safe-subset apply engine hard-refused.

Readiness note (captured behavior, drove the `client.ts` readiness generalization): rust-analyzer
returns a `ResponseError -32602 "No references found at position"` when `rename` is queried **before
`cachePriming` ends** (and the rename is refused outright unless the client advertises
`resourceOperations`, since the edit needs a `RenameFile`). The gate replays this via the fake peer;
no real server runs in `pnpm gate`.

## Python adapter captures — `pyright`

The LSP pillar is language-agnostic, but ADR 0011 wants the gate to replay a **real payload** from
every server we claim to support, not assume one server's shapes generalize. These were captured from
**`pyright-langserver` 1.1.410** (the PyPI `pyright` wrapper) driving
[`examples/lsp/pygreeter`](../../../../examples/lsp/pygreeter) — a free `hello(name)` and a `class
Greeter` whose `greet()` calls it (`greeter.py`), imported and `Greeter("world")`-ed in `main.py`.
pyright differs from tsserver and rust-analyzer in ways that exercise paths neither did against a real
payload:

- `initialize-result-pyright.json` — the genuine `initialize` result. pyright sends **no
  `serverInfo`** (⇒ unattributable provenance, `versionWarning`) and **no `positionEncoding`** (⇒
  spec-default utf-16), advertises **object-form** provider capabilities (`definitionProvider:
  {workDoneProgress: true}`, etc. — exercises `supports()` treating an object as enabled), a
  `renameProvider: {prepareProvider: true, workDoneProgress: true}`, a bare `callHierarchyProvider:
  true`, and **no `diagnosticProvider`** (⇒ the push diagnostics model).
- `definition-pyright.json` — genuine `textDocument/definition`, returned as a **flat `Location[]`**
  even though the client advertised `linkSupport: true` (pyright ignores it for definition — unlike
  tsserver's `LocationLink[]`). The flat-`Location` definition branch, from a real payload.
- `rename-pyright-documentchanges.json` — genuine `textDocument/rename` for `Greeter`→`Welcomer`, in
  the **`documentChanges`** form (`TextDocumentEdit[]`) with **`version: null`** and **no resource
  ops** — multi-file (the `greeter.py` declaration + the `main.py` import binding & usage). This is a
  **real** payload for the `documentChanges` rename branch that `rename-documentchanges.json` only
  *synthesized* (tsserver returns the legacy `changes` map; rust-analyzer's documentChanges carried a
  `RenameFile`; pyright is the plain multi-file documentChanges with a null version). Verified live:
  `--allow-write` applies it across both files and the project still type-checks clean.
- `diagnostics-publish-pyright.json` — a genuine `textDocument/publishDiagnostics` params object
  (PUSH; pyright advertises no pull provider). Its `code` is a **string** rule name
  (`reportAssignmentType`), not a number — captured by giving `bad.py` a `result: str = add(1, 2)`
  type error. `source: "Pyright"`, `severity: 1` (Error).

Behavioral note (observed live, documented in the example README, not a code fix): pyright's
`references` AND `rename` are scoped to the OPEN files (+ the queried file + whatever pyright has
already analyzed). It does not scan unopened workspace files, so on a non-trivial project a
`references`/`rename` query on a *declaration* misses every file that is not open — coverage scales
linearly with the open set (verified), and a rename can therefore be silently INCOMPLETE across
files. An anchor file does not fix it (it only extends coverage to the files you explicitly open).
The tiny 2-file pygreeter rename looks complete only because pyright auto-analyzes the whole 2-file
workspace; do not generalize. A server capability difference, not a Strummer wire bug — but Strummer
must not claim a completeness pyright does not provide. Provenance note:
pyright has no clean single-package toolchain mapping (its analysis bundles its own typeshed; "answer
for the installed version" means the analyzed libraries, not one package), so — unlike `typescript` →
the `typescript` package — `bin-lsp.ts` deliberately maps **no** toolchain for `python`; the
`versionWarning` is the correct, honest signal.

Paths in all four are normalized to a stable `/project` prefix; structure is verbatim. The gate
replays them via the fake peer — no real server runs in `pnpm gate`.
