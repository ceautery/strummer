# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**Phase 3 — Browser/UI testing pillar: DESIGN LOCKED + first slice SHIPPED.** The
design is grounded by a 5-stream research workflow with adversarial verification
(archived in `docs/research/2026-05-31-pillar3-browser-testing.md`) and captured
in **ADR 0006 + ARCHITECTURE §10 + ROADMAP Phase 3**. Decision: a new pure-TS
**`@strummer/browser`** package built **thin on stable `playwright-core` 1.60.0**
(NOT a wrap of `@playwright/mcp` — it pins an alpha core + inlines artifacts);
ARIA-snapshot-first driving model; artifacts by handle (on-disk store);
deny-by-default operator-set safety with a two-tier SSRF defense (route allowlist
+ loopback DNS-pinning proxy); secrets at the fill boundary, redacted before any
write; a11y (`@axe-core/playwright`) + perf (Lighthouse over CDP) audits. A shared
**`@strummer/safety`** module (SSRF classifier + redaction) will be factored out
of `@strummer/api`. **First slice SHIPPED:** `@strummer/browser` scaffolded
(thin on `playwright-core` 1.60.0); `ArtifactStore` (on-disk,
`strummer://browser/run/<id>/<kind>` handles), `summarizeA11y`, and `auditA11y`
(via `@axe-core/playwright`) all TDD'd against an offline in-process fixture +
real headless Chromium. CI + the (gitignored) docker harness now provision
Chromium + its system libs. **128 TS + 45 Py tests green.** **Next action:** the
browser lifecycle manager + ARIA-snapshot capture/serializer (see ROADMAP
Phase 3).

**Phase 2 — Web API testing pillar: core deliverables COMPLETE** (engine +
contract validation + MCP tools + CLI all shipped & CI-gated; only optional tail
items remain). **Pillar 1 (docs/idioms) is functionally complete _and all its
deferred polish is done_** (non-Node version detection, TOC-bleed/symbol
ingestion refinements, Dash docset adapter). Pillar 2 design is locked (ADR 0004
+ 0005 + ARCHITECTURE §9, grounded by a 4-stream research workflow archived in
`docs/research/2026-05-31-pillar2-api-testing.md`).

**`@strummer/api` so far (TDD, offline tests):**
- Loads Bruno `.bru` + `*.strummer.yml` sidecar; var interpolation; **undici**
  runner; declarative assertions (status/jsonpath/header); body by
  `strummer://run/<id>/body` handle.
- **Secrets:** `{{secret:NAME}}` resolved at the transport boundary from a
  `SecretStore` (`StaticSecretStore`/`EnvSecretStore`/`KeyringSecretStore`-lazy/
  `ChainedSecretStore`); **fails closed** on a missing secret; a `Redactor`
  scrubs values + base64/url encodings from request/headers/body before anything
  reaches the agent.
- **Mutation safety:** GET/HEAD/OPTIONS run; POST/PUT/PATCH/DELETE **dry-run** by
  default and only send with `allowUnsafe` + a host allowlist (`checkGate`).
- **Captures + chaining:** sidecar `captures` extract values from a response
  (`extractCaptures`); `runSequence` threads them into later requests' scope.
- **Request bodies:** `.bru` `body:json/text/xml/sparql` (raw) + `form-urlencoded`
  sent via undici with a default `Content-Type`; vars/secrets interpolated in the
  body; redacted body shown in the result. (multipart/file/graphql still TODO.)
- **Environments:** `environments/<Env>.bru` loaded into `collection.environments`;
  `runRequest`/`runSequence` take `env` (lowest precedence; runtime vars win).
- **Scripts (QuickJS sandbox):** sidecar `preScript`/`postScript` run in a WASM
  isolate (`quickjs-emscripten`, 1s interrupt) with a curated `bru`/`expect`/
  `test`/`console` API — data crosses the boundary only as JSON (no host
  bindings). Pre-script sets vars used in interpolation; post-script sees `res`,
  records `scriptTests` (redacted), and `bru.setVar` feeds captures/chaining.
