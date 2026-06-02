# ADR 0011 — `@strummer/lsp`: the semantic-navigation LSP bridge

- **Status:** Accepted (design; no production code yet)
- **Date:** 2026-06-01
- **Relates to:** ADR 0010 (Phase-4 sequencing — LSP is "last"), ADR 0006/0007
  (browser pillar + container hardening — the right subprocess analogy),
  ARCHITECTURE §1 (the no-live-RPC polyglot rule this pillar is the documented
  exception to).

## Context

`@strummer/lsp` is the final Phase-4 candidate (ADR 0010 sequence step 5): semantic
code navigation — go-to-definition, find-references, hover, and (staged)
type-definition / document-symbols / call-hierarchy — by driving a real **Language
Server Protocol** server as a subprocess and exposing its answers to an agent over
MCP. It has the **highest raw leverage** of the five candidates and was sequenced
**last** for one reason: it is the only candidate that breaks ARCHITECTURE §1's
"the polyglot boundary is a file, never a live RPC" rule outright — it holds a
live, stateful, bidirectional JSON-RPC session with a version-coupled subprocess.

Per CLAUDE.md (brainstorm-before-building, fan-out, adversarial verification) the
design was produced by a research workflow: three parallel research streams
(LSP protocol mechanics; the Node/TS client + prior-art survey; Strummer-fit
grounded in the shipped pillars) → synthesis → **two adversarial critics**
(determinism/correctness; architecture-fit). As with ADR 0010, the adversarial
pass materially changed the design and caught concrete traps; the corrections are
recorded below rather than trusted as-proposed. **No production code is written by
this ADR** — it is the design contract for the slices that follow.

## Decision

### The right analogy is the browser subprocess, not the test runner

The shipped code-running pillars (`coverage` `runScoped`, `flake` `runAndRecord`,
`mutate` `runMutation`) all spawn a *known, single, short-lived, trusted* binary
(`vitest`/`stryker`) scoped to running tests. **An LSP server is none of those** —
it is a **long-lived, stateful daemon** that indexes (and for several languages
*executes*) the **entire workspace tree**, and stays resident across many tool
calls. The correct precedent is therefore the **browser pillar** (ADR 0006/0007 —
a resident, code-executing subprocess that earned its own hardening ADR), not the
test-runner gate. We reuse the test-runners' *gate shape* (paired
`allowRun` + `allowedRoots` + injected spawn seam) but re-derive the *threat model*
from the browser pillar (below). This reframing resolves most of the adversarial
findings.

### `@strummer/lsp` is the documented exception to ARCHITECTURE §1

ARCHITECTURE §1: "Polyglot core, file-based boundary … No live RPC." ADR 0010
already named LSP "the only candidate that violates §1 outright." We keep that
honest framing — this pillar **is** a live-RPC subprocess — and do **not** launder
it through the flake-private-SQLite analogy (flake's second store is a *file*,
squarely §1-compatible; an LSP session is the opposite). The exception is fenced by
hard invariants:

- **§1 itself is untouched.** The only TS↔Python boundary remains the SQLite index
  file + its schema. LSP is TS↔external-process and crosses **no** Strummer language
  boundary.
- **The LSP subprocess must never open `schema/strummer.schema.sql` or any Strummer
  SQLite.** The docs index is off-limits to it.
- **Results are ephemeral.** No LSP output is cached into the index or persisted
  beyond an in-flight call's `@strummer/artifacts` handle.

This keeps §1 a bright line with one named, fenced exception — not a fuzzy carve-out
the next contributor reaches for elsewhere.

### Threat model & safety (re-derived from the browser pillar, not inherited)

Spawning a language server is **consent to run the project's build/plugin tooling**,
not merely to start a stdio process. rust-analyzer runs `build.rs` and proc-macros;
gopls invokes `go` (module downloads → network); tsserver loads `tsconfig` plugins.
"Reads-only v1" describes *our RPCs*, not the server's runtime behavior. Therefore:

- **Paired deny-by-default operator gate** (the house shape): `allowRun` (boolean,
  deny-by-default) + `allowedRoots` (allowlist, load-bearing on its own) + a
  per-request wall-clock cap. `allowRun` is load-bearing **precisely because
  indexing executes project code** — same trust level as `coverage runScoped`
  running the project, stated explicitly, not as an aside.
- **`rootUri`/`workspaceFolders` are pinned to the operator-allowlisted root**; the
  manager refuses to `initialize` a server against anything outside it. `allowedRoots`
  is documented as a **logical** guard, not an OS sandbox.
- **Runs inside the ADR-0007 hardened container** (the same boundary as the browser
  renderer), never on a developer host with broad filesystem access. Hardened,
  operator-configurable server init options where they exist (e.g. gopls
  `GOFLAGS=-mod=readonly` + telemetry off; rust-analyzer `cargo.buildScripts.enable=
  false` / `procMacro.enable=false`; disable update checks) ship as defaults.
- **Operator binds the language→command registry; the agent supplies only a
  `language` string.** A language absent from the operator registry is refused, never
  spawned. No tool input can name a binary, argv, or path. The registry is **JSON**
  (`STRUMMER_LSP_SERVERS`), with `command` and `args[]` **structurally separate** —
  never a `lang=cmd args;…` mini-DSL the engine re-splits (server commands routinely
  contain spaces, `=`, and wrapper prefixes like `rustup run …`).

### Position encoding is the #1 correctness risk — a pure, separately-tested core

LSP `Position.character` is an offset in **code units of the negotiated encoding**
(default **UTF-16**), 0-based — *not* a column. JS strings are already UTF-16, so a
naive `col-1` "conversion" passes every ASCII test and then silently returns the
**wrong symbol's** definition on any line containing a non-BMP char (emoji, CJK
identifiers, combining marks) once a server negotiates UTF-8. This is the worst
failure class for an agent tool: plausible, wrong, silent. Mitigations are
load-bearing, not optional:

- A pure `toLspCharacter(lineText, humanCol, encoding)` (and its inverse for mapping
  result ranges back to human 1-based line:col) with **three real implementations** —
  UTF-16 (code units), UTF-8 (`Buffer.byteLength`), UTF-32 (code points) —
  **unit-tested with non-BMP fixtures**. This is the highest-value test in the
  package and is fully deterministic (no server needed).
- Advertise `general.positionEncodings: ["utf-16","utf-8"]` (UTF-16 first — the
  well-tested JS-native path), then **read back `ServerCapabilities.positionEncoding`
  and do all offset math in that unit**. Absent ⇒ spec default UTF-16. **Present but
  unsupported ⇒ fail loud** with a structured error — never silently default.
