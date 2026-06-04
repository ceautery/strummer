# ADR 0013 — Phase 5: cross-pillar verification — the capture→contract bridge + the unified change-verdict

- **Status:** Accepted (2026-06-04) — the human reviewed and confirmed all five open questions, each ratifying a choice the ADR already made: (1) ship **5a then 5b** as separate milestones; (2) **no baked-in `failAtOrAbove` default** — the operator/agent must declare the cut; (3) the capture gate is a **single `STRUMMER_VERIFY_ALLOW_CAPTURE` boolean atop the existing browser artifact gate**; (4) **`@strummer/verdict` is a new package** (accepted package-count cost for gate-independence); (5) the **exercised-operations spec-walk ships in 5a** (slice 5), accepted as net-new code.
- **Date:** 2026-06-04
- **Relates to:** ADR 0010 (Phase-4 sequencing, shared `@strummer/artifacts`, the paired deny-by-default gate, "TS first / Python staged"), ADR 0005 (api contract validation, no remote `$ref`), ADR 0006–0009 (browser pillar, HAR capture & redaction), the `@strummer/safety` / `@strummer/assert` / `@strummer/artifacts` extraction precedent.
- **Derivation:** this file is the corrected distillation of the internal design-fan-out synthesis after three adversarial critics. The corrections **materially changed the answer** (slice ordering, gate posture, the artifacts disk-path model, GraphQL scope, the empty-fold verdict) and are recorded below rather than trusted as-proposed, mirroring ADR 0010's method. *(It does not supersede ADR 0012 — that is the separate, Accepted deps version-algebra design.)*

## Context

Phase 4 shipped five self-contained, **pure, structured** per-pillar verdicts that nothing composes:
- `DependencyAudit.worstSeverity` (`packages/deps/src/audit.ts`) — note its scale includes `'unknown'` (`packages/deps/src/osv.ts:67`) and the honest `osvSnapshotLoaded:false` "no data ⇒ not a pass" precedent.
- `DiffCoverageReport` (`packages/coverage/src/report.ts`).
- `FlakeVerdict.state` / `flakeScore` (`packages/flake/src/classify.ts`) — `flaky` / `reliable` / `broken` / `insufficient-data`.
- `MutationSummary` — `metrics.mutationScore` is **`number | null`** (null when `valid===0`, `packages/mutate/src/summarize.ts`) and also exposes `survivors[]` directly.
- `ContractResult` (`packages/api/src/model.ts`) with `findings[]` of `severity: 'error' | 'warning'`.

The Phase-5 mission is to make the pillars **compose**: a captured browser/API run's traffic is validated against the API contract, and that contract sub-verdict folds with the four Phase-4 signals into **one structured verdict an agent requests for a change**.

What already exists and is load-bearing (verified against source):
- **The validate-half is shipped and pure:** `validateOpenApiResponse(spec, req:{method,path}, res:ResponseFacts{status,headers?,body}, opts)` (`packages/api/src/contract.ts:211`), template matching via `matchPath`/`pathToRegex` (`contract.ts:46–64`, splits query on `?`). It consumes a **parsed** JS body, not raw text. **It echoes `req.path` verbatim into the `missing-operation` finding message (`contract.ts:226`) and `err.message` into `response-schema` findings (`contract.ts:266–271`)** — these messages are NOT passed through any redactor.
- `validateGraphqlOperation(sdl, query, opts)` (`packages/api/src/graphql.ts:30`) — **requires the schema SDL as its first argument**; the SDL is a different artifact from the OpenAPI `spec` and **is nowhere in a HAR**.
- **The capture-half is shipped:** the browser HAR `.zip` by handle `strummer://browser/run/<id>/har` (`packages/browser/src/har.ts`). With a `.zip` path Playwright uses **`content:'attach'`** — request/response bodies are persisted as **separate archive entries**, not inline in `response.content.text` (`har.ts:6–27`). Redaction (`har.ts:13–19`) covers **only registered operator secrets + the HTTP password**; the file's own comment states "dynamically-set cookies/tokens are **not** scrubbed, which is why HAR stays operator-gated rather than on by default." The capture-side gate IS the compensating control for that gap.
- **The HAR-parse half is incomplete:** `importHar` (`packages/api/src/import.ts`) walks `log.entries` and normalizes the **request** half (method/url/body) but **drops the response entirely** — exactly the half the validator needs.
- **The artifact store is in-process-only and prefix-is-not-on-disk:** `ArtifactStore.get()` resolves only via the in-process `Map` populated by `put()` (`packages/artifacts/src/store.ts:63–67`); `contentType` is never persisted; and the on-disk path is `join(baseDir, runId, kind)` — **the `prefix` lives only in the handle string (`store.ts:42`), never on disk (`store.ts:49–51`)**. `handleFor()` does no sanitization and `join()` does not strip `..`.