- **Contract validation (ADR 0005, ajv-direct not openapi-backend):** the
  `schema` assertion source validates a body (or jsonpath subtree) against an
  inline JSON Schema via **ajv 2020-12** (`schema.ts`/`validateSchema`).
  `validateOpenApiResponse` matches path-template + status (incl. `2XX`/`2xx`
  ranges + `default`) and validates the body against the **OpenAPI 3.1** response
  schema (local `#/components/schemas` `$ref`s rewritten into `$defs`); surfaces
  drift as `missing-operation`/`undocumented-status`/`response-schema` findings.
  `validateGraphqlOperation` (graphql-js) catches query-vs-schema drift incl.
  missing root types, plus response `errors`. Shared `ContractResult`/
  `ContractFinding`. Adversarially verified (3 bugs found + fixed: lowercase
  `2xx`, `$defs` clobber, mutation/subscription drift miss).
- **MCP tools + CLI commands (fan-out, two independent surfaces over the
  engine):**
  - **MCP** (`@strummer/mcp` `registerApiTools`/`createApiServer`, new
    `strummer-api-mcp` bin): tools `list_requests`, `get_request` (reports
    required secret **names** only, never values), `run_request`, `run_collection`,
    `validate_response` (OpenAPI or GraphQL), + `strummer://run/{runId}/body`
    resource over a shared `ArtifactStore`. **`allowUnsafe`/`allowedHosts` are
    operator-set via `ApiToolsOptions` (env on the bin), never agent inputs** —
    the safety gate can't be self-authorized.
  - **CLI** (`strummer api …`): `list`, `get`, `run` (`--var k=v`, `--env`,
    `--unsafe`, `--allow-host`, `--openapi <spec>` for live response validation,
    `--json`), `run-collection` (`--stop-on-failure`), `validate --graphql
    <schema> --query <q>` (offline drift). Exit 0 only when sent + assertions
    pass (+ contract valid when checked).
- A runnable sample collection (`examples/api/jsonplaceholder`) + an API-testing
  quickstart in `packages/cli/README.md`; an offline guard test keeps the sample
  in sync with the `.bru` format.
- **127 TS + 45 Py tests** (1 skipped real-embed), all green. Contract validators
  adversarially verified; both API bins smoke-tested end-to-end.

**Next (Pillar 2 tail):** keyring secret-store wiring into CLI/MCP (opt-in),
SSRF/redirect re-checks, remaining body types (multipart/file/graphql),
Postman/Insomnia/OpenAPI/HAR import. Contract-validation scope notes (local
`$ref`s only, 3.1-only, ajv `strict:false`) are in ADR 0005.

Decided (ADR 0004): new pure-TS **`@strummer/api`** package; **Bruno `.bru`** +
thin model (via `@usebruno/lang`); Strummer assertions/captures in a **sidecar
`*.strummer.yml`**; **deny-by-default** mutation safety (dry-run + allowlist +
`--unsafe`); secrets via `@napi-rs/keyring` + env fallback, value-redacted;
**QuickJS-sandboxed** JS scripts in v1. Engine: **undici 8**.

## Milestone log (historical)

> Pillar-by-pillar history. The **authoritative current state + test counts** are
> in the top block above; test counts in these bullets are point-in-time.

- Decisions locked (see ADR 0001 + ARCHITECTURE.md §7): **Strummer**, polyglot
  core, headless MCP+CLI, docs pillar first, **bge-small-en-v1.5 / 384-dim**
  embeddings, **React 19** first corpus, license posture local-index-only.
- Design grounded by a 6-stream research workflow → `ARCHITECTURE.md` (exact
  stack/versions, the SQLite contract, MCP tool shapes). Raw research archived in
  `docs/research/2026-05-31-design-research.md`.
- **Monorepo scaffolded and 100% green:** pnpm workspace + `@strummer/core` (TS;
  better-sqlite3 + sqlite-vec, Biome, Vitest, tsdown) and `py/strummer_ingest`
  (uv; Ruff, pytest). `pnpm gate` runs both toolchains.
