# ADR 0010 — Phase 4: cross-cutting verification, sequencing & shared seams

- **Status:** Accepted
- **Date:** 2026-06-01

## Context

Phases 1–3 (docs, API, browser) are complete/feature-complete. Phase 4 in
`ROADMAP.md` lists five cross-cutting verification candidates with an explicit
"sequence TBD by leverage": an **LSP bridge**, a **coverage-aware impact-scoped
test runner**, **mutation testing**, **flaky-test detection & quarantine**, and
**dependency/version intelligence**.

Per CLAUDE.md (brainstorm-before-building, fan-out), the sequence was decided by a
design/research workflow: five parallel research streams (one per candidate) →
synthesis/ranking → **three adversarial critics** (leverage-skeptic, effort-and-
determinism, architecture-fit) → corrected synthesis. The adversarial pass
materially changed the answer and caught several concrete errors (recorded below),
so it is captured here rather than trusted as-proposed.

## Decision

### Sequence (by leverage-per-effort, with Strummer's agent-first mission)

Two independent tracks, then the test-quality chain, then LSP last:

1. **`@strummer/deps` — dependency/version intelligence** *(track B, built first)*
2. **`@strummer/coverage` — uncovered-new-line + impact-scoped runner** *(track A)*
3. **`@strummer/flake` — flaky-test detection & quarantine**
4. **`@strummer/mutate` — mutation testing** *(gated on a Stryker/Vitest-4 compat spike first)*
5. **`@strummer/lsp` — semantic code navigation** *(last)*

Rationale for the head of the list: **deps** has the cleanest architectural fit of
the five — its core is fully offline-deterministic via an operator-provisioned
on-disk OSV advisory snapshot (a true file-as-data boundary, the most
Strummer-idiomatic shape), it has no test-runner-reentrancy hazard, and it extends
already-shipped trusted assets (`detectInstalledVersion`/`resolveVersion` in
`@strummer/core`). It answers upgrade/EOL/CVE — a question **nothing** in the repo
already covers and which agents get wrong unprompted ("upgrade to latest"), with no
TDD habit protecting them. **coverage** is the parallel opener for the test-quality
track; its *leverage was downgraded* (under our TDD prime directive the agent
already wrote the line and its test, so generic "what's uncovered" partly
duplicates the gate the agent runs — the real novel win is the narrow
**uncovered-NEW-line / forgotten-assertion** catch). **LSP is last**: highest *raw*
leverage but the **only** candidate that violates ARCHITECTURE §1's no-live-RPC
polyglot rule outright (a live, stateful, version-coupled subprocess JSON-RPC peer).

### Cross-cutting decisions (apply to every Phase-4 pillar)

- **Shared `@strummer/artifacts`.** Today's `ArtifactStore` lives **inside**
  `@strummer/browser` and hardcodes the `strummer://browser/run/<id>/<kind>` prefix
  — it cannot be reused as-is. Before the first handle-emitting Phase-4 slice, we
  **extract** it into a new shared package with a **parameterized prefix** (browser
  keeps emitting its existing handles; coverage/deps emit `strummer://coverage/...`
  / `strummer://deps/...`). The cost is paid **once** rather than duplicated
  per pillar; the refactor touches the browser pillar's green gate and is done under
  TDD (behavior-preserving, mirroring the `@strummer/safety` / `@strummer/assert`
  extractions).
- **Explicit version pins — no transitive imports.** `istanbul-lib-coverage`,
  `fflate`, etc. appear in the lockfile **only as transitive deps** of other
  packages. Importing a transitive dep violates CLAUDE.md's "version-pinned, not
  latest". Each new package adds its own **explicit pinned** dependency (e.g.
  `istanbul-lib-coverage` pinned to whatever `@vitest/coverage-v8@4.1.7` resolves),
  accepting the resulting version-coupling consciously.
