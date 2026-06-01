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