This ADR makes the decisive choices for the first Phase-5 milestone. It is deliberately precise enough to be wrong.

## Decision

### 1. The core composition model

Two pure layers, separately TDD-able, that meet at a single reducer:

**(a) Capture→contract bridge** — a pure adapter `harEntriesToFacts` that turns a stored HAR into the records the *already-shipped* validator consumes. No request is re-run; it is a read over an existing artifact. Per-entry output is `{ req:{method,path}, res:ResponseFacts }`; a thin driver feeds each into `validateOpenApiResponse`, aggregating into `ContractResult[]` rolled to one contract sub-verdict (entries validated, findings by kind, first-failing entry, **and which documented operations were exercised** — the inverse-of-drift signal, computed by an explicit `spec.paths × methods` walk; see §5/correction).

**(b) Unified verdict reducer** — `composeVerdict(inputs, policy) → CompositeVerdict`, a deterministic, offline fold. Each pillar's native result is normalized by a **per-pillar pure adapter** onto one shape `PillarVerdict { pillar, status, severity, headline, counts, findings[], source? }`; severities reconcile by `maxSeverity` over a single shared scale; overall posture derives from policy (see §3a, the no-default-cut correction). The contract sub-verdict folds in as one more pillar (`pillar:'contract'`, reusing `ContractResult`), carrying a `source: 'run' | 'capture-from-HAR'` discriminator so trust/redaction provenance is not flattened away.

The load-bearing correctness rule, lifted from deps' `osvSnapshotLoaded:false` honesty: **absence is never a pass.** A pillar with no input is `missing`; a pillar that ran but had no usable signal (mutation `mutationScore===null` *and* no `survivors[]`; flake `insufficient-data`; deps with no OSV snapshot loaded; contract with zero exercised operations) is `no-signal`. **Neither ever resolves to `pass`** — the overall posture in either case is `inconclusive` (`ok:false`), not `pass`. This is the single most important invariant and is asserted by dedicated tests at both the empty-fold and per-pillar level.

### 2. Package & surface placement

Decisive split — **two packages, two concerns**:

- **`@strummer/verdict`** — the pure composition core. **Type-only imports** of each pillar's result interface (`DependencyAudit`, `DiffCoverageReport`, `FlakeVerdict`, `MutationSummary`, `ContractResult`); it must **never** import a pillar *runtime* (that would drag `better-sqlite3` in via flake, `playwright-core` via browser, and break the independent-gate posture). Houses `Severity` / `SEVERITY_RANK` / `maxSeverity`, the `PillarVerdict` / `CompositeVerdict` / `VerdictPolicy` types, the five `from*` adapters, and `composeVerdict`. No I/O.

- **The capture→contract bridge lives in `@strummer/api`** — new file `packages/api/src/har-capture.ts`, next to `validateOpenApiResponse` / `importHar`. It is API-pillar knowledge (HAR entries, OpenAPI path matching, GraphQL routing); placing it here lands it on the **api** green gate and reuses `matchPath`/`pathToRegex` rather than reinventing path templating. `@strummer/verdict` stays contract-agnostic — it consumes the resulting `ContractResult[]`, never HAR.

- **MCP surface** — a new `packages/mcp/src/verify.ts` + `strummer-verify-mcp` bin, mirroring `packages/mcp/src/deps.ts`: compact `CompositeVerdict` inline as `structuredContent`, full per-pillar detail by handle, one `ResourceTemplate('strummer://verify/{id}/{kind}')`. Plus `validate_capture` (the bridge surface) co-located on the **api** MCP server next to `validate_response`. **Both gated — see §3.**