- **Paired, deny-by-default operator gate.** The house pattern is an
  allowlist + boolean **pair** read solely in the bin, with the allowlist
  load-bearing even when the boolean is set (api: `allowedHosts` + `allowUnsafe`;
  browser: upload/quarantine dir + `ALLOW_*`). Any Phase-4 surface that **runs
  code** (coverage `runScoped`, flake quarantine **writes**, mutation runs) uses the
  same shape — e.g. `STRUMMER_COVERAGE_PROJECT_ROOTS` (primary allowlist) +
  `STRUMMER_COVERAGE_ALLOW_RUN` (secondary boolean) + a wall-clock cap. Read-only
  analysis (diff parse, pure differs/summarizers) is free, like a GET. Safety is
  **operator-set, never an agent input** — no tool can self-authorize.
- **TS/Vitest first; Python staged, not amputated.** Each pillar has a clean
  TS/Vitest core and a heavier Python second half (pytest / coverage.py / mutmut /
  cosmic-ray, pip/PyPI advisory data). v1 ships the TS pillar; the Python adapter is
  scheduled in `ROADMAP.md`. The SQLite polyglot boundary is untouched — these are
  TS-side tools.
- **No out-of-gate tier.** This repo has none: the established posture is
  `describe.skipIf(!dependencyPresent)` (e.g. `engine.integration.test.ts`), which
  **runs under `pnpm gate`** whenever the dependency is present (CI installs it). So
  any live-seam integration test (coverage `runScoped`, a real language server, a
  real Stryker run) must be argued deterministic on its own merits against a tiny
  hermetic fixture — it is not quarantined from the gate.

### Per-candidate corrections the adversarial pass forced

- **Coverage slice-1 correctness trap:** istanbul derives line coverage from
  `statementMap`, so an added line with **no statement** (blank line, brace) is in
  *neither* the covered nor the uncovered set. A naive first slice goes green on a
  cherry-picked fixture while leaving the real semantics unmade. The coverage first
  slice must encode an explicit **`nonExecutable`** third state + a guard assertion.
- **The "shared RunnerAdapter seam" was an illusion:** coverage's best path is
  in-process/child-process Vitest; flake **spawns** `vitest run --reporter=json` and
  parses; mutation delegates spawning to Stryker. Three different execution models —
  building coverage first does **not** seed reusable spawn infra for the others, so
  flake/mutation are sequenced on their own merits, not as "coverage dependents".
- **Vitest-in-Vitest:** the repo has a single root `vitest.config.ts` (no
  `test.projects`), so coverage's live `runScoped` cannot use the in-process
  `startVitest` API from inside the outer Vitest worker (reentrancy hazard) — it
  needs a **child-process** boundary against a hermetic fixture sub-project.
- **Stryker/Vitest-4 blocker:** Stryker's `vitest-runner` advertises Vitest v1–3;
  we are pinned to 4.1.x. Mutation's "thin wrap" effort estimate is unreliable until
  a **compat spike** resolves it; if it fails, the command-runner fallback makes
  mutation a subprocess output-scraper (effort L→XL). The spike runs before slot 4
  is committed.
- **Wrong API reference:** the deps research cited `assertSsrfAllowed` from
  `@strummer/safety`, which **does not exist** — the real symbols are
  `resolveAndPin` / `isBlockedHost` / `classifyAddress` / `SsrfError`. All
  deps/changelog egress routes through `resolveAndPin` + an operator allowlist.
- **flake owns a second SQLite database** (a private run-history table via
  `better-sqlite3`), **outside** the `schema/strummer.schema.sql` "only `core`
  touches SQLite" docs-pillar invariant. Allowed, but noted here explicitly: it is a
  new, private store, not a crossing of the polyglot contract.

## Consequences

- Phase 4 opens with `@strummer/deps` (slice 1: a pure, offline `auditDeprecation`
  reducer over a committed npm-packument fixture), with `@strummer/coverage` as the
  parallel track. The shared `@strummer/artifacts` extraction lands with the first
  handle-emitting slice.
- Relates to ADR 0004/0005 (api), ADR 0006–0009 (browser). The research +
  adversarial transcript is the workflow `phase4-design-research`; this ADR is its
  durable distillation.

