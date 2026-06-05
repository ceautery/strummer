# ADR 0013 — Phase 5: cross-pillar verification — the capture→contract bridge + the unified change-verdict

- **Status:** Accepted (2026-06-04) — the human reviewed and confirmed all five open questions, each ratifying a choice the ADR already made: (1) ship **5a then 5b** as separate milestones; (2) **no baked-in `failAtOrAbove` default** — the operator/agent must declare the cut; (3) the capture gate is a **single `SACKVILLE_VERIFY_ALLOW_CAPTURE` boolean atop the existing browser artifact gate**; (4) **`@sackville-mcp/verdict` is a new package** (accepted package-count cost for gate-independence); (5) the **exercised-operations spec-walk ships in 5a** (slice 5), accepted as net-new code.
- **Date:** 2026-06-04
- **Relates to:** ADR 0010 (Phase-4 sequencing, shared `@sackville-mcp/artifacts`, the paired deny-by-default gate, "TS first / Python staged"), ADR 0005 (api contract validation, no remote `$ref`), ADR 0006–0009 (browser pillar, HAR capture & redaction), the `@sackville-mcp/safety` / `@sackville-mcp/assert` / `@sackville-mcp/artifacts` extraction precedent.
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
- **The capture-half is shipped:** the browser HAR `.zip` by handle `sackville://browser/run/<id>/har` (`packages/browser/src/har.ts`). With a `.zip` path Playwright uses **`content:'attach'`** — request/response bodies are persisted as **separate archive entries**, not inline in `response.content.text` (`har.ts:6–27`). Redaction (`har.ts:13–19`) covers **only registered operator secrets + the HTTP password**; the file's own comment states "dynamically-set cookies/tokens are **not** scrubbed, which is why HAR stays operator-gated rather than on by default." The capture-side gate IS the compensating control for that gap.
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

- **`@sackville-mcp/verdict`** — the pure composition core. **Type-only imports** of each pillar's result interface (`DependencyAudit`, `DiffCoverageReport`, `FlakeVerdict`, `MutationSummary`, `ContractResult`); it must **never** import a pillar *runtime* (that would drag `better-sqlite3` in via flake, `playwright-core` via browser, and break the independent-gate posture). Houses `Severity` / `SEVERITY_RANK` / `maxSeverity`, the `PillarVerdict` / `CompositeVerdict` / `VerdictPolicy` types, the five `from*` adapters, and `composeVerdict`. No I/O.

- **The capture→contract bridge lives in `@sackville-mcp/api`** — new file `packages/api/src/har-capture.ts`, next to `validateOpenApiResponse` / `importHar`. It is API-pillar knowledge (HAR entries, OpenAPI path matching, GraphQL routing); placing it here lands it on the **api** green gate and reuses `matchPath`/`pathToRegex` rather than reinventing path templating. `@sackville-mcp/verdict` stays contract-agnostic — it consumes the resulting `ContractResult[]`, never HAR.

- **MCP surface** — a new `packages/mcp/src/verify.ts` + `sackville-verify-mcp` bin, mirroring `packages/mcp/src/deps.ts`: compact `CompositeVerdict` inline as `structuredContent`, full per-pillar detail by handle, one `ResourceTemplate('sackville://verify/{id}/{kind}')`. Plus `validate_capture` (the bridge surface) co-located on the **api** MCP server next to `validate_response`. **Both gated — see §3.**

- **CLI** — a `verify` case in `packages/cli/src/index.ts` + `packages/cli/src/verify.ts`, straight-through human flags, exit codes `0 pass / 1 fail / 2 inconclusive`.

The shared `Severity` scale is **defined in `@sackville-mcp/verdict`** (`'critical'|'high'|'moderate'|'low'|'none'`), seeded from deps' `SeverityBucket` vocabulary but *not* importing it. Extracting deps' scale into a shared package is **staged** — duplicating a small union is cheaper than a refactor that touches the deps gate now. Crucially, **deps' `'unknown'` maps to `no-signal` / advisory, never silently to `low` or `none`** — a tested invariant (§6, slice 6), not a policy footnote.

### 3. The operator-gate composition story (the central safety decision)

The synthesis draft claimed validating an already-redacted HAR is "free, like a GET." **All three critics rejected this as unsound, and they are right.** The HAR is operator-gated-off precisely because its redaction is known-incomplete (`har.ts:18`), and the validator adds a *fresh* un-redacted egress channel through finding messages (`contract.ts:226,270`). The corrected posture:

**3a. `validate_capture` and `request_verdict` are NOT ungated when an input is a browser HAR handle.** The first milestone is still **compose-only / zero-spawn** — nothing runs a pillar — but resolving and parsing a foreign HAR is a **read of operator-gated bytes** and inherits that gate:
- The bin requires the operator to have configured the artifacts root **and** an explicit `SACKVILLE_VERIFY_ALLOW_CAPTURE` opt-in before `validate_capture` will resolve+parse a browser HAR handle. Read of a *freely-readable* artifact (one the producing pillar already deemed ungated) needs no extra opt-in; a HAR is not such an artifact.
- **Inherited trust is enforced as code, not asserted as prose:** the `sackville://verify/<id>/verdict` handle is served only behind the **same** artifact gate as the HAR it references — a consumer cannot read the verdict (and its embedded findings) at lower trust than the source HAR. A verdict referencing a HAR is **unresolvable without the browser artifact gate set** (red test).

**3b. No raw secret bytes enter the verdict, and every finding string is redacted.** The bridge extracts only `status` + the **parsed body** needed for schema validation — it MUST NOT copy raw request/response headers or cookies into the envelope. Every finding `message`, every echoed path, and any operation string is passed through the **operator `Redactor`** (`@sackville-mcp/safety`) before entering the `CompositeVerdict`, and reference paths use `matched.template` (not `req.path`). Red test: a HAR carrying an unregistered `Set-Cookie` / bearer token produces a verdict whose inline content **and** stored bytes contain neither the cookie nor the token.

**3c. No run gate exists in the first milestone, and no per-pillar run-gate env is pre-read.** Because nothing spawns, the v1 bin reads **only** `SACKVILLE_ARTIFACTS_ROOT` + `SACKVILLE_VERIFY_ALLOW_CAPTURE`. It does **not** speculatively read `SACKVILLE_COVERAGE_ALLOW_RUN` / `SACKVILLE_FLAKE_ALLOW_RUN` / `SACKVILLE_MUTATE_ALLOW_RUN` — wiring those now would silently grant a future verify code path an operator's per-pillar runner grant via a shared env name. They are read **only** in the staged orchestration slice that actually spawns.

**3d. The staged orchestration rule is "compose, never widen."** When run-driving lands, `verify` threads each pillar's own opts struct straight through; a pillar whose own gate is unmet is `skipped: gate-not-set`, surfaced, never silently run. A verify-level flag can never satisfy a pillar's gate — guarded by a dedicated test. Safety stays **operator-set, never an agent input** (ADR 0010).