- **CLI** — a `verify` case in `packages/cli/src/index.ts` + `packages/cli/src/verify.ts`, straight-through human flags, exit codes `0 pass / 1 fail / 2 inconclusive`.

The shared `Severity` scale is **defined in `@strummer/verdict`** (`'critical'|'high'|'moderate'|'low'|'none'`), seeded from deps' `SeverityBucket` vocabulary but *not* importing it. Extracting deps' scale into a shared package is **staged** — duplicating a small union is cheaper than a refactor that touches the deps gate now. Crucially, **deps' `'unknown'` maps to `no-signal` / advisory, never silently to `low` or `none`** — a tested invariant (§6, slice 6), not a policy footnote.

### 3. The operator-gate composition story (the central safety decision)

The synthesis draft claimed validating an already-redacted HAR is "free, like a GET." **All three critics rejected this as unsound, and they are right.** The HAR is operator-gated-off precisely because its redaction is known-incomplete (`har.ts:18`), and the validator adds a *fresh* un-redacted egress channel through finding messages (`contract.ts:226,270`). The corrected posture:

**3a. `validate_capture` and `request_verdict` are NOT ungated when an input is a browser HAR handle.** The first milestone is still **compose-only / zero-spawn** — nothing runs a pillar — but resolving and parsing a foreign HAR is a **read of operator-gated bytes** and inherits that gate:
- The bin requires the operator to have configured the artifacts root **and** an explicit `STRUMMER_VERIFY_ALLOW_CAPTURE` opt-in before `validate_capture` will resolve+parse a browser HAR handle. Read of a *freely-readable* artifact (one the producing pillar already deemed ungated) needs no extra opt-in; a HAR is not such an artifact.
- **Inherited trust is enforced as code, not asserted as prose:** the `strummer://verify/<id>/verdict` handle is served only behind the **same** artifact gate as the HAR it references — a consumer cannot read the verdict (and its embedded findings) at lower trust than the source HAR. A verdict referencing a HAR is **unresolvable without the browser artifact gate set** (red test).

**3b. No raw secret bytes enter the verdict, and every finding string is redacted.** The bridge extracts only `status` + the **parsed body** needed for schema validation — it MUST NOT copy raw request/response headers or cookies into the envelope. Every finding `message`, every echoed path, and any operation string is passed through the **operator `Redactor`** (`@strummer/safety`) before entering the `CompositeVerdict`, and reference paths use `matched.template` (not `req.path`). Red test: a HAR carrying an unregistered `Set-Cookie` / bearer token produces a verdict whose inline content **and** stored bytes contain neither the cookie nor the token.

**3c. No run gate exists in the first milestone, and no per-pillar run-gate env is pre-read.** Because nothing spawns, the v1 bin reads **only** `STRUMMER_ARTIFACTS_ROOT` + `STRUMMER_VERIFY_ALLOW_CAPTURE`. It does **not** speculatively read `STRUMMER_COVERAGE_ALLOW_RUN` / `STRUMMER_FLAKE_ALLOW_RUN` / `STRUMMER_MUTATE_ALLOW_RUN` — wiring those now would silently grant a future verify code path an operator's per-pillar runner grant via a shared env name. They are read **only** in the staged orchestration slice that actually spawns.

**3d. The staged orchestration rule is "compose, never widen."** When run-driving lands, `verify` threads each pillar's own opts struct straight through; a pillar whose own gate is unmet is `skipped: gate-not-set`, surfaced, never silently run. A verify-level flag can never satisfy a pillar's gate — guarded by a dedicated test. Safety stays **operator-set, never an agent input** (ADR 0010).

**3e. Sidecar and decompression are untrusted input.** The `<kind>.meta.json` contentType sidecar (§4) is validated against a small allowlist before use; `fflate` decompression of a HAR `.zip` is size-bounded (it is unbounded by default). GraphQL routing only fires when `content-type` is `application/json` **and** the operation matches no OpenAPI path (avoids mis-routing a REST body that happens to carry a top-level `query` field, which would emit body-echoing syntax findings).