## Update — 2026-06-01: Stryker/Vitest-4 compat spike RESOLVED (mutation unblocked)

The mutation-testing slot was gated on a spike (above): Stryker's `vitest-runner`
historically advertised Vitest v1–3, while Strummer is pinned to Vitest 4.1.x. The spike
is **resolved positively** — current `@stryker-mutator/vitest-runner` (9.x, e.g. 9.6.1)
declares `peerDependencies: { vitest: ">=2.0.0", "@stryker-mutator/core": "<matching>" }`
and the maintainers shipped explicit **Vitest 4 (and 4.1)** support, including a fix for
the v4.1 vitest-runner mutant hitcount/coverage. So the **thin-wrap path is viable** and
the command-runner output-scraper fallback is **not** needed (mutation effort stays L, not
L→XL).

Two design consequences this firms up:

- **Stryker is NOT a gate dependency / not pinned into `@strummer/mutate`.** A real
  mutation run mutates the source and re-runs the whole suite per mutant — slow and
  inherently non-deterministic, so it fails the "no out-of-gate tier" determinism bar.
  Mirroring flake/coverage, the live run is an **injected runner** (default spawns the
  operator's locally-installed `stryker run` as a subprocess, like coverage/flake spawn
  `vitest`) behind the paired `allowRun`+`allowedRoots` gate; the engine is unit-tested
  with a fake runner — no real Stryker spawn in `pnpm gate`.
- **The pure core is the first slice and is Stryker-version-independent.**
  `summarizeMutation` reads the stable **mutation-testing-elements report schema**
  (`schemaVersion`, `files[path].mutants[].status`) that Stryker emits as
  `mutation-report.json`, so it carries no `@stryker-mutator/*` import at all.

## Addendum — 2026-06-04: the Python (+Ruby) half of the verification pillars

Forged via the `polyglot-python-half-design` fan-out (5 research streams → synthesis;
the human ratified four forks). The Phase-4 pillars shipped TS-first with the Python
half staged. This addendum records how that half lands. **It introduces no new
architectural boundary** — see the verdict below.

### Boundary verdict: spawn-and-parse, not a §1 boundary and not the LSP fence

`coverage/src/run.ts`, `flake/src/runner.ts`, and `mutate/src/run.ts` each already
`execFile` a foreign-ecosystem tool (vitest / stryker) through an **injected runner
seam** (`TestRunner`/`MutationRunner`) behind the paired `allowRun`+`allowedRoots`+
timeout gate, read its report **once**, and feed a **pure adapter**. Spawning
`pytest` / `coverage.py` / `mutmut` / `cosmic-ray` is byte-for-byte the same pattern
with a different `argv0`. ARCHITECTURE §1's no-live-RPC rule governs only the
docs-indexing Python→SQLite→TS boundary; the LSP live subprocess is the single fenced
exception (ADR 0011) precisely *because* it is long-lived RPC. One-shot spawn-and-parse
is neither. **The Python verification runners are the established spawn-and-parse
pattern — no new boundary.** One genuinely new *result-shape* note: the Python mutation
tools emit to **stdout** (`mutmut results`, `cosmic-ray dump`), not to a disk report
file like Stryker, so `RunMutationResult.reportPath` becomes optional and the runner
gains a stdout-fed parse branch. That is a shape note, not a boundary.

The Python *pure adapters* already landed and are green (`flake/src/pytest.ts`
`parsePytestJson`, `mutate/src/mutmut.ts` `parseMutmutResults`, `coverage/src/coveragepy.ts`
`coveragePyToIstanbul`), with committed fixtures. What remains is the gated spawn
runners + pure deps diff-scoping.

### Ratified forks

1. **Primary Python mutation tool = cosmic-ray, authoritative; keep mutmut.** cosmic-ray
   `dump` gives structured per-mutant records with a real `module_path` / `start_pos.line` /
   `operator_name` / `test_outcome` enum → survivors carry actionable file:line:operator
   matching the MTE Survivor shape and the verdict. mutmut 3.x has no JSON (dropped
   junitxml); its text results carry no path/line. mutmut stays the lightweight option;
   the operator picks via `--tool`.