- **Polyglot boundary proven (red→green):** Python builds `fixtures/golden.sqlite`
  (schema + FTS5 + vec0 float[384]); TS `openDb`/`searchDocs`/`getDoc` reads it,
  asserts the schema contract, finds `react/useState` via FTS with no
  cross-library leakage. sqlite-vec verified on **both** runtimes.
- **`@strummer/mcp` shipped:** MCP server (SDK 1.29) over `core` exposing
  `search_docs` (compact + `resourceUri`), `get_doc` (full body), and the
  `strummer://doc/{id}` resource. License: **Apache-2.0** (ADR 0002).
- **Real React 19.2 ingestion working end to end:** DevDocs adapter (`react`
  slug = 19.2, CC-BY-4.0) → section chunking (`extract`) → type normalization
  (`types_map`) → bge-small embeddings (`embed`) → SQLite (`build`), driven by
  `strummer-ingest build --slug react`. Produced a **1,279-fragment** index
  (`data/react.sqlite`, gitignored/reproducible) and queried it through the MCP
  server. The three leaf modules were built by a **parallel fan-out workflow**.
- **Hybrid search shipped:** `core.searchDocs` fuses FTS5/bm25 with `sqlite-vec`
  KNN via reciprocal rank fusion (optional `queryVector`). The MCP server embeds
  queries in-process with transformers.js (`Xenova/bge-small-en-v1.5`), which
  reproduces the Python-`fastembed` vectors exactly (cosine 1.0, ADR 0003) — so
  the server stays a self-contained Node process, no Python at serve time.
  Verified on the real index: `useState` now ranks the useState hook #1; pure
  semantic queries ("share state between components") hit the right guide.
- **Version-pinning shipped:** `core.resolveVersion` (semver; exact →
  nearest-same-major → refuse, never silently wrong) + `listVersions`. The
  ingester `build --append` puts multiple versions in one index; the real
  `data/react.sqlite` now holds **19.2 + 18.3.1 + 17.0.2** (2,905 fragments).
  `search_docs` takes `installed` (version/range) → resolves → filters and
  reports `resolvedVersion`/`versionNote`; new `list_versions` tool. Verified:
  installed `^18.2.0` → React 18.3.1 docs; `16.8.0` → flagged, not silently 19.x.
- **Auto-detect installed version shipped:** `core.detectInstalledVersion`
  (node_modules → package-lock.json → package.json range; works for npm/pnpm/
  yarn). New `detect_version` MCP tool; `search_docs` gains a `project` input
  (precedence version > installed > project). Verified end to end: pointing at a
  project with React 18 installed, with no version supplied, returns React
  18.3.1 docs.
- **`@strummer/cli` shipped:** `strummer search|get|versions|detect` over `core`
  (hybrid via `@strummer/embed`, `--json`, version flags). The query embedder was
  extracted into **`@strummer/embed`** (transformers.js, dynamic import) shared
  by cli + mcp.
- **CI gate:** `.github/workflows/ci.yml` mirrors `pnpm gate` (both toolchains)
  on push/PR.
- Dev container provisions pnpm + uv. **39 TS + 36 Py tests** (1 skipped real
  embed), all green. **Pillar 1 (docs/idioms) is functionally complete.**

## Next action

**Phase 3, Slice 1 (a11y-audit summarizer): DONE & committed** (`@strummer/browser`
scaffolded; `ArtifactStore`/`summarizeA11y`/`auditA11y`, TDD against an offline
fixture + real headless Chromium; CI + docker harness provision Chromium). The
slice deliberately deferred visual baselines + Lighthouse scores (the flaky parts).

**Slice 2 (browser lifecycle manager): DONE.** `BrowserManager` — lazy single
shared browser, ephemeral isolated context per session, `maxContexts` cap,
idle-TTL `sweepIdle` + `startReaper`, per-context default timeouts,
`closeSession`/`shutdown`. (Fake browser + deterministic clock + real-chromium
integration.)