### 4. Handle / plumbing scheme

The verdict is **itself a stored artifact**: `strummer://verify/<verdictId>/verdict` (`application/json`), inheriting `sha256` / `byteSize` / by-handle resolution. It embeds foreign handles **by reference + sha256**, never inlined bytes.

The critics found the real blocker, and a deeper one the draft missed: **the handle prefix is not on disk.** `put()` writes to `join(baseDir, runId, kind)` (`store.ts:49–51`); the prefix only appears in the handle string. So the draft's "pillar prefixes namespace the `<id>` space on disk" is **false** — two stores over one `baseDir` with the same `id` silently clobber, and a foreign-prefix handle is not resolvable by reconstructing a path from the *resolving* store's prefix. The corrected, security-hardened first-milestone fix (all on the already-green `@strummer/artifacts` gate):

1. **Prefix-qualify the disk path.** Write bytes to `<baseDir>/<prefix>/<id>/<kind>` (prefix INTO the path). A single shared `baseDir` is then genuinely collision-free across pillars, and a foreign handle is resolvable by reconstructing its full path from **the handle's own `prefix`+`id`** (parsed from the handle), not the resolving store's prefix.
2. **Rehydrate on miss / construction.** On a `get()` miss, parse the handle, stat `<baseDir>/<prefix>/<id>/<kind>`, read bytes, recompute `sha256`/`byteSize`. **Harden this read** — it is now a filesystem read addressed by an agent-supplied string:
   - Apply the existing `safeId()` allowlist (`[^A-Za-z0-9._-]`, per `deps.ts:75`) to `prefix`/`id`/`kind` in **both** `put()` and the rehydrate path; explicitly refuse `..`, path separators, and absolute paths.
   - `realpath` the resolved path and assert it is still under `baseDir` (the same realpath-confinement the LSP pillar built in `confine.ts`).
3. **Persist `contentType`.** Write a `<kind>.meta.json` sidecar in `put()` so rehydration recovers contentType (it cannot be inferred from raw bytes). On a **legacy artifact with no sidecar**, rehydration falls back to a defined `application/octet-stream` and surfaces a `contentTypeInferred: true` flag — never a silent failure. The sidecar's contentType is allowlist-validated before use (§3e).
4. **`sha256` makes staleness/GC detectable** even though no GC exists anywhere yet; introducing TTL/refcounting is **staged**.

This stays inside ARCHITECTURE §1 (large artifacts by handle, never inlined) and does **not** touch the SQLite polyglot boundary. The verdict is a plain stored artifact, deliberately **not** a SQLite-backed store.

### 5. Two-stage first milestone (split per the leverage critic), and what is staged

The bridge is the high-leverage cross-pillar **win** (it reuses 100% shipped validator code and delivers value alone); the reducer is mostly adapter plumbing over already-structured outputs. We therefore land them as **5a then 5b**, de-risking the artifacts plumbing separately from the reducer's value question. Both are still compose-only / zero-spawn.

**Milestone 5a — the capture→contract bridge (the cross-pillar win):**
- ArtifactStore prefix-qualified disk path + hardened rehydration + contentType sidecar.
- `harEntriesToFacts` (attach/zip body resolution **first**, inline `text` fallback) + the contract-aggregation driver + the explicit `spec.paths × methods` "exercised operations" walk.
- `validate_capture` MCP tool (api server) + CLI, behind the §3a capture gate.

**Milestone 5b — the unified verdict reducer:**
- `@strummer/verdict` pure core + the five `from*` adapters + `composeVerdict`.
- `request_verdict` MCP tool (`packages/mcp/src/verify.ts`) + `strummer-verify-mcp` bin + `strummer verify` CLI.
- ADR 0013 + STATUS/ROADMAP/memory updates.

