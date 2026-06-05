# ADR 0019 — Packaging & distribution (aggregate server + npm publish)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Extends:** ADR 0010 (per-pillar deny-by-default operator gates; explicit pins / no
  transitive imports), ADR 0013 Addendum (the `bin-verify` "both required" gate composition
  precedent), ADR 0017 (per-pillar `*_ARTIFACT_*` retention env model).
- **Design:** the `packaging-distribution-design` fan-out — 5 research streams → synthesis →
  2 adversarial critics (one `needs-rework`, one `ship-with-fixes`; **5 blockers folded in**)
  → corrected design. Four forks human-ratified (see below).

## Context

Sackville is feature-complete across 5 phases but is shaped like a **monorepo, not a product**.
Two concrete gaps block adoption:

1. **Server fragmentation.** An agent wanting the full toolkit must wire up **nine separate
   stdio MCP bins** (`sackville-mcp` = docs, plus `bin-api`/`-browser`/`-coverage`/`-deps`/
   `-flake`/`-lsp`/`-mutate`/`-verify`), each its own process with its own `SACKVILLE_<PILLAR>_*`
   env namespace and its own gate. There is no single server that exposes the whole toolkit.
2. **Nothing is publishable.** Every `@sackville-mcp/*` package is `"private": true` at
   `"version": "0.0.0"`. The bare `sackville` npm name is taken, so packages ship under
   `@sackville-mcp/*`.

Ground truth established by the fan-out (verified in-repo):

- `packages/mcp/src/index.ts` already re-exports every `register<X>Tools(server, opts)` and
  `create<X>Server(opts)` factory. **`register<X>Tools(sharedServer, opts)` is the composition
  seam** — multiple pillars can register onto ONE `McpServer`. The `build<X>ServerFromEnv`
  builders each construct their *own* server, so they are NOT the seam.
- **No tool-name or resource collisions today:** ~60 tool names are globally unique (pillar
  prefixes `browser_`/`lsp_`/`flake_`/`mutate_`/`audit_`/`validate_` act as de-facto
  namespaces; only the docs/api tools are unprefixed); resource templates use distinct
  `sackville://<prefix>/` paths. **SDK 1.29 `registerTool`/resource registration THROWS hard on
  a dup** — so a uniqueness guard is mandatory to keep a future pillar from silently shadowing.
- **Conditional, gate-driven tool registration already exists** per pillar (coverage registers
  `run_scoped` only when `allowRun && allowedRoots.length`; flake/api/lsp/verify gate their
  run/write tools). Selective enablement is therefore *partly intrinsic*.
- **Lazy-load precedent already ships:** `bin-verify` does `await import('@sackville-mcp/browser')`
  only on the produce-capture path, so consume-only operators never load playwright-core.
- **tsdown externalizes** all deps (built `.mjs` keeps bare `import` statements). So a STATIC
  top-level import of a heavy engine runs its module-init at process start; a dynamic
  `await import()` defers it. **But deferral is RUNTIME-only — it does not stop `npm install`
  from pulling the dependency.** Install isolation requires a *package-graph* change.
- **Native/heavy install closure** flows through exactly four engine packages:
  `@sackville-mcp/browser` (`playwright-core`, `lighthouse`, `chrome-launcher`, `pixelmatch`,
  `pngjs`), `@sackville-mcp/core` (`better-sqlite3`, docs), `@sackville-mcp/embed` (`onnxruntime` via
  transformers.js, docs), `@sackville-mcp/flake` (`better-sqlite3`). **`sackville` carries a
  redundant direct `playwright-core` dep** (only `browser` needs it). The light pillars
  (api/deps/coverage/mutate/lsp/verify + the pure leaves) pull no native binary at install.

## Decisions

### A. Aggregate MCP server

1. **Compose onto ONE `McpServer` via `register<X>Tools(server, opts)`.** The aggregate builds
   one server `{ name: 'sackville', version }`, and for each ENABLED pillar derives its opts from
   env and registers its tools onto that server. (Closes the "barrel" blocker — see A4.)
2. **`sackville-mcp` is REPOINTED to the aggregate** (ratified fork). The current docs-only
   server moves to a new bin name (`sackville-docs-mcp`); `sackville-mcp` now serves the whole
   enabled toolset. README/configs that meant docs-only are updated in the onboarding slice.
   The other 8 per-pillar bins are **kept untouched** alongside (rule 4: they are the minimal
   runtime-capability boundary for narrow deployments).
