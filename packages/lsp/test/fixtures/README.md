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
`initialize-result-utf8.json`) applies. The resource-op and `needsConfirmation`-annotation
branches are exercised by inline hand-authored inputs in `normalize.test.ts` (they assert our
policy, not a server payload shape).