**GraphQL is dropped from the first milestone** (was a buildability contradiction: `validate_capture(harHandle, spec)` carries no SDL input, and `validateGraphqlOperation` requires the SDL). Re-added as a clean staged follow-on with a discriminated contract input `{ openapi?, graphql?: { endpointPath, sdl } }`; until then, a detected GraphQL entry is `no-signal` with reason `graphql-sdl-not-supplied`, **never** a passing entry, and never falls through to the OpenAPI validator (which would flood `missing-operation`).

**Explicitly staged (in ROADMAP, not amputated):**
- **GraphQL drift over captured traffic** (needs the discriminated SDL input above).
- **Orchestration / run-driving `verify`** (pulls in every per-pillar gate; the "compose, never widen" gate-composition slice; the deferred env reads).
- **`verify` driving a live browser/API capture** to *produce* the HAR (keeps the browser gate out of the first cut — consume-only).
- **Request-body / request-param contract validation** (`contract.ts` is response-only today).
- **Extracting the shared `Severity` scale** out of deps.
- **Artifact GC / TTL / refcounting** and staleness enforcement beyond sha256 reporting.
- **The Python second half** (pytest / coverage.py / pyright capture), per ADR 0010's "TS first, Python staged."
- **Diff-scoping the non-coverage pillars** (changed deps / tests touching changed files / mutants in the diff) — a staged design question.

### 6. Ordered TDD slices (red→green→commit)

**Milestone 5a:**