3. **Extract a shared `<pillar>OptionsFromEnv(env)`** out of each `build<X>ServerFromEnv`
   (which currently fuses env-parse + `new McpServer` + register). Each returns the opts object
   plus any owned resources (flake `HistoryStore`, browser manager+proxy, lsp manager, docs
   db+embedder) and their **shutdown** handles. `build<X>ServerFromEnv` becomes
   `register<X>Tools(new McpServer(...), <pillar>OptionsFromEnv(env))` — behaviour-preserving;
   the standalone bins are the regression guard.
4. **Extract `createSackvilleServer` (docs) to `./docs.js`** so `index.ts` is *pure re-exports
   with no bin-importable side effects*. `bin.ts` (docs) currently imports the barrel; the
   barrel statically re-exports every pillar, so importing it would defeat lazy loading. A test
   asserts no `bin*.ts` imports `./index.js`.
5. **Uniqueness guard (mandatory):** a test registers all pillars (incl. docs) onto one server
   and asserts no duplicate tool name / resource template — red via an injected dup, green for
   real. No hard-coded count (the count drifts; the property is what matters).

### B. Package split for install isolation (ratified fork: "split now")

6. **The four heavy engines become OPTIONAL PEER dependencies of `sackville`** (and likewise
   reconsidered for `@sackville-mcp/cli`): `@sackville-mcp/browser`, `@sackville-mcp/core`, `@sackville-mcp/embed`,
   `@sackville-mcp/flake` move from `dependencies` to `peerDependencies` +
   `peerDependenciesMeta: { optional: true }`. **Drop mcp's redundant direct `playwright-core`.**
   The aggregate **dynamically `import()`s** each engine only when its pillar is enabled.
7. **Missing optional engine ⇒ LOUD DISABLE; contradictory gate ⇒ FATAL.** A pillar whose
   engine package is not installed (the dynamic import throws `ERR_MODULE_NOT_FOUND`) is
   disabled with a clear diagnostic ("pillar X disabled: install `@sackville-mcp/core`"), the server
   still starts. A pillar whose *gate* is internally contradictory (e.g. LSP `ALLOW_WRITE`
   without `ALLOW_RUN`, which the engine throws on) is **fatal to the whole aggregate** — these
   throws are anti-widening guards; swallowing them would be fail-open.