**Slice 3 (ARIA-snapshot capture + serializer): DONE.** `snapshot.ts` —
`buildSnapshot`/`captureSnapshot`/`diffSnapshots`. NOTE the empirical revision of
the ADR open fork: `playwright-core` 1.60.0 has **no** `_snapshotForAI` and **no**
ref-ids in `ariaSnapshot()`, so Strummer parses the public `ariaSnapshot()` YAML
and **mints its own ref-ids** → semantic-locator descriptors `{role,name,nth}`
(per-snapshot, non-persisted), token-capped serialize + full-snapshot handle +
ref-independent diff. (See ADR 0006 update 2026-06-01.) **146 TS + 45 Py green.**
These two slices are committed to `main` but **not yet pushed** — push at the next
milestone (when the step tools make interaction usable end to end).

**Next, per ROADMAP Phase 3 (in rough order):** (1) **imperative step tools** over
refs (`navigate`/`click`/`fill`/`select`/`press`/`wait_for`/`snapshot`/`query`/
`get_text/attr`), resolving refs via the snapshot descriptors + `getByRole`; these
also bring the session wall-clock cap + max-pages; (2) the **deny-by-default
action gate** + interception dry-run; (3) the **two-tier SSRF defense** (factoring
`@strummer/safety` out of `@strummer/api`); then the artifact-capture pipeline.
Continue TDD red→green; `pnpm gate` must be 100% green before each commit.

---

Pillar 2 (`@strummer/api`) **engine + agent/human surfaces are complete**: the
MCP tools (`strummer-api-mcp`) and CLI (`strummer api …`) both ship over the
engine, fan-out built and integrated, all green. Remaining Pillar-2 tail (pick
any; none blocking):
1. Wire the **keyring** secret store into CLI/MCP (opt-in `--keyring` / env);
   today both default to `EnvSecretStore` (`STRUMMER_SECRET_<NAME>`).
2. **SSRF range-block + post-redirect re-check** in the safety gate (currently
   method + host-allowlist only).
3. Remaining request **body types**: multipart-form, file, graphql.
4. **Import**: Postman/Insomnia/OpenAPI (`@usebruno/converters`); HAR→`.bru`.
5. Contract-validation reach (ADR 0005): external/remote `$ref` deref; OpenAPI
   3.0 `nullable` shim; `operationName`-scoped GraphQL.

Or start **Phase 3 (browser/UI testing, Playwright over MCP)** — see ROADMAP.

Deferred Pillar-1 polish — **all DONE**: non-Node version detection (Python/Ruby
in `detectInstalledVersion`, wired into MCP/CLI); ingestion TOC-bleed + richer
`symbol` (`split_sections` strips on-page TOC lists; `symbol_from_heading`);
**Dash docset adapter** (`dash.iter_fragments` + `build --docset`, searchIndex
schema). Remaining Pillar-1 nice-to-haves: Homebrew tap; Dash Core Data docsets.

## How to build an index / register the server today

```bash
cd py/strummer_ingest && uv run strummer-ingest build --slug react --library react \
  --out ../../data/react.sqlite        # ~1,279 fragments, bge-small embeddings
claude mcp add strummer -- strummer-mcp /abs/path/to/data/react.sqlite
```
See `py/strummer_ingest/README.md` and `packages/mcp/README.md`.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this file (current phase + next action).
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (why).
4. Skim project memories and `git log --oneline -15`.
5. Continue from **Next action** above.

## Known open questions

- npm publishing: scope packages under `@strummer/*` (bare `strummer` is taken
  on npm). Name confirmed fine for repo + Homebrew tap.
- Captured/script-set values flow through `response.captured` unredacted (needed
  for chaining); the MCP/CLI surface layer must decide how to expose them.

## Resolved (was open)

- **Repo license: Apache-2.0** (ADR 0002; `LICENSE` + `NOTICE` committed).
- **Version-pin fallback** (nearest-same-major → refuse) validated on the real
  React index: `^18.2.0` → 18.3.1, `16.8.0` → flagged.