**3e. Sidecar and decompression are untrusted input.** The `<kind>.meta.json` contentType sidecar (§4) is validated against a small allowlist before use; `fflate` decompression of a HAR `.zip` is size-bounded (it is unbounded by default). GraphQL routing only fires when `content-type` is `application/json` **and** the operation matches no OpenAPI path (avoids mis-routing a REST body that happens to carry a top-level `query` field, which would emit body-echoing syntax findings).

### 4. Handle / plumbing scheme

The verdict is **itself a stored artifact**: `sackville://verify/<verdictId>/verdict` (`application/json`), inheriting `sha256` / `byteSize` / by-handle resolution. It embeds foreign handles **by reference + sha256**, never inlined bytes.

The critics found the real blocker, and a deeper one the draft missed: **the handle prefix is not on disk.** `put()` writes to `join(baseDir, runId, kind)` (`store.ts:49–51`); the prefix only appears in the handle string. So the draft's "pillar prefixes namespace the `<id>` space on disk" is **false** — two stores over one `baseDir` with the same `id` silently clobber, and a foreign-prefix handle is not resolvable by reconstructing a path from the *resolving* store's prefix. The corrected, security-hardened first-milestone fix (all on the already-green `@sackville-mcp/artifacts` gate):

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
- `@sackville-mcp/verdict` pure core + the five `from*` adapters + `composeVerdict`.
- `request_verdict` MCP tool (`packages/mcp/src/verify.ts`) + `sackville-verify-mcp` bin + `sackville verify` CLI.
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