1. **`@strummer/artifacts` prefix-qualified, hardened, cross-prefix resolution.** Red: (i) a store with prefix `verify` resolves a handle **minted with prefix `browser/run`** over a shared `baseDir` and gets the right bytes; (ii) two stores using the **same `id` but different prefixes** do NOT clobber; (iii) a handle whose `id`/`kind` contains `..` / a separator / an absolute path **throws**; (iv) a realpath escaping `baseDir` is refused. *(The draft's same-prefix red test would never catch the real cross-pillar case — this is the load-bearing primitive.)* Green: write to `<baseDir>/<prefix>/<id>/<kind>`; `safeId`-validate + realpath-confine in `put()` and rehydrate; rehydrate-on-miss by parsing the handle's own prefix+id; write the `<kind>.meta.json` sidecar; legacy-no-sidecar ⇒ `application/octet-stream` + `contentTypeInferred`.

2. **`harEntriesToFacts` — attach/zip body resolution (the PRIMARY path).** Red: a real Playwright-emitted `content:'attach'` HAR `.zip` fixture — one entry `GET /widgets` 200 whose body is a **separate archive entry** referenced by `_file`/sha1 — resolves to `[{req:{method:'GET',path:'/widgets'}, res:{status:200, headers:{…}, body:{id:1}}}]` (body JSON-**parsed**; URL reduced to `URL().pathname`). A second entry whose attached body is **unresolved** produces a hard **finding**, NOT an empty-body pass. Green: unzip (size-bounded, fflate, mirroring `trace.ts`) + entry-walk; inline `response.content.text` is the fallback (`content:'embed'`, which the browser pillar does not emit).

3. **Origin / content-type filter (PRIMARY, not late).** Red: a non-API asset (image / `text/css`, off-allowlist origin) is **skipped**, not validated — so the "exercised operations" set is not polluted and no false `missing-operation` flood occurs. Green: origin + content-type allowlist before any entry is routed to the validator.

4. **OpenAPI server-base-path reconciliation.** Red: spec `servers[].url` = `/api/v1`, request path `/api/v1/widgets`, spec path `/widgets` → matches the operation (no false `missing-operation`). Green: strip the resolved server base path before `matchPath`.

5. **Bridge → existing validator + the exercised-operations walk.** Red: pipe slice-2 output into `validateOpenApiResponse` with a tiny spec and assert the exact shipped drift findings; **separately** assert the bridge computes `exercisedOperations` / `unexercisedOperations` by walking `spec.paths × methods` (net-new code — this is NOT zero-new-validator-code; the *validator* is unchanged, the spec-walk is new and scoped here explicitly). Green: the driver + the spec-walk; **every finding message routed through the operator `Redactor`; reference paths use `matched.template`, never `req.path`** (§3b).

6. **`validate_capture` MCP + CLI, gated.** Red: `validate_capture(harHandle, spec)` returns compact `structuredContent` inline + detail by handle; resolving a browser HAR handle **without `STRUMMER_VERIFY_ALLOW_CAPTURE`** is refused; a HAR with an unregistered cookie/token yields a verdict whose inline + stored bytes contain neither. Green: api-server wiring over injected getters + CLI; the §3a/§3b enforcement.

**Milestone 5b:**

7. **Severity core + the empty-fold = inconclusive.** Red: `maxSeverity('low','critical')==='critical'`; `composeVerdict({})` returns **`{ok:false, status:'inconclusive', missing:['deps','coverage','flake','mutate','contract']}`** — NOT `ok:true/pass`. *(Corrected from the draft, which enshrined `ok:true/pass` for the empty fold — the exact laundering the missing≠pass rule forbids.)* Green: the `Severity`/`SEVERITY_RANK`/`maxSeverity` constants + a fold that treats all-missing/all-no-signal as `inconclusive`.

8. **`fromContractResults` + `fromDiffCoverage` + `fromDependencyAudits` + a real fold.** Red: a `ContractResult[]` with an error-finding → `PillarVerdict{pillar:'contract', status:'fail', source:'capture-from-HAR'}`; coverage with a new uncovered line → `fail`; deps `worstSeverity` maps onto the scale **and `'unknown'` maps to `no-signal` (tested invariant), never `low`/`none`**; deps with no OSV snapshot loaded forces `inconclusive`, never `pass`. Document each severity mapping's rationale inline (e.g. response-schema `error` → `high`). Green: the three adapters + reconcile, with `worstPillar` + per-pillar breakdown as first-class primary output.

9. **`fromFlakeVerdicts` + `fromMutationSummary` no-signal correctness.** Red: `mutationScore===null` **and no `survivors[]`** ⇒ `no-signal`; a run with `survivors[]` ⇒ `warn`/`fail` keyed off `survivors`/`counts` (NOT laundered to no-signal); flake `insufficient-data` ⇒ `no-signal`; flake `flaky` ⇒ `warn` scaled by `flakeScore`. Green: both adapters keyed off `survivors[]`/`counts`, not only `mutationScore===null`.

10. **`request_verdict` MCP + bin + CLI; no-default-cut posture.** Red: `request_verdict(inputs)` returns compact inline + detail by `strummer://verify/{id}/{kind}`; **`overall` posture requires an explicit policy cut — there is NO baked-in `failAtOrAbove` default** (force the operator/agent to declare the cut; the rollup must not silently encode a value judgment); the v1 bin reads ONLY `STRUMMER_ARTIFACTS_ROOT` + `STRUMMER_VERIFY_ALLOW_CAPTURE` and **does not** read any per-pillar `ALLOW_RUN` env (the §3c guard). Green: `verify.ts` wiring + `strummer-verify-mcp` bin + CLI `verify` case with exit codes `0/1/2`.

### 7. ARCHITECTURE invariants touched, and how it stays within them

- **§1 agent-first / large artifacts by handle, never inlined** — *honored.* Compact inline + per-pillar detail by `strummer://verify/<id>/<kind>`; foreign bytes referenced, never re-inlined.
- **§1 no-live-RPC polyglot boundary (SQLite file)** — *untouched.* All composition is over on-disk handles; no RPC, no new live subprocess; the LSP/browser subprocess fences are not extended; the verdict is a plain stored artifact, not a SQLite store.
- **Version-pinned, not latest** — *honored.* The bridge validates against the **operator-supplied spec for the installed API version**; no auto-generation/auto-patching of the contract from observed traffic. `@strummer/verdict` adds no new runtime dep (type-only pillar imports); the bridge reuses api's already-pinned `fflate`/`yaml`.
- **Deny-by-default, operator-set, never agent-settable** — *honored.* No run gate in v1 (compose-only), and `validate_capture`/the verdict handle are gated by the inherited HAR trust (`STRUMMER_VERIFY_ALLOW_CAPTURE` + the source artifact gate), NOT advertised as free. No per-pillar run-gate env is pre-wired. The staged orchestration's "compose, never widen" rule keeps each per-pillar gate independent.
- **Independent green gates per package/language** — *honored.* `@strummer/verdict` is pure with type-only imports; the bridge lands on the api gate; the artifacts fix lands on the artifacts gate. No real spawn enters `pnpm gate`.

**Files this design creates or edits:** `packages/artifacts/src/store.ts` (prefix-qualified path + hardened rehydrate + sidecar), new `packages/verdict/*`, new `packages/api/src/har-capture.ts` (+ `validate_capture` in the api MCP module), new `packages/mcp/src/verify.ts` + `packages/mcp/src/bin-verify.ts`, `packages/cli/src/index.ts` + new `packages/cli/src/verify.ts`, and this ADR.

## Consequences

- Phase 5 opens with **Milestone 5a** (the capture→contract bridge), whose slice 1 is the prefix-qualified, security-hardened ArtifactStore — the load-bearing cross-process primitive. **5b** (the unified verdict) follows immediately.
- The "validating a HAR is free" framing is **dropped**; reading an operator-gated HAR inherits its gate, and the verdict handle is served only at the source HAR's trust level. This is the single largest correction from the adversarial pass.
- The research + adversarial transcript is the workflow `phase5-cross-pillar-design`; this ADR is its durable distillation, in the spirit of ADR 0010.

## Corrections the adversarial pass forced (recorded, not trusted-as-proposed)

- **Empty fold must be `inconclusive`, not `pass`.** The draft's slice-2 green criterion (`composeVerdict({}) ⇒ ok:true/status:'pass'`) directly contradicted "absence is never a pass." Corrected (slice 7).
- **The artifact prefix is not on disk.** `put()` writes `join(baseDir, runId, kind)`; the draft assumed prefixes namespace the id space on disk. They do not — same-id different-pillar silently clobbers and cross-prefix resolution is impossible. Corrected to a prefix-qualified disk path + a cross-prefix red test (slice 1).
- **Rehydrate-on-miss is an LFI / cross-pillar read primitive.** It turns a closed in-process resolver into a filesystem read addressed by an agent-supplied string. Hardened with `safeId` + `..`/separator/absolute refusal + realpath-confinement (slice 1).
- **Validating a HAR is NOT free/ungated.** HAR redaction is known-incomplete (`har.ts:18`), and finding messages echo `req.path`/`err.message` un-redacted (`contract.ts:226,270`). Gated behind `STRUMMER_VERIFY_ALLOW_CAPTURE` + inherited source trust; all finding strings redacted; only status + parsed body extracted (§3a/3b).
- **GraphQL can't work from a HAR alone** — `validateGraphqlOperation` needs the SDL, which isn't in a HAR and isn't in the `validate_capture(harHandle, spec)` signature. Dropped to staged with a discriminated SDL input; a detected GraphQL entry is `no-signal:graphql-sdl-not-supplied`, never pass, never falls through to OpenAPI.
- **The attach/zip body path is the only one that runs on a real browser HAR** — inline `text` is `content:'embed'`, which the browser pillar does not emit. Reordered: attach/zip resolution is slice 2 (primary), verified against a real Playwright fixture; "attached-but-unresolved body" is a hard finding, never an empty-body pass.
- **The origin/content-type filter and server-base-path reconciliation are load-bearing for correctness**, not late optimizations — a polluted "exercised" set and a false `missing-operation` flood otherwise. Promoted to slices 3–4.
- **Mutation `survivors[]` must drive warn/fail** — keying only off `mutationScore===null` launders a real mutation gap into `no-signal` (slice 9).
- **deps `'unknown'` → `no-signal`** as a tested invariant, not a policy footnote (slice 8).
- **No baked-in `failAtOrAbove` default** — the rollup must not silently encode a value judgment across non-commensurable risks; `worstPillar` + per-pillar breakdown stay the primary output (slice 10).
- **Do not pre-wire per-pillar `ALLOW_RUN` env reads** into the v1 bin — an operator's per-pillar grant must not be silently inherited by a future verify code path sharing the env name (§3c, slice 10).
- **First milestone split** into 5a (bridge, the cross-pillar win) and 5b (reducer), de-risking the artifacts plumbing from the reducer's value question.