- Send file bytes **verbatim** (strip a leading BOM for column math; do **not**
  normalize CRLF→LF — the text we `didOpen` is the server's source of truth and must
  match the file the agent reads). "Column" counts code units, documented.

### Lifecycle: one server per (language, root), shared, with a per-target mutex

A `LanguageServerManager` modeled on `BrowserManager` (lazy spawn, idle-TTL reaper,
caps, `onReap`/`onClosed`, injected clock) — but with three deliberate divergences
the browser analogy hides:

- **Keyed by `(language, projectRoot)`, shared across MCP sessions** (not one
  ephemeral context per session). A server is expensive to spawn and *warm* (indexing
  can take seconds-to-minutes), so a **longer idle TTL** than browser's, and re-use
  across calls.
- **Per-`(server, uri)` async mutex** (the analog of the browser per-session mutex,
  which this design must NOT omit). JSON-RPC id-correlation makes concurrent
  *requests* safe, but the **document lifecycle is shared mutable state**: two
  concurrent queries each sending `didOpen(version 1)` on the same file is a protocol
  violation. Resolution: **open-once, reference-count, and do NOT `didClose` by
  default** (close only on reap); the mutex serializes the open+query critical
  section per file.
- **The reaper respects an in-flight counter** and resets the idle clock on request
  *start*: never reap a server with `inFlight > 0`; on reap send LSP `shutdown` →
  `exit` with a **clock-driven grace period** before SIGKILL (deterministic in tests).

### Readiness is tri-state — never collapse "not ready" into "no result"

There is no spec "ready" signal; indexing servers return `null`/empty *before* the
index lands. Collapsing that into "no definition" is a silent lie an agent will act
on. Therefore every navigation result is **tri-state**:
`{status:"ok", …}` | `{status:"not_ready", …}` | `{status:"no_result"}`.

- **One authoritative deadline = the operator timeout.** The bounded retry/backoff
  lives *inside* it (no second 30s clock racing the operator cap). Gate the retry on
  `$/progress`: while an indexing work-done-progress token is active, return
  `not_ready` fast rather than burning the budget; only bounded-backoff when no
  progress signal is seen but the result is empty. The first call returns
  `not_ready` quickly rather than blocking for the full budget.
- The client must **answer every inbound `id`-bearing server request** (`workspace/
  configuration` → array of `null`; `window/workDoneProgress/create` → `null`;
  `client/registerCapability` → `null`) or it deadlocks; in particular it must answer
  `workDoneProgress/create` *before* expecting the `$/progress` that drives readiness.

### Version provenance — honoring "answer for the installed version"

CLAUDE.md elevates "answer for the version actually installed; never silently wrong"
to an architecture rule (the whole `deps` pillar exists for it). An LSP answer is
doubly version-coupled (server version × project toolchain). v1 does **not** punt all
version-awareness (that would violate the principle, not merely defer it):

- **Record `serverInfo.{name,version}` from the `initialize` result in every
  navigation result and on every artifact handle** — free (it is in the protocol),
  and turns "silently wrong" into "wrong-but-attributed".
- **v1 warn-on-mismatch**: reuse `@strummer/core` `detectInstalledVersion` to detect
  the project's typescript/go/rust toolchain and emit a non-fatal `versionWarning`
  when the bound server's reported version is implausible for it. The full
  toolchain-resolution matrix stages; the warn hook is a v1 obligation.

### Dependency choice: lean on the reference transport (the playwright-core pattern)

Use Microsoft's **`vscode-jsonrpc`** (Content-Length framing + JSON-RPC id
correlation + notification/request dispatch) and **`vscode-languageserver-protocol`**
(typed LSP method/param/result constants) via their `/node` entry points. **Not**
`vscode-languageclient` (editor-coupled — imports the `vscode` namespace, unusable
headless). **Not** hand-rolled framing: this is the *playwright-core* situation (stay
thin on the reference transport), **not** the bru/Postman-importer situation (those
were hand-rolled only because the converter was unavailable offline — a forced move,
not a preference). Hand-rolling ~200 lines of framing buys nothing and gets the
correctness corners (charset, partial reads, cancellation, progress tokens) subtly
wrong. Per ADR 0010's "explicit pins, no transitive imports": **both packages are
added as explicitly pinned direct deps** of `@strummer/lsp` (3.17.x line, stable,
no native build); the protocol package is imported **types-only** where possible so
its churn lands as a type-level, not runtime, coupling.

### Determinism: a fake in-process peer replaying RECORDED real-server payloads

The green gate **never spawns a real language server** (stricter than the
`skipIf(dependencyPresent)` posture of coverage/flake/mutate — a real server's
indexing timing and version drift genuinely cannot meet the determinism bar a real
`vitest` can; called out as a deliberate deviation). Instead:

- The engine takes an **injected `serverSpawn` seam** returning an LSP connection;
  tests wire a **fake in-process JSON-RPC peer** — a second `createMessageConnection`
  over paired in-memory duplex streams (vscode-jsonrpc's own `TestDuplex` harness) —
  exercising real Content-Length framing + id correlation while staying offline.
- **The fake peer replays recorded *real-server* payloads**, not hand-authored
  guesses (a hand-authored peer is a tautology that asserts your own assumptions). We
  capture one real `initialize` result + `definition`/`references`/`hover` responses
  from `typescript-language-server`/`gopls`/`rust-analyzer` (out-of-gate, operator-run)
  and **commit the JSON** as fixtures the deterministic gate replays. This turns the
  gate from a tautology into a real net for the encoding/shape bugs (below).
- **All time-based code goes through the injected clock** (retry/backoff AND reaper);
  tests use the fake clock + a `noRetry`/single-attempt mode, and assert the
  production code never calls `setTimeout`/`setInterval` directly. `$/progress`
  sequences are driven step-by-step by the test, not raced via immediates.

### Result normalization — the other silent-wrong vectors

A pure `normalize.ts` (the unit-testable core, analogous to `summarizeMutation` /
`uncoveredInDiff`) that handles the protocol's polymorphism explicitly:

- **`Location` vs `LocationLink`**: definition/typeDefinition can return
  `Location | Location[] | LocationLink[] | null`; `LocationLink` uses
  `targetUri`/`targetRange` (different field names) — one `normalizeLocations()`
  handles all branches; set `linkSupport` deliberately and test both shapes.
- **`documentSymbol`** returns hierarchical `DocumentSymbol[]` *or* flat
  `SymbolInformation[]` — shape-detect and normalize.
- **Call-hierarchy** (staged): `prepareCallHierarchy` may return `null` (distinct from
  "no callers"), or **multiple items** (overloads) — return all, never silently follow
  only the first.
- Gate every request on its `*Provider` capability (treat any non-`false`/non-absent
  value as enabled); map result ranges back to human 1-based line:col via the same
  encoding-aware converter (inverse direction).

### MVP cut, the tool surface, and staging

The v1 cut is the **de-risking MVP**, not an arbitrary line:

- **v1 tools: `lsp_find_definition`, `lsp_find_references`, `lsp_hover`** — universal,
  single-round-trip, highest agent value. (Hover was wrongly dropped in the draft and
  is restored; call-hierarchy was wrongly kept and is staged — it is an optional
  capability many servers lack and is a two-round-trip protocol.)
- **All navigation tools are gated as a group** behind the operator gate — there is
  **no "free read" tier** here (unlike `search_docs`/`list_requests`), because every
  navigation answer requires a live, code-executing, indexing daemon to exist. The one
  always-on, no-spawn tool is **`lsp_languages`**, expanded to report, per bound
  language: the language id, whether a server is bound (never the command/path — no
  operator-secret leakage), and once a server has initialized in-session, its
  **advertised capabilities + `serverInfo.version`** — so the agent never calls an
  unsupported tool and always knows the provenance.
- Tool naming follows the house `verb_noun` form (`lsp_find_definition`), documented.
- Large results (hundreds of references, document symbols for a big file) return a
  **compact head inline + the full list by handle** via `@strummer/artifacts` (prefix
  `lsp`, resource `strummer://lsp/{id}/{kind}`, registered only when a store is set) —
  the deps/coverage rule. A file body is **never** inlined.
- **Staged, not amputated** (CLAUDE.md directive 4 — recorded in ROADMAP):
  `lsp_type_definition`, `lsp_document_symbols`, `lsp_call_hierarchy` (behind
  per-server capability detection); then write-mode (`rename`), `workspace/symbol`
  search, `diagnostics`, multi-root, full toolchain-version resolution, and a Python
  adapter posture. v1 stays reads-only and operator-command-bound.

### Proposed module layout (`packages/lsp/src/`)

- `encoding.ts` — pure `toLspCharacter` / inverse (utf-8/16/32). *First slice.*
- `normalize.ts` — pure LSP-result → compact-Strummer-shape reducers (locations,
  symbols, hover, tri-state). Pure, fixture-tested. *First slice.*
- `client.ts` — the LSP JSON-RPC client over a connection (handshake, capability
  gating, didOpen/refcount, tri-state query, deadlock-safe inbound replies); holds the
  injected `serverSpawn` seam + `defaultServerSpawn` (real `child_process.spawn`).
- `manager.ts` — `LanguageServerManager` ((language,root) keyed, mutex, reaper).
- `registry.ts` — the operator-bound JSON language→`{command,args[],initializationOptions}`
  registry.
- `query.ts` — the gated engine `lspQuery(config, input, deps)` mirroring `runScoped`
  (`LspGateError`, `assertAllowed`, deadline, injected spawn).
- `index.ts` — barrel.

MCP surface in `packages/mcp/src/lsp.ts` + `bin-lsp.ts`; env
`STRUMMER_LSP_ALLOW_RUN` / `_PROJECT_ROOTS` / `_TIMEOUT_MS` / `_SERVERS` (JSON) /
`_ARTIFACT_DIR` (+ optional `_MAX_SERVERS` / `_IDLE_TTL_MS`), parsed with the shared
`bool`/`csv`/`num` helpers; the executable-tail guard copied verbatim.

## Consequences

- The first slice is the **pure `encoding.ts` + `normalize.ts` core** (no spawn, no
  network) over committed real-server-payload fixtures — the most defensible TDD
  entry, and it pins down the two worst silent-wrong vectors (encoding, result-shape)
  before any process is spawned. Then the `client.ts` handshake/tri-state against the
  fake in-process peer; then the gated `manager`/`query` engine; then the MCP surface
  + bin.
- `@strummer/lsp` is the **documented, fenced exception** to ARCHITECTURE §1; §1
  otherwise stands. A future ARCHITECTURE update should cite this ADR at §1.
- The pillar deliberately has **no real-server test in `pnpm gate`** — a stricter
  determinism posture than the other Phase-4 pillars, justified and recorded here.
- The research + adversarial transcript is the workflow `lsp-bridge-design`; this ADR
  is its durable distillation.


---

## Addendum (2026-06-01) — write-mode (`lsp_rename`) design contract

> Produced by the `lsp-write-mode-design` fan-out (3 research streams → synthesis → 2 adversarial
> critics → corrected contract), the same process that produced this ADR. Status: **Proposed**;
> implemented across the slices in §8. Human decision (2026-06-01): **multi-file apply ships within
> this milestone** (Slice F then F′). Resource-op refuse / hard-refuse-on-drift / per-file SHA-256
> audit are the accepted defaults.

# ADR-0011 Update — `lsp_rename` Write-Mode Design Contract

- **Status:** Accepted — IMPLEMENTED across slices A–G (2026-06-01). Multi-file apply shipped
  within the milestone (Slice F′), per the human decision. The fixture capture confirmed tsserver
  5.3.0 returns the legacy `changes` map (not `documentChanges`) + a bare-`Range` `prepareRename`
  + no resource operations on an ordinary rename — so the resource-op refuse cut stays an edge
  case. Extends ADR-0011 (the LSP bridge).
- **Date:** 2026-06-01
- **Relates to:** ADR-0011 (parent), ADR-0006 (the browser action gate — the dry-run/execute precedent), ARCHITECTURE §1 (the no-live-RPC rule this pillar is the fenced exception to).

## 1. Overview

`lsp_rename` adds the first **write** capability to `@strummer/lsp`: a semantic, cross-file symbol rename driven by the live language server's `textDocument/rename`. It is the final staged tail of Phase 4 and the documented extension of ADR-0011's live-LSP exception to ARCHITECTURE §1.

**Posture (locked):** `lsp_rename` is **dry-run by default** — it computes the server's `WorkspaceEdit`, normalizes and validates it (offsets, overlap, confinement), and returns a human-readable preview with **zero disk writes and zero server-state mutation**. It applies to disk **only** behind a **separate operator gate `allowWrite`** that is distinct from and strictly *requires* the read gate `allowRun` (`allowWrite` is meaningless without `allowRun` — see §4). Every edited file is confined to the allowlisted project root, **realpath-hardened**, before any byte is read or written. Apply stages all files in memory, then commits temp-file-then-atomic-rename.

**v1 scope cut (staged, not amputated):** v1 applies only `TextDocumentEdit` text edits. Any `WorkspaceEdit` containing `CreateFile`/`RenameFile`/`DeleteFile` resource operations is surfaced in the preview but **refused on apply** — refusal is **unconditional and early**, before any confinement, read, or staging work. **v1 also refuses any multi-file rename until the multi-URI lock primitive lands** (§4) — until then write-mode applies only when every edited URI equals the queried URI; multi-file renames are previewable but not applicable. Full conflict reconciliation, resource-op execution, multi-file write, and a `strummer lsp` CLI remain staged.

## 2. Protocol handling

### 2.1 `initialize` handshake additions (`client.ts:248-261`)

Add under `textDocument`:
```ts
rename: { dynamicRegistration: false, prepareSupport: true, prepareSupportDefaultBehavior: 1 }
```
(`prepareSupportDefaultBehavior: 1` = `Identifier`.) `honorsChangeAnnotations` is **omitted** — v1 does not consume annotations.

Add a new `workspace.workspaceEdit` block:
```ts
workspaceEdit: { documentChanges: true, resourceOperations: [], normalizesLineEndings: false }
```
**Decisions:**
- `documentChanges: true` — gets the ordered, versioned form tsserver actually emits; this is what our fixtures test against.
- `resourceOperations: []` (empty, **not** `['create','rename','delete']`) — honestly signals we do **not** apply file ops, nudging well-behaved servers toward pure-`TextEdit` renames. We still defend against servers that send them anyway (refuse on apply). **Whether tsserver 5.3.0 honors the empty array on an ordinary rename is a Slice-B fixture-capture blocker** (Open Q in §10 / §7): if the real payload routinely contains resource ops on common renames, the v1 refuse path is the common path and the v1 cut must be revisited *before* coding the refuse logic.
- `changeAnnotationSupport` is **not** advertised. A spec-compliant server therefore will not send annotations. If one does anyway, an `AnnotatedTextEdit` carrying a **`needsConfirmation`** annotation is kept in the **preview only** (surfaced as `needsConfirmation: true` + the annotation label) and **excluded from apply**; a non-confirmation annotation is normalized to `{range,newText}` with the label preserved in preview metadata. Annotations are never silently dropped (closing critic 2-finding-12).
- `normalizesLineEndings: false` — Strummer sends bytes verbatim; the apply core never normalizes CRLF, consistent with `encoding.ts`.

### 2.2 `textDocument/rename`

Add `RenameRequest` to imports (`client.ts:40-58`). New method:
```ts
client.rename(uri, position, newName): Promise<NavResult<WorkspaceEdit | null>>
```
Gated on `renameProvider` via the existing `supports()` helper (reused verbatim, throws `LspUnsupportedError`). Rides the **existing `withRetry`/tri-state loop**: a `null`/empty result while indexing is `not_ready`, not "cannot rename".

### 2.3 `textDocument/prepareRename` (validate-first)

Add `PrepareRenameRequest` to imports. Called **only** when the object-form capability advertises prepare — the boolean `supports()` helper cannot detect this, so an explicit shape check is required:
```ts
const rp = capabilities.renameProvider
const hasPrepare = typeof rp === 'object' && rp !== null && rp.prepareProvider === true
```
When advertised, `prepareRename` runs first as a cheap pre-flight; result is the tri-shape union `Range | {range, placeholder} | {defaultBehavior} | null`. **`null` → structured `refused: 'rename not valid at this position'`** (distinct from `no_result`), and we never send the mutating `rename`. When prepare is **not** advertised (`renameProvider: true`), skip it, attempt `rename`, and treat a `null` `WorkspaceEdit` as "cannot rename here" — no validity guess in that branch (confirmed v1 decision).

### 2.4 Inbound `workspace/applyEdit` (deadlock guard)

A server may send a server→client `workspace/applyEdit` mid-rename. Its result type is an **object, not `null`** — answering `null` is invalid and the unanswered id-bearing request deadlocks the shared server (the exact failure `client.ts:17-20` warns of). Add `ApplyWorkspaceEditRequest` to `installInboundHandlers` (`client.ts:280-292`) returning:
```ts
{ applied: false, failureReason: 'strummer applies rename edits itself; server-initiated edits are declined' }
```
The fixtures README must record (from the captured fixture) that tsserver 5.3.0 returns the full `WorkspaceEdit` directly from `textDocument/rename` and does **not** drive renames via server-initiated `applyEdit`. A server that *only* drives renames via `applyEdit` is **unsupported** by this model; in that case we surface a structured `refused: 'rename-not-resolvable (server drives edits via applyEdit, unsupported in v1)'` rather than silently returning an empty edit (closing critic 1-finding-9).

### 2.5 WorkspaceEdit normalization & resource-op policy

`documentChanges` **takes precedence** over `changes` when both present (never merge). Any non-empty `resourceOps` → preview shows them; **apply refuses unconditionally and early** (before confinement/read/stage) with `status: 'refused'` (closing critic 2-finding-4). Confinement of resource-op URIs is **not** wired in v1 (refusal precedes it); when a future slice un-stages resource ops, both `oldUri` and `newUri` of a `RenameFile`, and the `uri` of `CreateFile`/`DeleteFile`, MUST pass the realpath-hardened write-confinement helper, all-or-nothing — documented as a staged requirement, not half-wired now.

## 3. The pure apply core

Two new pure, I/O-free, fixture-tested functions, one `encoding.ts` extension, one pure validator.

### 3.1 `encoding.ts`: `lspPositionToOffset`
```ts
export function lspPositionToOffset(text: string, position: LspPositionParts, encoding: PositionEncoding): number
```
Returns an **absolute JS-string (UTF-16) index** for splicing. Critical corners:
- **Does NOT build on `splitLines()`** — `splitLines` (`encoding.ts:99-101`) splits on `/\r\n|\r|\n/` and **discards terminator identity**, shifting every offset by one JS code unit per CRLF line above the edit. The walker **raw-scans** `text` for terminators, counting the *actual* terminator length consumed per preceding line, and returns the cumulative `.length` index.
- Counts negotiated code units to **locate** the target `character` within the line, but returns the cumulative **JS `.length`** (UTF-16) to splice on. A utf-8-negotiating server returns byte offsets; the two must never be conflated.
- Applies the **same `stripBom` convention** as `toLspPosition`/`fromLspPosition` so read and write agree on line-1.

### 3.2 `apply.ts`: `applyTextEdits`
```ts
export function applyTextEdits(text: string, edits: TextEdit[], encoding: PositionEncoding): string
```
- Convert each edit's start/end Position to absolute offset via `lspPositionToOffset`.
- **Distinct-start-offset is an enforced invariant, not an assumption** (closing critic 1-finding-8): sort ascending by start offset; **refuse any two edits sharing a start offset** (`OverlappingEditError`) — this subsumes the zero-length-double-insertion case. Then refuse any true overlap (`edit[i].endOffset > edit[i+1].startOffset`). **Adjacency (`end == next.start`) is allowed.** With distinct starts enforced, splice order is total and JS sort stability is never relied on for correctness.
- **Apply by splicing in descending start order** so earlier offsets are never invalidated. Reverse-order independence is then a property we test, not an assumption.
- Newline terminators preserved verbatim; `newText` written as-is.

### 3.3 `normalize.ts`: `normalizeWorkspaceEdit`
```ts
export function normalizeWorkspaceEdit(raw: WorkspaceEdit | null):
  { files: { uri: string; edits: { range: LspRange; newText: string; needsConfirmation?: boolean; annotationLabel?: string }[] }[];
    resourceOps: { kind: 'create'|'rename'|'delete'; uris: string[] }[] }
```
- `documentChanges` precedence over `changes`; iterate in order, preserve per-file edit order.
- A member with `textDocument`+`edits` and no `kind` → `TextDocumentEdit` (push to `files`). A member with `kind: 'create'|'rename'|'delete'` → resource op (push to `resourceOps`, **never** translated to a TextEdit).
- `AnnotatedTextEdit` → `{range, newText}`; if the referenced annotation is `needsConfirmation`, set `needsConfirmation: true` and carry `annotationLabel` (preview-only signal; excluded from apply per §2.1).
- `null`/empty → `{ files: [], resourceOps: [] }`.

### 3.4 `apply.ts`: `isPlausibleRenameName` (mandatory, not optional)
```ts
export function isPlausibleRenameName(newName: string): boolean
```
A `newName` is sent verbatim to the server and then written verbatim into every edited site — a newline or arbitrary code in it is a corruption/injection vector into every edit. v1 **rejects before sending to the server** (closing critic 2-finding-11): non-empty, length-bounded, no newline, no path separator, single line. Pure, red-first in Slice A.

## 4. Gate layering

**Sibling engine, not an overload.** A new **`LspRenameEngine` (`rename.ts`)** owns the write I/O. Factor the shared `assertAllowed`/confinement guards (`query.ts:405-422`) into an internal helper both engines import — but the helper takes a **`resolveSymlinks` mode** that the write caller always sets (see below).

**Two operator gates that layer, with enforced implication:**
- `allowRun` (existing) — required to even **compute** a rename. Always required.
- `allowWrite` (new) — required to **touch disk**. Operator-set only, never a tool argument.
- **Implication is enforced, not asserted** (closing critic 2-finding-3): the rename tool/engine is **not constructed/registered unless `allowRun` is true**. `allowWrite=1` with `allowRun=0/unset` is a **hard bin-startup error** (`STRUMMER_LSP_ALLOW_WRITE requires STRUMMER_LSP_ALLOW_RUN`). The two stay independent booleans (read-nav without write is grantable), but `allowWrite` alone is rejected at startup.

`decideRename(): 'preview' | 'apply'` (modeled on `BrowserGate.decideMutation`, `gate.ts:81-89`) returns `'apply'` only when `allowWrite` is set **and** every edited URI confines to an allowlisted root **and** (v1) the edit touches only the queried URI; otherwise `'preview'`. With `allowWrite` off the **injected `writer` seam is never reached** — apply is unreachable, and a dry-run path **never reaches `applyEdited`/`didChange`** (§5). A Slice F test asserts the connection sends **no `didChange`** in dry-run (closing critic 2-finding-2).

**Write-path confinement is realpath-hardened and read-path is NOT reused verbatim** (closing critic 1-finding-4 / 2-finding-1): the shipped `confineFile` (`query.ts:415-422`) does only `resolve` + prefix check — `resolve` does not canonicalize symlinks, so a symlink **inside** root pointing **outside** it passes and a write would clobber an out-of-root target. The write-confinement helper additionally `realpathSync`-canonicalizes the **root** and each target's **existing parent directory** (and the file when it exists), handling `ENOENT` for not-yet-existing files by canonicalizing the nearest existing ancestor, and re-asserts the realpath is still inside `realpath(root)`. A non-`file://` scheme (`jdt://`, in-memory) is refused. The read engine's `confineFile` keeps its lexical-only behavior (lower stakes for reads) but the unqualified "symlink escape" claim is dropped from its docs.

**Strict ordering — confine-all before any I/O** (closing critic 2-finding-5): `normalize → confine ALL uris (scheme + realpath-in-root, all-or-nothing) → only then Phase-1 reads/staging`. One out-of-root / `..` / symlink-escape / non-`file://` URI **aborts the entire batch before any target file is read** — an out-of-root *read* is itself a disclosure. A Slice F test asserts an out-of-root URI causes **zero reads** of any target.

**Multi-file atomicity — the entry-point lock does NOT suffice** (closing critic 1-finding-1 / 2-finding-6). The shipped `manager.run` (`manager.ts:149-164`) holds `withUriLock` for **exactly one** URI — the entry point. A cross-file rename writes files B/C not under that lock, racing a concurrent query on B. v1 therefore does **one of**:
- **(v1 default) Refuse multi-file apply.** Until the multi-lock primitive lands, write-mode applies only when every edited URI is the queried URI; multi-file renames are **previewable but not applicable** (structured `refused: 'multi-file apply requires the multi-URI lock (staged)'`).
- **(unlock slice) Add `manager.runWithUris(entry, uris[], fn)`** that chains the per-`(server,uri)` locks for **every** edited URI in a **deterministic sorted order** (avoiding lock-ordering deadlock between two concurrent renames), holding all for the whole stage+commit+`didChange` window. This is **Slice F's hard prerequisite for multi-file**, not a deferred open question.

**Apply is stage-then-commit, crash-safer, not rollback-by-rewrite** (closing critic 1-finding-2 / 2-finding-10): the in-memory "restore from pre-write bytes" model shares the failure mode (a disk-full/EIO that broke the write breaks the restore). Instead the **writer seam is richer than `writeFile(absPath, content)`** (answering Open Q on the seam shape, §10): it exposes **stage-then-commit-all** semantics.
- **Phase 1 (no writes):** for each target — read current text, run the staleness check (§4 below), build new content in memory via `applyTextEdits`. Any overlap/staleness/confinement/unreadable error aborts the whole batch *before any write*.
- **Phase 2a (stage):** write every target to a **sibling temp file + fsync** in the target's own directory. If any temp write/fsync fails, abort — no target file has been touched.
- **Phase 2b (commit):** only after all N temps succeed, perform the N atomic `rename`s. The rename burst is the only inconsistency window; renames rarely fault once the temp exists on the same filesystem. The residual window (N renames are not a POSIX group-atomic op) is **documented honestly**, not hidden, and the precise `partial: true` report (project-relative paths only, never absolute) names which renames landed.

**Staleness — content-hash drift is the SOLE authority and always hard-refuses** (closing critic 1-finding-5): at compute time capture the hash of the **exact bytes used for compute** (the `didOpen`/buffer text); before Phase-2 re-read and **hard-refuse the whole batch on any drift**, regardless of the `version` field. TextEdit offsets are only valid against the text they were computed from; never splice them onto drifted disk content. `OptionalVersionedTextDocumentIdentifier.version: null` means "no extra version signal" — it does **not** license applying against changed disk. A **non-null** version disagreeing with the open doc also aborts. Full version reconciliation stays staged.

**Pre-compute buffer reconcile** (closing critic 2-finding-9): the server computed its edit against the text Strummer `didOpen`'d (open-once, possibly minutes old per the 15-min TTL). Before computing the rename, if the file is open and its `didOpen` text differs from current disk, send a `didChange` full-text resync **first** so the returned offsets match the text `applyTextEdits` will splice — then compute. This is the actual correctness fix; the post-compute hash check guards the compute→commit window.

## 5. Doc-sync after write

After writing to disk the server still holds the **pre-rename** text (open-once, refcounted, no `didClose` — `client.ts:294-313`). A subsequent navigation would return silently-wrong positions.

**Chosen reconciliation: `didChange` full-text, never `didClose`** (which fights the refcount/open-once invariant and races in-flight queries). New method:
```ts
client.applyEdited(uri, newText): void  // if uri is in the open map: send didChange (full text, version++)
```
- **Per-URI monotonic version counter, seeded correctly** (closing critic 1-finding-7): the `open` map value changes from a bare refcount to `{ refs, version }`, seeded at version `1` by `ensureOpen`'s `didOpen` (`client.ts:295-305`); `releaseDoc` (`client.ts:307-313`) updates only `refs`. `applyEdited` **pre-increments** then sends (version `2` for the first change) — versions must strictly increase or the server ignores the change and keeps pre-rename text. Slice E asserts the `didChange` version is strictly greater than the `didOpen` version and that two successive `applyEdited` calls strictly increase. This refactor is flagged explicitly in Slice E.
- Full-text sync (no incremental ranges) — correctness over bytes; server-bound, not agent-facing, avoids re-introducing offset math.
- Files **not** currently open need no sync (re-read fresh on next `didOpen`).
- Both the pre-compute reconcile (§4) and the post-write `didChange` run **inside the held lock(s)** — the queried lock for the single-file v1 case, all edited-URI locks for the staged multi-file case — so a concurrent reader is serialized, not racing. The cross-session shared-server side effect (another session's next query on an edited file sees post-rename text) is **real, intended, and documented in the ADR**: the file genuinely changed on disk, so the server *should* reflect it (closing critic 2-finding-2).

## 6. MCP surface + bin

**One tool, dry-run default** (matches the `BrowserGate` single-gate precedent). `lsp_rename` registers inside the existing `if (navEnabled && query)` block in `lsp.ts:104` (rename always needs `allowRun`), via a new injected `rename?: (input) => Promise<LspRenameResult>` option. It registers only when `rename` is wired (i.e. `allowRun` held — enforced in the bin per §4).

**Inputs:** `language`, `projectRoot`, `file`, `line`, `column`, `newName`. There is **no `write` input** — preview-vs-apply is decided **internally** by `decideRename()` against the operator-set `allowWrite`. `newName` is validated by `isPlausibleRenameName` (§3.4) before reaching the server.

**Dry-run preview result (`applied: false`):** compact inline metadata only —
```
{ status, kind: 'rename', applied: false, newName, fileCount, totalEditCount,
  edits: [{ uri (project-relative), editCount, outOfRoot?: true,
            hunks?: [{ range: HumanRange (1-based label only, via fromLspPosition),
                       oldText, newText, needsConfirmation?, annotationLabel? }] }],
  resourceOps?,   // present+non-empty => status 'refused' on apply
  serverInfo, encoding, versionWarning? }
```
- **`oldText` is sliced with the absolute offsets from `lspPositionToOffset`, NEVER reconstructed from line:column via `splitLines`** (closing critic 1-finding-3) — `fromLspPosition` is used **only to render the human line:column label**, never to compute the byte span shown as `oldText`. A CRLF preview fixture asserts `oldText` byte-matches disk. Hunks are bounded to the edit span + a small clamped margin; **file bodies are never inlined** (ADR-0011 §"a file body is never inlined").
- **Out-of-root edits show path + edit count ONLY — never `oldText`/`newText`** (closing critic 2-finding-7): we must not read+surface a file already decided to be outside the allowlist; `outOfRoot: true` flags it as not-applicable. (In single-file-apply v1 an out-of-root edit means the whole apply is refused anyway.)
- **Secret redaction** runs over every `oldText`/`newText` via `@strummer/safety` (the shared redaction already used by `api`/`browser`) before they hit the preview or the artifact (closing critic 2-finding-7).
- The **full** WorkspaceEdit preview is offloaded by `@strummer/artifacts` — **prefix `'lsp'`, kind `'rename-preview'`**, `strummer://lsp/{id}/rename-preview` — with a capped per-file head inline, mirroring the reference-list pattern (`lsp.ts:145-160`). Artifact retention is **bounded like the reference-list artifacts** and contains no out-of-root file bodies and no unredacted secrets.

**Apply result (`applied: true`):** same shape plus a `kind: 'applied-edit'` audit artifact recording exactly which files were written and their **pre/post SHA-256 digests** for auditability. Per-file digests are the v1 audit bar; a full unified diff under a separate handle kind is staged (Open Q in §10).

**Bin (`bin-lsp.ts`):**
- Parse `allowWrite: bool(env.STRUMMER_LSP_ALLOW_WRITE)` into `LspBinConfig` alongside `allowRun` (`bin-lsp.ts:99-107`).
- **Validate `allowWrite ⇒ allowRun` at build time**; throw `STRUMMER_LSP_ALLOW_WRITE requires STRUMMER_LSP_ALLOW_RUN` when violated (§4).
- In the existing `if (config.registry)` block (`bin-lsp.ts:115`), construct `LspRenameEngine` with `manager + allowedRoots + allowWrite + the real stage-then-commit writer seam`, and wire `rename: (input) => renameEngine.rename(input)` into `createLspServer`.
- Document in the bin env header (`bin-lsp.ts:79-91`):
  ```
  STRUMMER_LSP_ALLOW_WRITE=1   # enables lsp_rename to write to disk; default off = dry-run preview only
                               # requires STRUMMER_LSP_ALLOW_RUN (hard error otherwise)
  ```

## 7. Test/fixture posture

**The gate NEVER spawns a real server** (ADR-0011 invariant). Two categories.

**(A) Pure-core tests** — no peer, no spawn, the red-first bulk.
- `applyTextEdits`/`lspPositionToOffset` full matrix (hand-computed expecteds): single mid-line replace; multiple non-overlapping edits one line (right-to-left); **reverse-order independence** (protocol order vs shuffled → byte-identical); insertion (empty range); deletion (empty newText); **adjacent edits allowed**; **true overlap throws**; **same start offset throws** (the enforced-distinct-start invariant); non-BMP under utf-16 (😀 surrogate pair); **same logical edit in utf-8 vs utf-16 offsets → identical output** (reusing the `encoding.test.ts` emoji/café fixtures); CRLF document (offset lands right, `\r\n` preserved); mixed LF/CRLF/CR; edit at offset 0 and at length; multi-line range spanning a terminator; no-op edit; BOM document (leading U+FEFF must not shift line-1).
- `isPlausibleRenameName`: accepts plain identifier; rejects newline / path separator / empty / over-length.
- `normalizeWorkspaceEdit`: changes-only; documentChanges all-TextDocumentEdit; mixed resource op flagged; AnnotatedTextEdit with `needsConfirmation` carried; empty/null; per-file order preservation; precedence (both present → documentChanges wins).
- **Write-confinement** (`confineEditedUris`, realpath mode): hand-authored INPUT fixtures (legitimately hand-authored — they assert *our policy*, not server payload shape): in-root URI passes; `file:///etc/passwd` and `file:///project/../evil.ts` throw and write zero bytes; **a symlink inside root resolving outside root throws** (real symlink in a tmp dir); non-`file://` scheme refused.

**(B) Client/engine tests via the fake in-process peer** (`peer.ts` `makePeerPair`, paired duplex streams) replaying **RECORDED** payloads. Capture out-of-gate from `typescript-language-server` 5.3.0 via the existing Greeter/index.ts harness, with `/project` path normalization, committed under `packages/lsp/test/fixtures` (update `test/fixtures/README.md` provenance, recording the §2.4 finding that tsserver returns the edit directly and does not use server-initiated applyEdit):
- `prepare-rename.json` — `prepareRename` on `Greeter` (real polymorphic shape; normalize all branches; `null` → refusal).
- `rename-documentchanges.json` — `rename` of `Greeter`→`Greeter2` spanning **greeter.ts + index.ts** (genuine multi-file `documentChanges`). **Capturing this is a Slice-B blocker** that also answers the resource-op question (§2.1): if the real payload carries resource ops on an ordinary rename, the v1 cut is reconsidered before the refuse logic is coded.
- `rename-changes.json` — a **documented synthesized** legacy `changes`-map variant (shape-presence test for the other normalizer branch; the carve-out applies — it tests shape detection, not a guessed payload).
- New peer loaders `PREPARE_RENAME()`/`RENAME()`.
- Assertions: client normalizes to the unified `files→edits` shape; the engine produces a dry-run preview with correct human-coord **labels** and **never calls the writer** and **sends no `didChange`** in dry-run; with `allowWrite` on, the injected writer receives content that **byte-matches an independently hand-computed golden file** (NOT compared against `applyTextEdits` output — that would be a tautology re-asserting the core; closing critic 1-finding-6); `didChange` is sent for an open edited file (version strictly increasing) and **not** for a closed one; an inbound `applyEdit` mid-rename does **not** hang the session; an out-of-root URI causes **zero reads**.
- All time-based code rides the **injected clock**. Add a test-level assertion that production code never calls `fs.writeFileSync`/`fs.renameSync` outside the default injected writer seam (mirroring ADR-0011's `setTimeout`/`setInterval` assertion).

## 8. TDD slicing (ordered, each independently committable, red→green→commit)

- **Slice A** — pure `apply.ts`: `lspPositionToOffset` (raw-terminator walker, extends `encoding.ts`) + `applyTextEdits` (enforced-distinct-start invariant, `OverlappingEditError`) + `isPlausibleRenameName`; the full pure matrix in §7(A). Server-free, highest value.
- **Slice B** — pure `normalizeWorkspaceEdit` in `normalize.ts`; **blocked on capturing `rename-documentchanges.json`** (which also settles the resource-op v1-cut question); synthesized `rename-changes.json`; resource-op flagging; annotation carry.
- **Slice C** — the shared `assertAllowed` + **realpath-hardened write-confinement** helper (`confineEditedUris` with `resolveSymlinks` mode) lifted from `query.ts`; hand-authored escaping-input fixtures incl. the real-symlink case.
- **Slice D** — `client.rename()` + `client.prepareRename()` through the fake peer; advertise the new `initialize` capabilities; tri-state via `withRetry`; recapture the `initialize` fixture with the new caps.
- **Slice E** — `client.applyEdited()` `didChange` doc-sync + the `open`-map refactor to `{refs,version}` + per-URI monotonic counter (flag the `releaseDoc` touch); peer-test strictly-increasing versions on both branches; add the inbound `applyEdit` deadlock-guard + regression test.
- **Slice F (single-file)** — `LspRenameEngine` (`rename.ts`): dry-run preview path (zero writes, zero `didChange`, confine-all-first, human-coord labels, offset-faithful `oldText`, secret redaction, `allowWrite`-off asserts writer never reached); then the **single-file apply path** (`allowWrite` on, queried-URI-only) via the stage-then-commit writer seam — pre-compute reconcile, hash-drift hard-refuse, post-apply `didChange`, golden-file byte assertion.
- **Slice F′ (multi-file, prerequisite-gated)** — `manager.runWithUris(entry, uris[], fn)` (sorted lock chain, deadlock-safe) **then** enable multi-file apply in the engine (confine-all, all-locks-held stage+commit+`didChange`, partial-failure report). Until this lands, multi-file renames are preview-only (refused on apply). Independently committable after Slice F.
- **Slice G** — `lsp_rename` MCP tool in `lsp.ts` + by-handle `rename-preview`/`applied-edit` artifacts; `STRUMMER_LSP_ALLOW_WRITE` wiring + the `allowWrite⇒allowRun` startup validation in `bin-lsp.ts`.
- **Slice H** — fold this contract into ADR-0011 + STATUS/ROADMAP/memory notes.

## 9. Adversarial corrections (finding → resolution)

**Critic 1 — correctness-and-determinism:**
1. *Multi-file mutex claim false* → **folded.** Entry-point lock no longer claimed sufficient; v1 refuses multi-file apply; multi-file requires new `manager.runWithUris` (sorted lock chain) as Slice F′'s hard prerequisite (§4, Slice F′).
2. *Partial-write recovery unsound* → **folded.** Replaced in-memory rollback with stage-then-commit-all (temp+fsync all, then atomic renames); residual rename-burst window documented; richer writer seam (§4).
3. *Preview oldText via splitLines off-by-one on CRLF* → **folded.** `oldText` sliced with `lspPositionToOffset` absolute offsets; `fromLspPosition` used only for the human label; CRLF preview fixture added (§6, §7).
4. *Symlink-escape confinement unbacked by cited code* → **folded.** Realpath-hardened write-confinement helper; read-path `confineFile` not reused verbatim; unqualified symlink claim dropped from read docs (§4).
5. *`version:null` defeats staleness* → **folded.** Content-hash drift is sole authority and always hard-refuses; `version:null` grants no apply-against-drift license; offsets never spliced onto drifted text (§4).
6. *Writer-content assertion is a tautology* → **folded.** Peer test asserts the writer received an **independently hand-computed golden file**, not `applyTextEdits` output; resource-op fixture capture is a Slice-B blocker (§7).
7. *didChange version collides with didOpen version:1* → **folded.** `open` map → `{refs,version}` seeded at 1; `applyEdited` pre-increments; strictly-increasing assertions (§5, Slice E).
8. *Equal-start splice-order determinism* → **folded.** Distinct-start-offset is an enforced invariant (same-start → throw); JS sort stability not relied on (§3.2).
9. *applyEdit-driven servers / retry* → **folded.** Fixtures README records tsserver returns the edit directly; a applyEdit-only server is unsupported, surfaced as structured `rename-not-resolvable` (§2.4).

**Critic 2 — architecture-fit & safety:**
1. *Confinement bypass via symlink/realpath* → **folded** (same as critic-1 #4; distinct write-confinement helper, real-symlink fixture in Slice C).
2. *Dry-run not write-free (didChange mutates shared state)* → **folded.** Dry-run never reaches `applyEdited`/`didChange` (asserted in Slice F); apply's cross-session side effect documented as intended; `didChange` runs under the held lock(s) (§4, §5).
3. *allowWrite without allowRun unspecified* → **folded.** Implication enforced: rename engine/tool not constructed without `allowRun`; `allowWrite=1, allowRun=0` is a hard bin-startup error; bin-config validation test (§4, §6).
4. *resourceOps confinement contradictory with refuse* → **folded.** Resource-op refusal is unconditional and early, before any confinement; resource-op confinement explicitly staged for the future un-stage slice (§2.5).
5. *Confine ordering vs Phase-1 reads* → **folded.** Strict order normalize → confine-all → reads; out-of-root URI causes zero reads (asserted) (§4).
6. *Multi-file holds only queried lock* → **folded** (same as critic-1 #1).
7. *Secret/path leakage in preview + artifact* → **folded.** No hunk bodies for out-of-root edits; `@strummer/safety` redaction over hunks; project-relative paths only; bounded artifact retention (§6).
8. *newName guard "optional"* → **folded.** Made mandatory pure validator `isPlausibleRenameName`, validated before sending to server (§3.4, Slice A).
9. *Server buffer stale vs disk pre-compute* → **folded.** Pre-compute `didChange` reconcile when `didOpen` text differs from disk (§4, §5).
10. *Partial restore can corrupt; paths leak* → **folded** (same as critic-1 #2; project-relative report paths).
11. *(dup of newName)* → folded (#8).
12. *Dropping annotationId defeats server safety signal* → **folded.** `needsConfirmation` annotations kept preview-only and excluded from apply; labels preserved; never silently applied (§2.1, §3.3).

## 10. Remaining decisions for the human

1. **Multi-file in v1 or a fast-follow.** This contract ships **single-file apply** in Slice F and gates multi-file behind the new `manager.runWithUris` primitive (Slice F′). Confirm that single-file-only is an acceptable first write-mode landing, or require Slice F′ before any apply ships. (Most real renames are multi-file, so single-file-only may have limited utility — your call on whether to merge F and F′ as one milestone.)
2. **Resource-op v1-cut, pending the fixture.** If the captured `rename-documentchanges.json` shows tsserver 5.3.0 emitting resource ops on ordinary renames despite `resourceOperations: []`, "refuse-on-resource-op" becomes the common path, not the edge — decide then whether to keep the refuse cut or pull resource-op apply into v1.
3. **Audit fidelity.** Per-file pre/post SHA-256 digests (v1) vs also persisting a full unified diff under a separate `applied-edit-diff` handle kind. Digests are cheaper and leak less; a diff is more useful for an operator review trail.
4. **Staleness strictness.** Confirm hard-refuse-on-drift + re-query is acceptable for rapidly-changing files (it will force occasional re-queries) rather than any apply-against-current-disk path (which this contract rejects as unsafe).

---

## Addendum (2026-06-02) — write-mode multi-root (`lsp_rename` `workspaceRoots[]`)

A follow-on to the nav multi-root tail (`workspaceRoots[]` / `--workspace-root`): the write
engine now accepts the same `workspaceRoots`, so a cross-root rename in a monorepo applies.

- **The one new safety decision: edited files confine to the root GROUP, not the primary root.**
  The single-root write path (§4) confined every edited URI to `projectRoot`. A multi-root rename
  legitimately edits files in any bound workspace folder, so a new `confineEditedUriToRoots(roots[],
  uri)` accepts a URI that realpath-confines to **any** allowlisted group root and refuses only when
  it escapes **every** root (a non-`file://` scheme is still refused up front). The all-or-nothing,
  confine-before-any-I/O ordering (§4) and the realpath hardening (per-root) are unchanged — an edit
  outside the whole group aborts the batch before any byte is read or written.
- **`workspaceRoots` threads into BOTH phases.** Compute (`manager.run`) and apply
  (`manager.runWithUris`) must pass the same `workspaceRoots` so they key the **same** group-server
  (`serverKey(language, sorted group)`); otherwise the post-write `didChange` doc-sync would reach a
  different server than the one the document was opened on. Each `workspaceRoots` member is
  paired-gated (`assertAllowed`) before any spawn, mirroring the read engine.
- **Surface:** `lsp_rename` gains the optional `workspaceRoots` input (no longer nav-only); the CLI
  reuses the repeatable `--workspace-root`. Dry-run-default and the separate `allowWrite` gate are
  unchanged. Verified live against `typescript-language-server` 5.3.0 (a cross-root
  `Greeter`→`Welcomer` rename applied to disk in both roots with per-file digests).
- **Still staged:** dynamic `didChangeWorkspaceFolders` (adding/removing folders at runtime), and
  write-mode resource ops + multi-file conflict reconciliation (§10.2). Multi-root only widens the
  set of *roots* an edit may land in; it does not change the resource-op refuse cut.
