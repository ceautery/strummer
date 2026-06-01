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