1. **`@sackville-mcp/artifacts` prefix-qualified, hardened, cross-prefix resolution.** Red: (i) a store with prefix `verify` resolves a handle **minted with prefix `browser/run`** over a shared `baseDir` and gets the right bytes; (ii) two stores using the **same `id` but different prefixes** do NOT clobber; (iii) a handle whose `id`/`kind` contains `..` / a separator / an absolute path **throws**; (iv) a realpath escaping `baseDir` is refused. *(The draft's same-prefix red test would never catch the real cross-pillar case — this is the load-bearing primitive.)* Green: write to `<baseDir>/<prefix>/<id>/<kind>`; `safeId`-validate + realpath-confine in `put()` and rehydrate; rehydrate-on-miss by parsing the handle's own prefix+id; write the `<kind>.meta.json` sidecar; legacy-no-sidecar ⇒ `application/octet-stream` + `contentTypeInferred`.

2. **`harEntriesToFacts` — attach/zip body resolution (the PRIMARY path).** Red: a real Playwright-emitted `content:'attach'` HAR `.zip` fixture — one entry `GET /widgets` 200 whose body is a **separate archive entry** referenced by `_file`/sha1 — resolves to `[{req:{method:'GET',path:'/widgets'}, res:{status:200, headers:{…}, body:{id:1}}}]` (body JSON-**parsed**; URL reduced to `URL().pathname`). A second entry whose attached body is **unresolved** produces a hard **finding**, NOT an empty-body pass. Green: unzip (size-bounded, fflate, mirroring `trace.ts`) + entry-walk; inline `response.content.text` is the fallback (`content:'embed'`, which the browser pillar does not emit).

3. **Origin / content-type filter (PRIMARY, not late).** Red: a non-API asset (image / `text/css`, off-allowlist origin) is **skipped**, not validated — so the "exercised operations" set is not polluted and no false `missing-operation` flood occurs. Green: origin + content-type allowlist before any entry is routed to the validator.

4. **OpenAPI server-base-path reconciliation.** Red: spec `servers[].url` = `/api/v1`, request path `/api/v1/widgets`, spec path `/widgets` → matches the operation (no false `missing-operation`). Green: strip the resolved server base path before `matchPath`.

5. **Bridge → existing validator + the exercised-operations walk.** Red: pipe slice-2 output into `validateOpenApiResponse` with a tiny spec and assert the exact shipped drift findings; **separately** assert the bridge computes `exercisedOperations` / `unexercisedOperations` by walking `spec.paths × methods` (net-new code — this is NOT zero-new-validator-code; the *validator* is unchanged, the spec-walk is new and scoped here explicitly). Green: the driver + the spec-walk; **every finding message routed through the operator `Redactor`; reference paths use `matched.template`, never `req.path`** (§3b).

6. **`validate_capture` MCP + CLI, gated.** Red: `validate_capture(harHandle, spec)` returns compact `structuredContent` inline + detail by handle; resolving a browser HAR handle **without `SACKVILLE_VERIFY_ALLOW_CAPTURE`** is refused; a HAR with an unregistered cookie/token yields a verdict whose inline + stored bytes contain neither. Green: api-server wiring over injected getters + CLI; the §3a/§3b enforcement.

**Milestone 5b:**

7. **Severity core + the empty-fold = inconclusive.** Red: `maxSeverity('low','critical')==='critical'`; `composeVerdict({})` returns **`{ok:false, status:'inconclusive', missing:['deps','coverage','flake','mutate','contract']}`** — NOT `ok:true/pass`. *(Corrected from the draft, which enshrined `ok:true/pass` for the empty fold — the exact laundering the missing≠pass rule forbids.)* Green: the `Severity`/`SEVERITY_RANK`/`maxSeverity` constants + a fold that treats all-missing/all-no-signal as `inconclusive`.

8. **`fromContractResults` + `fromDiffCoverage` + `fromDependencyAudits` + a real fold.** Red: a `ContractResult[]` with an error-finding → `PillarVerdict{pillar:'contract', status:'fail', source:'capture-from-HAR'}`; coverage with a new uncovered line → `fail`; deps `worstSeverity` maps onto the scale **and `'unknown'` maps to `no-signal` (tested invariant), never `low`/`none`**; deps with no OSV snapshot loaded forces `inconclusive`, never `pass`. Document each severity mapping's rationale inline (e.g. response-schema `error` → `high`). Green: the three adapters + reconcile, with `worstPillar` + per-pillar breakdown as first-class primary output.

9. **`fromFlakeVerdicts` + `fromMutationSummary` no-signal correctness.** Red: `mutationScore===null` **and no `survivors[]`** ⇒ `no-signal`; a run with `survivors[]` ⇒ `warn`/`fail` keyed off `survivors`/`counts` (NOT laundered to no-signal); flake `insufficient-data` ⇒ `no-signal`; flake `flaky` ⇒ `warn` scaled by `flakeScore`. Green: both adapters keyed off `survivors[]`/`counts`, not only `mutationScore===null`.

10. **`request_verdict` MCP + bin + CLI; no-default-cut posture.** Red: `request_verdict(inputs)` returns compact inline + detail by `sackville://verify/{id}/{kind}`; **`overall` posture requires an explicit policy cut — there is NO baked-in `failAtOrAbove` default** (force the operator/agent to declare the cut; the rollup must not silently encode a value judgment); the v1 bin reads ONLY `SACKVILLE_ARTIFACTS_ROOT` + `SACKVILLE_VERIFY_ALLOW_CAPTURE` and **does not** read any per-pillar `ALLOW_RUN` env (the §3c guard). Green: `verify.ts` wiring + `sackville-verify-mcp` bin + CLI `verify` case with exit codes `0/1/2`.

### 7. ARCHITECTURE invariants touched, and how it stays within them

- **§1 agent-first / large artifacts by handle, never inlined** — *honored.* Compact inline + per-pillar detail by `sackville://verify/<id>/<kind>`; foreign bytes referenced, never re-inlined.
- **§1 no-live-RPC polyglot boundary (SQLite file)** — *untouched.* All composition is over on-disk handles; no RPC, no new live subprocess; the LSP/browser subprocess fences are not extended; the verdict is a plain stored artifact, not a SQLite store.
- **Version-pinned, not latest** — *honored.* The bridge validates against the **operator-supplied spec for the installed API version**; no auto-generation/auto-patching of the contract from observed traffic. `@sackville-mcp/verdict` adds no new runtime dep (type-only pillar imports); the bridge reuses api's already-pinned `fflate`/`yaml`.
- **Deny-by-default, operator-set, never agent-settable** — *honored.* No run gate in v1 (compose-only), and `validate_capture`/the verdict handle are gated by the inherited HAR trust (`SACKVILLE_VERIFY_ALLOW_CAPTURE` + the source artifact gate), NOT advertised as free. No per-pillar run-gate env is pre-wired. The staged orchestration's "compose, never widen" rule keeps each per-pillar gate independent.
- **Independent green gates per package/language** — *honored.* `@sackville-mcp/verdict` is pure with type-only imports; the bridge lands on the api gate; the artifacts fix lands on the artifacts gate. No real spawn enters `pnpm gate`.

**Files this design creates or edits:** `packages/artifacts/src/store.ts` (prefix-qualified path + hardened rehydrate + sidecar), new `packages/verdict/*`, new `packages/api/src/har-capture.ts` (+ `validate_capture` in the api MCP module), new `packages/mcp/src/verify.ts` + `packages/mcp/src/bin-verify.ts`, `packages/cli/src/index.ts` + new `packages/cli/src/verify.ts`, and this ADR.

## Consequences

- Phase 5 opens with **Milestone 5a** (the capture→contract bridge), whose slice 1 is the prefix-qualified, security-hardened ArtifactStore — the load-bearing cross-process primitive. **5b** (the unified verdict) follows immediately.
- The "validating a HAR is free" framing is **dropped**; reading an operator-gated HAR inherits its gate, and the verdict handle is served only at the source HAR's trust level. This is the single largest correction from the adversarial pass.
- The research + adversarial transcript is the workflow `phase5-cross-pillar-design`; this ADR is its durable distillation, in the spirit of ADR 0010.

## Corrections the adversarial pass forced (recorded, not trusted-as-proposed)

- **Empty fold must be `inconclusive`, not `pass`.** The draft's slice-2 green criterion (`composeVerdict({}) ⇒ ok:true/status:'pass'`) directly contradicted "absence is never a pass." Corrected (slice 7).
- **The artifact prefix is not on disk.** `put()` writes `join(baseDir, runId, kind)`; the draft assumed prefixes namespace the id space on disk. They do not — same-id different-pillar silently clobbers and cross-prefix resolution is impossible. Corrected to a prefix-qualified disk path + a cross-prefix red test (slice 1).
- **Rehydrate-on-miss is an LFI / cross-pillar read primitive.** It turns a closed in-process resolver into a filesystem read addressed by an agent-supplied string. Hardened with `safeId` + `..`/separator/absolute refusal + realpath-confinement (slice 1).
- **Validating a HAR is NOT free/ungated.** HAR redaction is known-incomplete (`har.ts:18`), and finding messages echo `req.path`/`err.message` un-redacted (`contract.ts:226,270`). Gated behind `SACKVILLE_VERIFY_ALLOW_CAPTURE` + inherited source trust; all finding strings redacted; only status + parsed body extracted (§3a/3b).
- **GraphQL can't work from a HAR alone** — `validateGraphqlOperation` needs the SDL, which isn't in a HAR and isn't in the `validate_capture(harHandle, spec)` signature. Dropped to staged with a discriminated SDL input; a detected GraphQL entry is `no-signal:graphql-sdl-not-supplied`, never pass, never falls through to OpenAPI.
- **The attach/zip body path is the only one that runs on a real browser HAR** — inline `text` is `content:'embed'`, which the browser pillar does not emit. Reordered: attach/zip resolution is slice 2 (primary), verified against a real Playwright fixture; "attached-but-unresolved body" is a hard finding, never an empty-body pass.
- **The origin/content-type filter and server-base-path reconciliation are load-bearing for correctness**, not late optimizations — a polluted "exercised" set and a false `missing-operation` flood otherwise. Promoted to slices 3–4.
- **Mutation `survivors[]` must drive warn/fail** — keying only off `mutationScore===null` launders a real mutation gap into `no-signal` (slice 9).
- **deps `'unknown'` → `no-signal`** as a tested invariant, not a policy footnote (slice 8).
- **No baked-in `failAtOrAbove` default** — the rollup must not silently encode a value judgment across non-commensurable risks; `worstPillar` + per-pillar breakdown stay the primary output (slice 10).
- **Do not pre-wire per-pillar `ALLOW_RUN` env reads** into the v1 bin — an operator's per-pillar grant must not be silently inherited by a future verify code path sharing the env name (§3c, slice 10).
- **First milestone split** into 5a (bridge, the cross-pillar win) and 5b (reducer), de-risking the artifacts plumbing from the reducer's value question.

---

## Addendum (2026-06-04) — Milestone 5c: run-driving / orchestration `verify`

- **Status:** Accepted (2026-06-04) — the human ratified this addendum as-is, including the gate-env "both required" contract. Distilled from the `verify-orchestration-design-research` fan-out (6 research streams) → human ratification of 4 forks → the `verify-orchestration-adversarial-critics` fan-out (3 distinct-lens critics), whose corrections **materially changed the gate-env mechanism and the status model** and are recorded below rather than trusted-as-proposed (the ADR 0010/0013 method).
- **Relates to:** §3c/§3d/§5 of the body above (this addendum implements the "Orchestration / run-driving `verify`" staged item); ADR 0010 (the paired deny-by-default gate, injected-runner seam, "no real spawn in the gate"); ADR 0011 (LSP write-mode's separate-gate precedent).

### Context

5a/5b shipped a **compose-only** verify: `request_verdict` folds per-pillar *results the caller already produced*. The agent must drive each pillar (coverage/flake/mutate/deps + the capture bridge) itself, gather five outputs, and hand them over. Milestone 5c closes that loop: a **`verify_change`** surface that DRIVES the gated pillars itself and folds them into one `CompositeVerdict` in a **single agent call** — the "is this change safe?" one-shot. The first cut runs the pillars **unscoped** (whole project); diff-scoping is 5d.

The whole design turns on one rule from §3d — **"compose, never widen"**: verify reuses each pillar's *existing* paired deny-by-default gate and never invents an umbrella gate that bypasses it; a verify-level flag can never satisfy a pillar's gate; safety is operator-set, never an agent input.

### Decisions (4 forks, human-ratified 2026-06-04)

1. **Placement — a NEW runtime package `@sackville-mcp/verify`.** A run-driving orchestrator must import the runtime engines, so it **cannot** live in the pure, type-only `@sackville-mcp/verdict` (which must keep its zero-import `.mjs` so it never drags in `better-sqlite3`/`playwright-core`). `@sackville-mcp/verify` houses a gated `orchestrate()` over `Promise.allSettled`, its opts/config types, and the per-pillar result→`PillarVerdict` mapping; it depends on `@sackville-mcp/verdict` (pure fold) + the engine packages **for types and the injected-seam interfaces only**. `packages/mcp/src/verify.ts` and `packages/cli/src/verify.ts` are thin wrappers over it. *(Mirrors the project's "engine in a package, thin surfaces" shape and ADR 0013 §2's accepted package-count-for-isolation tradeoff.)*

2. **Surface — a NEW sibling MCP tool `verify_change`,** alongside the unchanged compose-only `request_verdict`. Registered **only when run-driving is enabled** (deny-by-default registration, mirroring `run_scoped`/`flake_run`/`mutate_run`). CLI: `sackville verify run <root>`; bare `sackville verify` stays compose-only. *(Mirrors deps' `audit_dependency`/`audit_project` dual-tool split; keeps the three ADR-0013 milestones as distinct code paths.)*

3. **Scope — run-driving FIRST (unscoped), diff-scoping is 5d.** The novel/risky part is the gated orchestration + provenance + failure isolation; scoping is purely additive (coverage already scopes; flake `runAndRecord` already accepts `files`; mutate already has `mutateFiles`/`--incremental`; only deps needs a net-new pure `changedDependencies(diff, ecosystem)`).

4. **Capture — consume-only for this arc.** The agent produces the HAR via the browser pillar; verify bridges it via the *shipped* `validateCapturedTraffic` (pure, no spawn) behind the **existing** capture gate. **`verify` driving a live browser/API capture stays staged** (5e): the browser path pulls the heaviest gate into verify's critical path, and the API-runner-synth path has correctness gaps (collapsed redirect chains, lost request body ⇒ no GraphQL, lossy redaction).

### The gate-composition contract (the load-bearing safety decision)

**"Compose, never widen" is enforced at three layers:**

**(a) Gate INPUTS come only from the operator, never the agent.** The orchestrator constructs each pillar's own `{allowRun, allowedRoots, timeoutMs}` (deps: network fetcher + OSV dir) **from the verify run-driving bin's operator env**. The agent's `verify_change` input selects only *which* pillars to attempt, the project root (operator-auto-allowed), and `failAtOrAbove`. No agent input can set `allowRun`/`allowedRoots`/timeout — guarded by a dedicated test.

**(b) Env model — "both required", NOT verify-scoped renames (adversarial correction).** The initial draft proposed verify-scoped env names (`SACKVILLE_VERIFY_COVERAGE_ALLOW_RUN`, …). **The safety critic rejected this:** it spawns a *second, independent* grant vector that drifts out of sync with the standalone pillar server's gate — a worse footgun, and it does not actually close §3c's silent-inheritance hole. The ratified model:
  - verify reads the pillar's **own** gate inputs (`SACKVILLE_COVERAGE_ALLOW_RUN` + `_PROJECT_ROOTS` + `_TIMEOUT_MS`, etc.) as the **single source of truth** — no drift, the same grant the standalone server honors; **and**
  - verify requires a **separate, explicit `SACKVILLE_VERIFY_ENABLE_RUN`** opt-in before it will drive *any* pillar run.
  - So verify runs pillar P **iff** (P's own run-gate is satisfied) **AND** (`SACKVILLE_VERIFY_ENABLE_RUN` is set). This **composes** the existing per-pillar grant (verify can never run P when P's run is disabled — never widens it) and adds a conscious, server-level "this server may drive runs" switch that closes §3c's "silently grant a future verify code path an operator's per-pillar grant" hazard. There is **no** umbrella that turns on all spawning pillars at once.
  - This is consistent with §3c read correctly: §3c forbade *pre-reading* per-pillar `ALLOW_RUN` in the **compose-only** bin (where nothing spawns). The run-driving bin reads them precisely because it now spawns — exactly §3c's "read only in the slice that actually spawns" — and gates that read behind `SACKVILLE_VERIFY_ENABLE_RUN`. The compose-only `bin-verify.ts` path stays **env-identical** (its red test that it reads no per-pillar env must keep passing); only the new run-driving entrypoint reads the pillar gates.

**(c) Deny-by-default REGISTRATION.** `verify_change` is registered **only** when `SACKVILLE_VERIFY_ENABLE_RUN` is set and at least one pillar's gate is satisfiable — not merely a runtime check (mirrors `coverage.ts`'s `allowRun && allowedRoots.length>0` registration gate). A requested pillar whose own gate is unmet ⇒ `skipped: gate-not-set`, surfaced, never run.

**(d) No NEW egress; errors are redacted (adversarial correction).** Runner failures leak temp paths (e.g. `coverage/run.ts` throws "did not produce a coverage report at `${coveragePath}`"). `orchestrate()` takes a **`redact` callback** (mirroring the HAR bridge's `ValidateCaptureOptions.redact`); every `errorReason` is run through it before entering the `CompositeVerdict` (inline **and** stored bytes). The consume-only contract path keeps the §3b redaction it already has.

**(e) `@sackville-mcp/verify` imports ZERO spawn-capable code (adversarial correction).** No module-level import of `defaultVitestRunner`/`defaultStrykerRunner`/`HistoryStore`/the capture bridge. Runners, the flake history store, and the capture validator are **all required-injected**; engine packages are `external` in tsdown. The bin/CLI wires the real implementations; the gate test injects fakes (incl. a fake/in-memory history store), so `better-sqlite3`/`playwright-core` never load in `pnpm gate`. Verified by inspecting the built `.mjs` for inline native requires.

### Verdict model: provenance fields, NOT new statuses (adversarial correction)

The draft proposed extending `PillarStatus` with `'errored'`/`'skipped'`. **The verdict-semantics critic rejected this:** `compose.ts` and `cli/verify.ts` switch exhaustively on `status`, and `failsByPolicy` only guards `'warn'|'fail'` — new enum values silently corrupt the fold. Ratified instead:
- `PillarStatus` is **unchanged** (`'pass'|'warn'|'fail'|'no-signal'|'missing'`).
- `PillarVerdict` gains optional **provenance** fields: `skipReason?: 'gate-not-set' | 'not-requested'` and `errorReason?: string` (redacted).
- A pillar that was gate-blocked or crashed gets `status: 'no-signal'` (a requested-but-no-usable-signal outcome) + the provenance field; a pillar the agent did not request stays `'missing'` (the existing omitted-pillar shape) + optional `skipReason:'not-requested'`. **Both already fold to `inconclusive`** — so "absence is never a pass" extends to gate-blocked/errored/not-requested **for free**, with no change to the fold's status switch. The `inconclusive` predicate is widened only to *also* recognize a present `skipReason`/`errorReason` (defensive; `no-signal`/`missing` already trigger it).
- A genuine `fail` from a pillar that *did* run still wins over a sibling's `skipped`/`no-signal` (a real failure is worse than absence) — `{coverage:fail, flake:skipped} ⇒ fail`, tested.

### Execution, determinism, failure isolation

- **Parallel via `Promise.allSettled`** — one pillar's crash/timeout never sinks the verdict. Per-pillar wall-clock reuses each runner's own `timeoutMs`; an **aggregate deadline is staged**.
- **Gate-denial vs error are distinguishable without importing spawn-capable code.** A pillar's own `assertAllowed` denial ⇒ `skipped: gate-not-set`; any other rejection ⇒ `errored` (redacted). Mechanism (to settle in the first slice): a small **structural brand** on the four `*GateError` classes that `@sackville-mcp/verify` can detect without `instanceof`-importing each class (preferred — reuses the real gate), or the bin pre-validating each gate and passing only runnable pillars to `orchestrate()` (fallback). deps' "absent fetcher" and flake's "absent DB" are gate-ish and must map to `skipped: gate-not-set`, not `errored`.
- **Injected `idFactory`, default `randomUUID` (adversarial correction).** A content-hash id collides-and-clobbers in the artifact store (no dedup ⇒ last-write-wins). Keep `randomUUID` in production (collision-safe per write); tests inject a deterministic stub to assert handle equality.

### What stays staged (5d/5e and beyond)

- **5d — diff-scoping the non-coverage pillars:** a shared changed-set primitive (extend coverage's `parseUnifiedDiff` or extract `@sackville-mcp/diff`); expose flake's existing `files`; pure `changedDependencies(diff, ecosystem)` for deps; mutate already done.
- **5e — `verify` driving a live capture** to *produce* the HAR (browser-spawn behind the browser gate; and/or an API-runner capture path once the runner records redirect hops + request bodies).
- Request-body/param contract validation; extracting the shared `Severity` scale out of deps; artifact GC/TTL; the Python second half.

### Corrections the adversarial pass forced (recorded, not trusted-as-proposed)

- **Verify-scoped env names are the WRONG guard** — they create a second grant vector that drifts. Replaced with the "reuse the pillar's own gate as the single source of truth + a separate `SACKVILLE_VERIFY_ENABLE_RUN` opt-in" model (both required). *(§ gate-composition (b).)*
- **Do NOT extend `PillarStatus`** — exhaustive switches + `failsByPolicy`'s `warn|fail` guard would silently mishandle new values. Use optional provenance fields + `status:'no-signal'`/`'missing'`. *(§ verdict model.)*
- **`@sackville-mcp/verify` must import zero spawn-capable code** — a runtime dep on the engines does not by itself break the spawn-free gate, but importing `defaultVitestRunner`/`HistoryStore`/etc. would. All injected; engines `external`; verify the built `.mjs`. *(§ gate-composition (e).)*
- **Mandatory error redaction** — runner errors echo temp paths; `orchestrate()` redacts every `errorReason`. *(§ gate-composition (d).)*
- **Deny-by-default registration, not just runtime** — `verify_change` registers only when run-driving is enabled. *(§ gate-composition (c).)*
- **`idFactory` default `randomUUID`, not content-hash** — content-hash clobbers identical verdicts in the store. *(§ execution.)*
- **The research + adversarial transcript** is the `verify-orchestration-design-research` + `verify-orchestration-adversarial-critics` workflows; this addendum is their durable distillation.

---

## Addendum 3 (2026-06-04): Milestone 5e — verify-driven LIVE capture (browser-spawn)

**Status: COMPLETE** (2026-06-04) — all 8 slices landed TDD red→green; 1122 TS + 45 Py green. The
load-bearing flow-completeness correction shipped in `@sackville-mcp/browser` `driveBrowserFlowToHar`; the
attach-body redaction leak (Fork 2) was confirmed by test and fixed (`finalizeHar` redacts by declared
mimeType). One deviation from the slice plan, human-ratified: `driveBrowserFlowToHar` was extracted to
`@sackville-mcp/browser` (not kept in `packages/mcp`) so the MCP bin AND the `sackville verify run --flow` CLI
share ONE flow-completeness guard (the CLI cannot import `sackville`). 5f (API-runner capture + the
older tails) stays staged.

Forged via the `verify-live-capture-design` fan-out (5 research streams reading the real code →
synthesis → 3 adversarial critics; all three returned **sound-with-fixes**, browser-spawn endorsed).
The human ratified the forks. This addendum is the durable distillation; the workflow transcript is the
research record.

5e turns the **consume-only** capture→contract bridge (5a/5b: the agent produces a HAR, verify validates
it by handle) into a **verify-DRIVEN** one: a single gated call drives a browser flow, captures the HAR,
and validates it against the contract. The `@sackville-mcp/verify` **core is untouched** — the injected
contract-runner seam (`OrchestrateRequest.contract.run: () => Promise<ContractResult[]>`) is opaque to
whether the runner consumes a stored HAR or drives a live one. All new code lives in `packages/mcp`
(surface) — invariant 1 (core `.mjs` imports only `node:crypto` + `@sackville-mcp/verdict`) holds trivially
(the source-scan only covers `packages/verify/src/`).

### Ratified forks

1. **Capture engine — browser-spawn ONLY for 5e; API-runner staged to 5f.** Browser-spawn reuses the
   shipped, redaction-complete HAR production (`finalizeHar`) + flow driving (`runFlow`) + the existing
   `validateCapturedTraffic`, so it ships full **REST + GraphQL** parity on day one. The API-runner path
   is GraphQL-broken until net-new work (the runner's `RunResponse` carries no request body, so the
   GraphQL half of `validateCapturedTraffic` is dead on a synthesized HAR) and has no blanket-redaction
   pass — so it is staged, not dropped (5f: emit per-hop HAR entries in the redirect loop, capture the
   prepared request body as `postData`, extract a `finalizeHar`-style redaction pass).

2. **Attach-body redaction — test-first, widen if it leaks.** `finalizeHar` blanket-redacts only the
   `.har` JSON + text-extension entries; Playwright `content:'attach'` can store a body as a separate
   entry with a non-text filename that passes through untouched. Invariant 5 for **registered** secrets is
   non-negotiable, so a slice adds the test (a registered secret in an attach-mode RESPONSE body must not
   survive the stored artifact); **if it leaks**, widen `finalizeHar` to redact attach entries by their
   HAR-declared `mimeType` (not filename extension), guarded by the browser suite. (The pre-existing
   registered-secret-only posture — unregistered dynamic tokens are never scrubbed — is inherited and is
   exactly why the HAR stays operator-gated.)

3. **`source` provenance — keep `'capture-from-HAR'`** (zero core change). Adding `'capture-from-browser'`
   would be the *only* thing touching `packages/verify/src/`; not worth it for 5e — revisit if operators
   need to distinguish produced-live from consumed-handle in the verdict.

### The load-bearing correction the critics forced (all three, independently)

**`runFlow` SWALLOWS step errors** (`packages/browser/src/flow.ts:293-297`): on a step failure (e.g. an
SSRF-allowlist denial mid-flow) it records `ok:false`, `break`s, and returns `{passed:false}` — it
**never re-throws**. Therefore:
- Branding the browser `GateError` is **inert** for the in-flow case (the error never reaches
  `orchestrate` as a rejection) — kept only as a consistency nicety for the pre-`runFlow`
  `createSession`→`checkNavigation` path that *does* reject.
- An "empty HAR ⇒ no-signal" guard is **insufficient**: a *partially*-denied flow produces a **non-empty**
  HAR, which `validateCapturedTraffic` can validate to a clean **PASS** — "absence rendered as a pass,"
  invariant 3 broken.

**The fix (load-bearing): gate on FLOW COMPLETENESS, not HAR emptiness.** The capture runner inspects the
`FlowResult`: if `flow.passed === false` OR any step `ok:false`, it **throws** (→ `inconclusive`, never
validates the HAR). A flow that did not run to clean completion never produces a validatable HAR. This
guard ships in its own slice with a dedicated red test (a fake flow with one `ok:false` step ⇒
`inconclusive`) — without that test an implementer can land every slice green with the hole intact.

### Egress safety (critic-mandated): one wired runtime, single-source

The egress boundary is **three interlocking mechanisms**, each omissible (each omission a full SSRF
bypass): (1) `createSsrfProxy({allowPrivate})` **started** and threaded into the launch spec as
`proxyServer`; (2) the Chromium hardening launch args (`--proxy-bypass-list=<-loopback>` +
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`) via `engineLaunchOptions`; (3) the
`BrowserGate` allowlist, which only governs egress because `installSafetyRoutes(context, gate)` runs —
and that runs only when the manager has `gate` set. So 5e **extracts a shared
`buildBrowserRuntimeFromEnv()`** from `bin-browser.ts` returning `{manager, gate, proxy, redact}` fully
wired (proxy started, hardening args applied, gate installed); BOTH `bin-browser` and the verify capture
module consume it (single-source, mirroring `depsNetworkConfig`). The proxy is a long-lived listener — the
capture runner `await proxy.stop()` in the **same `finally`** that closes the session, or each single-shot
verify run leaks a listening SSRF proxy.

### Gate model — "both required, no umbrella, no new env"

A verify-driven browser capture **is a browser-pillar run**, so it composes the **full browser operator
gate** (the consume-only capture gate carries zero egress safety — no allowlist, no proxy). The produce
path is wired iff ALL of these operator-set envs hold (all already exist — **no new env**, which would be
the verify-scoped-rename footgun the ADR rejected): `SACKVILLE_VERIFY_ENABLE_RUN` (server may drive runs) ∧
`SACKVILLE_VERIFY_ALLOW_CAPTURE` + artifacts root (the capture sub-gate) ∧ `SACKVILLE_BROWSER_ALLOWED_HOSTS`
(egress scope + the mandatory DNS-pinning SSRF proxy) ∧ `SACKVILLE_BROWSER_HAR_DIR` (the HAR sink) ∧
`SACKVILLE_BROWSER_FLOWS_DIR` (by-name flow source). Deny-by-default REGISTRATION: unmet ⇒ the produce
thunk is not wired ⇒ a requested produce capture surfaces `skipReason:'gate-not-set'` ⇒ `inconclusive`,
never run. **Agent-unsettable:** every safety input (`allowedHosts`, proxy, `allowUnsafe`, `allowPrivate`,
all `SACKVILLE_BROWSER_*`). The agent supplies only the **target**: a `flow` NAME (resolved server-side
against the operator flows dir — no path, no traversal) + non-secret `vars`. A flow name selects *which*
operator-authored flow; the allowlist bounds the HOST (not the path/query — stated explicitly).

### Redaction — one union redactor at both chokepoints; verify-prefix store

- **One union `Redactor`** = `SACKVILLE_VERIFY_SECRET_*` ∪ `SACKVILLE_BROWSER_SECRET_*` ∪ HTTP creds,
  passed to **both** `finalizeHar` (the archive) **and** `validateCapturedTraffic` (the findings) — else a
  browser-registered secret survives in a finding even after the archive scrubbed it. Registering more
  secret *values* only makes redaction more aggressive — it grants no run capability, so this does not
  violate "compose, never widen."
- **Drive → `finalizeHar` (redact) → store → read the STORED artifact → validate.** Never read the raw
  temp `.zip` (`harEntriesToFacts` parses but does not redact).
- **Store under the verify prefix** (`sackville://verify/<runId>/har`, the existing `bin-verify` store) —
  never route through the browser bin's browser-prefixed `onClosed`. The verify run id (injected
  `idFactory`) owns the artifact for auditability; surface the handle + `HarSummary` alongside the
  contract sub-verdict (an unsurfaced HAR handle is unauditable).

### Lazy import — keep the heaviest gate out of everyone else's critical path

`bin-verify` importing `@sackville-mcp/browser`/`playwright-core` does **not** break invariant 1 (the core is
clean), and `bin-verify` already imports the coverage/flake/mutate spawners. But to avoid making *every*
verify deployment (incl. `request_verdict`-only / API-only operators) carry a browser-binary cold-start,
the capture module **`await import('@sackville-mcp/browser')` lazily** — only when the produce branch is
actually wired and invoked.

### TDD slice plan (each `pnpm gate`-green; no real browser in the gate)

1. **Brand the browser `GateError`** with `Symbol.for('sackville.gate-denial')` (consistency with
   coverage/flake/mutate; nicety, not load-bearing). Browser suite stays green.
2. **`ContractCaptureContext` → discriminated union** (`mode:'consume'|'produce'`) in `mcp/verify.ts` +
   handler normalization (bare `harHandle` ⇒ `consume`). Re-run the `orchestrate.test.ts` import-scan to
   prove the core invariant still holds.
3. **Extract `buildBrowserRuntimeFromEnv()`** from `bin-browser.ts` (manager + gate + proxy STARTED +
   hardening args + redactor); `bin-browser` refactored to consume it (its tests are the regression guard).
4. **`driveBrowserFlowToHar` + the FLOW-COMPLETENESS guard** (injected runtime/launch). Red tests:
   resolves a flow by NAME; reads the STORED redacted artifact (handle starts `sackville://verify/`); a
   flow with any `ok:false` step ⇒ **throws** (⇒ inconclusive); empty HAR ⇒ throws; `proxy.stop()` in the
   `finally`. Lazy `@sackville-mcp/browser` import.
5. **Union redactor + the attach-body redaction test** (Fork 2): a registered secret in an attach-mode
   response body must not survive the stored HAR; widen `finalizeHar` by `mimeType` iff it leaks. Assert
   the same union redactor scrubs both a `SACKVILLE_BROWSER_SECRET_*` and an HTTP-creds password.
6. **`bin-verify` produce-branch wiring** behind the full gate (env-matrix tests: any missing env ⇒
   requested produce ⇒ `gate-not-set` ⇒ inconclusive).
7. **`verify_change` MCP input** (`contract:{flow,vars}`) + surface the verify HAR handle + `HarSummary`.
8. **`sackville verify run --flow <name>` CLI** + the milestone tail (STATUS/ROADMAP/memories/CLAUDE.md
   repo-map + this ADR marked done; commit to `main`; push at the boundary).

**Invariant audit (all five survive):** (1) core `.mjs` untouched — all wiring in `packages/mcp`; (2)
compose-never-widen — no new env, both-required, operator-only gate inputs; (3) absence-never-a-pass —
unmet gate ⇒ `gate-not-set`, incomplete flow ⇒ throw ⇒ inconclusive; (4) no real spawn in `pnpm gate` —
injected runtime/launch; (5) redaction before the verdict, inline AND stored — union redactor at both
`finalizeHar` and `validateCapturedTraffic`.

## Addendum 4 (2026-06-04): Milestone 5f — verify-driven LIVE capture from the @sackville-mcp/api RUNNER

**Status: COMPLETE** (2026-06-04) — all 9 slices landed TDD red→green; 1160 TS + 45 Py green, pushed to
`main`. Both ratified forks shipped: `SACKVILLE_API_COLLECTIONS_DIR` (by-NAME, traversal refused) and the
deeper `@sackville-mcp/verdict` `fromCaptureVerdict` fix — which CONFIRMED + closed a latent absence-as-pass
hole in the shipped 5e produce + consume paths (a valid entry rode a sibling no-signal/unresolved entry to
a pass because the contract thunk handed the adapter only `.results`). The critics' two blockers were
folded in test-first: the sequence guard is `step.result.sent` (not the always-undefined `step.sent`), and
the CLI passes a REAL redactor at both chokepoints (not the empty `{}` the browser path can use, since the
synthesized api HAR holds raw bytes until `redactHarZip`). Forged via the `verify-api-capture-5f-design`
fan-out (4 research streams reading the real code → synthesis → 3 adversarial critics, all returning
**sound-with-fixes** → corrected design). The human ratified the two open forks. This addendum is the
durable distillation; the workflow transcript is the research record. Addendum 3 (5e) staged the
API-runner path here.

5f adds a SECOND verify-driven produce source: instead of (5e) spawning a browser to produce the HAR, a
single gated call drives the **`@sackville-mcp/api` runner** for an operator-authored request (by NAME),
SYNTHESIZES a HAR from the run, and validates it against the contract via the SHIPPED
`validateCapturedTraffic` — full **REST + GraphQL** parity. Closes the three correctness gaps Addendum 3
flagged (ratified fork 1): (a) per-hop HAR entries in the redirect loop (no collapsed chains), (b) the
real request body as `request.postData` (so GraphQL drift works), (c) a `finalizeHar`-style blanket
redaction pass extracted to shared code.

### Primitive placement (the user-flagged non-obvious fork — resolved)

Both new primitives live in **`@sackville-mcp/api`** in a new pure leaf module `har-synth.ts`; nothing new
in `@sackville-mcp/verify` (its source is the only thing scanned for invariant 1):
- `redactHarZip(zip: Buffer, redact): Buffer` — the PURE Buffer→Buffer blanket-redaction pass, lifted
  from `@sackville-mcp/browser` `finalizeHar`'s core (unzip → collect text-attach `_file` bodies by DECLARED
  mimeType → redact `.har` JSON + text-extension members + those attach members → re-zip). NO file I/O.
  Imports ONLY `fflate`. Browser's `finalizeHar` keeps its `readFileSync`/`unlink`/`store` wrapper but
  delegates the transform to this — ONE redaction code path (the 5e attach-mimeType fix is inherited).
  New dep edge `@sackville-mcp/browser → @sackville-mcp/api` (acyclic — api deps are only assert/safety today).
- `synthesizeRedactedHarZip(records, redact): Buffer` — builds `{log:{entries:[…]}}` with ONLY the six
  fields the consume bridge reads (`request.method`/`url`, `request.postData.{mimeType,text}`,
  `response.status`, `response.content.{mimeType,text}`), INLINE `text` bodies (no `_file` attach — we
  hold the strings), `zipSync` into one `*.har` member, then immediately runs `redactHarZip` — so NO
  public API ever returns an un-redacted synthesized buffer. THROWS on a record with a non-numeric status
  (`har-capture.ts` coerces a missing status to 0, which would validate as an undocumented-status finding
  instead of the true inconclusive). Omits `postData` for Buffer/FormData (file/multipart) bodies —
  lossless: the response still validates.

### Runner changes (data-retention only — raw bytes never touch `RunResult`)

A SEPARATE out-of-band produce entry point `runRequestForHar`/`runSequenceForHar` returns
`{result, capture:{hops, registeredSecrets, redirectTruncated}}`. `RunResult`/`RunResponse` are
UNCHANGED — the raw-body channel is produce-only, so no existing caller of `runRequest` ever sees a raw
body. In the redirect loop, `res.body.dump()` becomes a size-capped `res.body.text()` (mirror
`MAX_HAR_INFLATED_BYTES`); a hop record is pushed labeled with the CURRENT (already-vetted, already-
fetched) url AFTER the per-hop SSRF + mutation re-checks pass — a blocked target url is never recorded as
sent. `redirectTruncated` is set when the loop exits with the terminal status still a 3xx (budget
exhausted / unparseable / missing Location). `Redactor` gains an `entries()` accessor so the union
redactor can learn the run-resolved `{{secret:NAME}}` values (the api redactor is local + populated by a
`prepareRequest` side-effect, never returned — without this, a resolved secret survives into the stored
`.har` and the findings; the critics' redaction blocker).

### "Absence is never a pass" — the completeness predicate

The 5e analogue (`runFlow` swallows errors ⇒ flow-completeness guard). Here, the produce driver applies
guards, each ⇒ inconclusive, BEFORE trusting the synthesized HAR:
- **Transport completeness (driver THROWS ⇒ inconclusive):** any non-sent step (`result.sent !== true`;
  for sequences the per-step shape is `step.result.sent`, NOT `step.sent` — the critics' blocker: the
  latter is always undefined and would throw on every sequence); `redirectTruncated` (a truncated 3xx
  chain yields a non-empty HAR that could validate — do NOT rely on `isApiEntry`'s JSON heuristic, a 3xx
  WITH a JSON body passes it); `synthesizeRedactedHarZip` throws on a status-less record.
- **Contract completeness (the ratified DEEPER fix):** `validateCapturedTraffic`'s `clean` field
  (`entriesValidated>0 ∧ unresolvedBodies===0 ∧ noSignal===0 ∧ all valid`) is **load-bearing but was
  unreachable** — the contract thunk returned only `.results`, and `fromContractResults` folds on findings
  only. So a capture with one VALID REST entry **plus** an unverifiable GraphQL-no-SDL entry (which
  `continue`s without pushing a `ContractResult`) folded to **pass** — "absence rendered as a pass," a
  CONFIRMED latent hole in the SHIPPED 5e produce path AND the consume path. **Fix (ratified fork 2):
  thread the full `CaptureContractVerdict` through orchestrate's contract thunk (optional `clean`/
  `noSignal`/`unresolvedBodies`/`entriesValidated`, type-only — invariant 1 holds) + a
  `fromCaptureVerdict` mapping in `@sackville-mcp/verdict` that folds `clean===false` (no errors) to
  `inconclusive`, never pass.** Retrofitted into the consume-by-handle + 5e browser-produce thunks too —
  one consistent absence posture across consume + both produce sources.

### Gate composition — "compose, never widen" (ratified fork 1)

A verify-driven api capture IS an api-pillar run, so it composes the api pillar's OWN gate (the same
`SACKVILLE_ALLOW_UNSAFE`/`SACKVILLE_ALLOWED_HOSTS`/`SACKVILLE_BLOCK_PRIVATE` the api server reads → undici
`checkGate` + `assertSsrfAllowed`), under `SACKVILLE_VERIFY_ENABLE_RUN` ∧ the capture sub-gate
(`SACKVILLE_VERIFY_ALLOW_CAPTURE` + artifacts root). A safe GET is ungated (read-only produce works with
just the collections dir + capture gate); a mutating request stays dry-run ⇒ the non-sent guard throws ⇒
inconclusive unless `ALLOW_UNSAFE` + an allowed host — the api server's posture, REUSED, not re-granted.
**RATIFIED NEW ENV `SACKVILLE_API_COLLECTIONS_DIR`** for server-side by-NAME resolution (the api server has
none today — collections are passed per-call; this is the api analogue of `SACKVILLE_BROWSER_FLOWS_DIR`).
The agent supplies ONLY the target (collection + request NAME, never a path — traversal). Deny-by-default
REGISTRATION: unmet ⇒ `gateDenied()` ⇒ `skipReason:'gate-not-set'` ⇒ inconclusive, never fetches.
`ContractCaptureContext` gains a `produce-api` variant; routed by which target the agent supplied
(`request` | `flow` | `harHandle`; exactly one). Provenance stays `'capture-from-HAR'` (zero verify-source
change). `sackville verify run` gains `--request <name>`/`--collection-dir <dir>` (the human IS the
operator), `--allow-unsafe`/`--allow-host`/`--allow-private` straight-through — the CLI thunk MUST build a
real redactor (flag secrets ∪ run-registered) and pass it to BOTH `redactHarZip` and
`validateCapturedTraffic` (NOT the empty `{}` the browser CLI path uses — `finalizeHar` already redacted
on disk there, but the synthesized api HAR holds raw bytes until `redactHarZip` runs; the critics' second
redaction blocker).

### Slice plan (TDD red→green→commit, each independently green-gated)

1. Extract `redactHarZip` + `summarizeHar` into `@sackville-mcp/api` `har-synth.ts` (pure, fflate-only).
2. Browser `finalizeHar` consumes api `redactHarZip` + an import-direction guard test (acyclic; nothing
   spawn-capable in `har-synth.ts`); browser suite green incl. the 5e attach-mimeType case.
3. `synthesizeRedactedHarZip` (pure; redact folded in; inline text; throws on status-less; omits binary
   postData) — round-trip through `harEntriesToFacts`.
4. Runner `runRequestForHar`/`runSequenceForHar` out-of-band channel (per-hop records, wire request body,
   `redirectTruncated`, `Redactor.entries()`); `RunResult` unchanged; existing tests green.
5. Produce driver `runRequestToHar`/`runSequenceToHar` + transport-completeness guards + union-secret
   fold; returns `{harHandle, summary, verdict}` (the FULL `CaptureContractVerdict`).
6. Deeper `@sackville-mcp/verdict` fix — `fromCaptureVerdict` + thread the full verdict through orchestrate's
   contract thunk + retrofit the consume + 5e browser-produce thunks (the ratified cross-pillar fix).
7. `ContractCaptureContext` `produce-api` variant + `verify_change` input wiring (`request`/`collection`/
   `vars`); route by target.
8. `bin-verify` produce-api branch behind the api gate + `SACKVILLE_API_COLLECTIONS_DIR` (env-matrix tests:
   mutating-without-allow-unsafe ⇒ inconclusive; safe GET ⇒ stored union-redacted HAR; secret never in it).
9. `sackville verify run --request` CLI (real redactor at both chokepoints) + the milestone tail (STATUS/
   ROADMAP/memories/CLAUDE.md repo-map + this addendum marked COMPLETE; commit to `main`; push at boundary).

**Invariant audit (all five survive):** (1) `@sackville-mcp/verify` `.mjs` still imports only `node:crypto` +
`@sackville-mcp/verdict` — the verdict-shape threading is type-only, all wiring in `packages/api`/`mcp`/`cli`;
(2) compose-never-widen — the api pillar's own gate, one ratified env for by-name resolution, operator-only
gate inputs; (3) absence-never-a-pass — transport guards throw ⇒ inconclusive, `clean===false` folds to
inconclusive; (4) no real fetch in `pnpm gate` — injected runner; (5) redaction before the verdict, inline
AND stored — the union redactor (api seed ∪ verifySecrets ∪ run-registered) at both `redactHarZip` (store)
and `validateCapturedTraffic` (findings), and synthesis never returns an un-redacted buffer.