8. **Consequence for the default set:** a bare `npm i sackville` (no heavy peers) is
   **fully native-free**, so the *effective* zero-extra-install default is **api+deps+verify**.
   **docs** (needs `@sackville-mcp/core`+`@sackville-mcp/embed` *and* an operator-provided index) and
   **flake**/**browser** loud-disable until their engine is installed. The ratified
   **curated read-heavy default (docs+api+deps+verify)** therefore holds *in intent* — docs
   joins the default the moment its engine + index are present.

### C. Gate / env composition — "compose, never widen"

9. **Keep the existing `SACKVILLE_<PILLAR>_*` namespace, read unchanged by one process** — it is
   already collision-free. No rename of working per-pillar vars.
10. **Close the bare-name widening hole (critic blocker).** `api` AND `verify` both read the
    *unprefixed* `SACKVILLE_ALLOW_UNSAFE`/`_ALLOWED_HOSTS`/`_BLOCK_PRIVATE`/`_KEYRING` (verify
    via its live-capture path). In one process a single bare flag would unlock **both**. In
    **aggregate mode** both `apiOptionsFromEnv` and `verifyOptionsFromEnv` read **prefixed**
    `SACKVILLE_API_*` (+ `SACKVILLE_API_SECRET_*`); bare names are ignored. **Standalone bins are
    unchanged.** Redaction unions all resolved secrets.
11. **`SACKVILLE_TOOLSETS` is SUBTRACTIVE selection only — it never grants a capability.** It
    chooses which enabled pillars *register*; each pillar still reads its own gate for whether
    its run/write tools appear. Selection ⊥ capability. Unset ⇒ the curated default (B8).
    Per-pillar `instructions` strings are assembled only for enabled pillars (avoids the
    ~60-tool / 9-instruction-block bloat the critic flagged).
12. **One `SACKVILLE_ARTIFACTS_ROOT`, per-pillar subtree + retention** (ADR 0017 unchanged):
    sweeps stay prefix-scoped; the browser `mkdtemp` ephemeral default is preserved when unset.
13. **Lifecycle:** the aggregate collects and runs **every** pillar's shutdown/reaper on
    SIGINT/SIGTERM (browser proxy, lsp manager, sqlite db, embedder, artifact sweep timers).
    A missed shutdown leaks a handle.

### D. npm publish pipeline

14. **Changesets, FIXED / lockstep versioning** (ratified fork), publishing **through pnpm**
    (so `workspace:*` is rewritten to real ranges — `npm publish` would ship the literal).
    `access: public`, `baseBranch: main`. mcp/cli/verdict/verify are tightly coupled; one
    version → no internal compatibility matrix (pure leaves take no-op bumps; accepted).
15. **Publishability prerequisites (critic blocker):** remove `private: true`; add
    `repository: { type: 'git', url: 'git+https://github.com/ceautery/sackville.git',
    directory: 'packages/<name>' }` **case-exact** (absent ⇒ provenance no-ops);
    `publishConfig: { access: 'public', provenance: true }`. **Topological `pnpm -r build`
    before publish** (the gate has no build step).
16. **Types/exports without breaking the no-build gate (critic blocker).** Keep raw
    `exports['.'].types = ./src/index.ts` (NodeNext, no project refs, no build in gate — flipping
    to `./dist` would red a fresh-checkout typecheck). Add a **pack-time
    `publishConfig.exports` overlay** that maps to the built `dist` (nested `import`/`types`
    conditions, **not** flat `default`+`types` — `attw` flags masquerading types). Validate with
    **`attw --pack` + `publint` against the packed TARBALL** (not the dev tree — false negatives),
    sequenced before the exports change rolls out.
17. **ESM-only, single nested export condition, `.js` specifiers — no dual ESM/CJS package**
    (dual reintroduces the singleton-state hazard).
18. **OIDC trusted publishing from CI (critic blocker):** cloud runner, `id-token: write`,
    **Node ≥ 22.14.0 + npm ≥ 11.5.1** pinned in the workflow (engines only says `>=22`), **no
    `NODE_AUTH_TOKEN`**, provenance auto-attached (do **not** also set `provenance:true` in a way
    that double-sets — reconcile with §15), green gate first. Trusted publishing fails silently
    otherwise.
19. **`@sackville-mcp/cli` exposes a `sackville` bin**; a scoped package can provide an unscoped bin.
    Add a **default bin** so `npx sackville` resolves, plus document `npx -p`. No CLI feature
    work — the CLI is already unified; only onboarding docs.

### E. Distribution / onboarding

20. **stdio only for v1** (HTTP/SSE scheduled — adds an auth scope). **MCP registry optional /
    MCPB bundle aspirational** (3 native deps make a zero-click DXT hard).
21. Ship a real, resolvable **`.mcp.json`** example (aggregate server, only operator-set gate
    envs) + a **browser-bin preflight** that emits a clear diagnostic when no browser is
    provisioned (playwright-core ships none). README for both the human and the agent operator.

## Ratified forks (human, 2026-06-05)

| Fork | Decision |
| --- | --- |
| Default pillar set (TOOLSETS unset) | **Curated read-heavy** (docs+api+deps+verify; effective api+deps+verify until docs engine+index present — §B8) |
| Aggregate bin name | **Repoint `sackville-mcp`** → aggregate; docs-only becomes `sackville-docs-mcp` |
| Package shape | **Split now** — heavy engines as optional peer-deps + dynamic import (§B) |
| Versioning | **Fixed / lockstep** via Changesets (§D14) |

Forks adopted with the recommendation (low-stakes; overridable): published surface = **full
transitive graph** (forced — tsdown externalizes `workspace:*`); **add a default bin** for npx;
**stdio only**; **defer registry/MCPB**; **no CLI feature work**.

## Slice plan (TDD red → green; pure/offline first; nothing requires real spawn/fetch/native in `pnpm gate`)

1. **PublishConfig overlay + dual-shape guard** (pure). Per-package `publishConfig.exports`
   nested import/types→dist; raw `exports.types` stays `src`; `files` includes `dist`. *Test:*
   `publishConfig.import.types===dist` AND raw `===src` AND `files` includes `dist` — reds today.
2. **`attw --pack` + `publint` vs a packed leaf tarball** (build-then-assert CI, not gate).
   *Test:* exit 0, no masquerading types — reds for the flat shape.
3. **Tool/resource uniqueness guard** (pure). Enumerate all names+templates incl. docs.js.
   *Test:* register all pillars, assert no dup; red via injected dup, green for real.
4. **Extract `docs.js`** (refactor). Move `createSackvilleServer` out of `index.ts`; repoint
   `bin.ts`. *Test:* `bin.ts` no `./index.js` import; scan finds zero barrel-from-bin refs.
5. **Extract `<pillar>OptionsFromEnv`** (refactor). Factor env→opts(+resources+shutdown);
   preserve the LSP/flake anti-widening throws. *Test:* each `optsFromEnv` equals the prior
   `build*FromEnv` behaviour (coverage `allowRun`; LSP WRITE-no-RUN + DESTRUCTIVE-no-WRITE throw).
6. **API+VERIFY gate prefixing** (anti-widening). aggregate mode: both read `SACKVILLE_API_*`;
   bare ignored; standalone unchanged. *Test:* api+verify enabled + bare `SACKVILLE_ALLOW_UNSAFE=1`
   sets `allowUnsafe` on NEITHER; bare `SECRET_FOO` doesn't resolve; standalone still honors bare.
7. **Subtractive selection + default** (pure). Parse `SACKVILLE_TOOLSETS`; assemble enabled-only
   instructions. *Test:* `TOOLSETS=api` → api read-tier only (run needs its gate); unset →
   curated default; instructions enabled-only.
8. **Aggregate composition over `InMemoryTransport`** (pure). enabled+env → dynamic-import →
   register ONE server (stubbed opts). *Test:* `{api,deps}` → `tools/list` is exactly api+deps;
   an import spy shows no other pillar module loaded.
9. **Isolation + lifecycle** (behavior). missing engine ⇒ loud disable; contradictory gate ⇒
   FATAL; collect+fire shutdowns. *Test A:* flake-no-DB → starts, flake absent, no crash.
   *Test B:* LSP WRITE-no-RUN → fatal. *Test C:* every shutdown fires.
10. **Lazy boundary at the artifact level** (build-then-assert CI). Aggregate's own tsdown
    entry `await import()`s per pillar. *Test:* grep emitted `.mjs` — for `{api,deps}` and for
    verify-on/browser+flake+docs-off, playwright/sqlite/onnx/transformers are NOT in the static
    prelude (only in await-import chunks). Outside `pnpm gate`.
11. **Aggregate bin + stdio + default bin** (smoke). `sackville-mcp` over `StdioServerTransport`
    + SIGINT/SIGTERM; bin map + tsdown entries + `files`. *Test:* spawn minimal env, list tools,
    assert baseline + clean shutdown; offline, every bin path resolves.
12. **Package-graph split + publishability** (pure config). Heavy engines → optional peers; drop
    mcp's direct `playwright-core`; remove `private`; add `repository` case-exact. *Test:* every
    package `private !== true`, has `repository.directory`; the api-only install closure excludes
    playwright/sqlite/onnx; the docs/flake/browser closures include them.
13. **Changesets FIXED + topo build + OIDC** (dry-run in gate / publish in CI). changesets config
    (fixed, public, main); workflow Node≥22.14.0 + npm≥11.5.1, `id-token: write`, no token,
    gate→build→publish-via-pnpm. *Test:* `changeset publish --dry` resolves `workspace:*` to real
    ranges (no literal); `publint`/`attw --pack` pass; dist outputs exist. Outside `pnpm gate`.
14. **Onboarding** — `examples/.mcp.json` (real resolvable invocation + operator-set gate envs),
    README (human + agent), browser-bin preflight diagnostic. *Test:* parse `.mcp.json` →
    aggregate, only operator-set gates, documented bin maps to a REAL bin (npx trap); browser bin
    gives a clear diagnostic when no browser.

## Invariants held

- **Compose, never widen:** the aggregate cannot grant a capability a pillar's own gate refuses;
  the bare-name fix (§10) closes the one real widening path; `SACKVILLE_TOOLSETS` selects, never
  grants; contradictory gates stay fatal.
- **No heavy dep when a pillar is off:** runtime via dynamic import (§6, asserted on emitted
  `.mjs`, §slice 10) *and* install via optional peer-deps (§slice 12). The verdict/verify
  invariant is re-stated precisely as **zero NATIVE/heavy deps in the `.mjs` closure** (their
  runtime `@sackville-mcp/severity`/`@sackville-mcp/diff` imports are pure and fine).
- **No real spawn/fetch/network/native binary in `pnpm gate`:** every publish/lazy-boundary
  assertion is a build-then-assert CI job or a `--dry` run, never in the gate; composition tests
  use `InMemoryTransport` + stubbed opts.
- **Aspirational by default:** split-now, repoint, registry/HTTP staged not cut.

## Consequences

`sackville-mcp` becomes the single front door (one `.mcp.json` block), with selective enablement
and true install isolation. Staged, not built: HTTP/SSE transport; MCP registry submission; an
MCPB/DXT bundle; a Homebrew tap / single-binary CLI; an end-to-end "verify a PR" GitHub Action
(the natural Phase-7 capstone now that the entrypoint is unified).