2. **Coverage impact-scoping fallback = BOTH modes, operator-visible, default = report-gap.**
   When a changed source file maps to no confident test (pytest has no `vitest related`),
   the operator chooses *widen-to-full-suite* (safest) vs *report the gap as unverified*
   (honest, fast, matches the no-signal posture); the default is report-gap. **testmon is
   staged behind an explicit opt-in flag, never the default** — a stale/cold `.testmondata`
   silently deselects tests → false clean, violating absence-is-never-a-pass, and the runner
   can't verify the DB's freshness from outside.
3. **Ruby = deps lockfile-diff only this arc.** Ruby mutation (`mutant` is commercial/
   license-gated with a weak machine-readable story; `mutest` may be the safer OSS target)
   + coverage (SimpleCov) are STAGED as a next slice reusing the injected-runner seam, gated
   on a licensing investigation first.
4. **pytest report format = pytest-json-report now; stage `pytest-reportlog`.** The committed
   `parsePytestJson` + fixture already consume pytest-json-report's `.report.json`, so the
   pytest flake slice is purely the gated spawn loop. The pytest-dev-official `reportlog`
   (JSONL, no third-party dep, but 3 `TestReport` lines/test → needs an aggregating parser
   taking the first non-passed phase) is staged, not amputated.

### Invariants held (the Python-specific traps)

- **absence-is-never-a-pass:** a cosmic-ray session with pending/null `WorkResult`s, or
  `pytest` exit 5 (no tests collected), maps to **inconclusive/unverified, never `passed`**
  (a transport-completeness guard mirroring the capture/HAR paths + a pytest-specific
  exit-code map: 5=no-tests, 2=usage, 4=internal — plain `exitCode===0` is insufficient).
- **ambiguity ⇒ unverified-skip:** `parseCosmicRayDump` sends any unrecognized outcome and
  any null `WorkResult` to `Pending` (neutral, excluded from valid), never coerces to
  Survived/Killed. deps diff-walking under-scopes (never invents a dep); a PEP 751
  `pylock.toml` entry with an omitted version folds to no-signal downstream.
- **one-history-per-nodeid (flake):** repeats are produced by re-running the whole suite N
  times from the TS loop (stable nodeid), **not** `pytest-repeat` (its `[i-N]` nodeid suffix
  fragments history).
- **no real spawn/fetch in `pnpm gate`:** every new runner is reached only through the
  injected seam used by the bin; unit tests pass a fake runner returning committed fixtures.
  `pytest-json-report`/`coverage.py`/`mutmut`/`cosmic-ray` are `uv` dev-deps used **once** to
  capture fixtures (out-of-gate, provenance in `test/fixtures/README.md` per the LSP
  convention), never gate dependencies.
- **redaction-before-verdict:** cosmic-ray's generated TOML config + `session.sqlite` path and
  pytest report paths can leak absolute filesystem paths; keep config/session under a temp dir
  and redact before the verdict, same posture as the existing runners.

### Slice sequence (pure/zero-spawn first)

1. **deps diff-scoping (PyPI + RubyGems)** — pure, no spawn/network/new fixture; flips the
   `changed.ts` non-npm short-circuit + the staged `changed.test.ts` placeholder.
2. **deps changelog derivation (PyPI + RubyGems)** — pure + injected fetcher; repo URL from
   registry metadata, reuse `sliceChangelog` with the ecosystem comparator.
3. **mutate `parseCosmicRayDump`** (pure) — needs a real cosmic-ray dump fixture (out-of-gate).
4. **flake `runAndRecordPytest`** (gated runner) — parser already green.
5. **mutate Python mutation runner** (cosmic-ray primary + mutmut) — depends on slice 3.
6. **coverage `runScopedPython`** (pytest + coverage.py) — needs a coverage.json fixture
   (out-of-gate).
