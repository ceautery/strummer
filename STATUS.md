# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the top block current after every milestone.

## Current phase

**LEVEL-2 ONBOARDING TUTORIAL — DONE (2026-06-06; gate green 1647 TS + 47 Py; commit pending push).** A second, **multi-file** runnable tutorial at `examples/tutorial/scheduler/` (`roomctl`, a meeting-room scheduler) that makes Sackville's *semantic* tools earn their keep where the 64-line todo tutorial couldn't (its own README concedes grep/read are adequate there). Design = ADR 0020 **addendum**. THE BUG: `overlaps()` (in `src/interval.ts`, called from `schedule.ts`×2 + `availability.ts`) uses `<` where it needs `<=`, so half-open intervals that merely **touch** (one ends as the next begins) are wrongly flagged as overlapping → back-to-back bookings rejected. The shipped suite passes (tests clear-overlap + clear-disjoint, never the boundary) AND the buggy line **executes**, so **coverage reads fully-covered** — the deliberate contrast with the todo tutorial (whose bug was an *uncovered* branch). Headline catch = **mutation testing**: a surviving `<`↔`<=` Stryker mutant proves the suite never pinned the boundary. Tool arc: `search_docs` (touching≠overlap, version-pinned) → `lsp_find_definition`/`_references` (3 call sites across files = blast radius, no grep noise) → `mutate_run` (surviving mutant) → `verify_change` (one verdict). CLI pass + Claude-Code/MCP pass mirror each other. Two honesty guards added: TS `test/tutorial-scheduler.test.ts` (pins the bug: `overlaps` touching→true, `book` rejects back-to-back; + docset/README sync) and pytest `py/sackville_ingest/tests/test_tutorial_scheduler.py` (ingests the bundled `scheduler-core` docset offline, FTS `overlap` finds the semantics page). Sample ships outside the pnpm workspace + root Vitest scope (its 9-test suite stays green WITH the bug; never reddens the gate) but is Biome-clean. Stryker is a sample dev-dep (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner` + bundled `stryker.config.json`); `mutate run` supplies `--reporters json --mutate src/interval.ts` itself. CLI/LSP facts verified against source: LSP positions are 1-based (`lsp definition typescript src/schedule.ts 24 64`; `lsp references typescript src/interval.ts 23 17`); toolsets `docs,lsp,mutate,verify` valid; `verify_change`→mutate needs `SACKVILLE_VERIFY_ENABLE_RUN=1` + `SACKVILLE_MUTATE_ALLOW_RUN=1`. As with the todo coverage step, the Stryker RUN is not executed in `pnpm gate` (only the guards are). See ADR 0020 addendum + [[sackville-onboarding-docs]]. NEXT: pick a new direction with the human (the staged web/API/browser tutorial variant; the operator branch-protection item below; or a deferred technical tail).

**`0.0.1-alpha.3` PUBLISHED — DONE (2026-06-06; gate green 1622 TS + 46 Py; pushed).** A bug-fix alpha cut after the first real **macOS host** runthrough of the tutorial surfaced setup footguns. Fix commit `8e4e516`; release via the standard pipeline (changeset `6dda0a3` → "Version Packages (alpha)" PR #2 → squash-merge `1cef8f5` → `release.yml` OIDC publish, SLSA provenance). **`latest` + `alpha` both repointed alpha.2→alpha.3 on all 18** (incl. the user-owned unscoped `sackville-mcp`; pre mode never auto-moves `latest`, so this was a manual `npm dist-tag` pass as `ceautery`). The shipped fix is in **`@sackville-mcp/coverage`**: `run-scoped` failed opaquely from a *global* `sackville-cli` because it spawned a bare `vitest` (not on PATH) — now `runnerEnv` prepends `<project>/node_modules/.bin` and the missing-report error surfaces the runner exit code + output tail. Docs/skill/ROADMAP also hardened (loud Node-LTS/uv prereqs in the tutorial, the DevDocs `index.json`/`db.json` format appendix, a "lead with the tool" skill section, a staged coverage `--git` flag). See [[sackville-tutorial-runthrough-fixes]]. NEXT: pick a new direction with the human (staged web/API/browser tutorial variant; the operator branch-protection item below; or a bigger multi-file tutorial that makes Sackville earn its keep).

**DOCUMENTATION SPIKE — DONE (2026-06-06; gate green 1619 TS + 46 Py; pushed).** Three onboarding deliverables, no production-code change. (1) **README.md ground-up rewrite** — a clean guided tour (what's in the box, install/run from npm, drive the MCP from Claude Code via `claude mcp add` + a committable `.mcp.json`, CLI quickstart, composability, the deny-by-default safety model, and a toolchain *why* table) replacing the run-on development narrative, which already lives here + in the 20 ADRs. (2) **`.claude/skills/sackville/SKILL.md`** — a Claude Code skill steering the agent to Sackville's own tools (semantic LSP over grep/find, version-pinned `search_docs`, `verify_change`); ships on clone (`.gitignore` narrowed to `.claude/*` + `!.claude/skills/`). (3) **Onboarding TUTORIAL (ADR 0020)** at `examples/tutorial/todo/` — a runnable, resettable pure-TS TODO-core CLI with ONE intentional logic bug in `filter('active')` that the passing test suite hides; the tutorial walks find→fix→verify twice (sackville-cli `search`/`coverage run-scoped`/`verify run`, then Claude Code via `search_docs`/`lsp_*`/`verify_change`), with a bundled OFFLINE DevDocs docset for `todo-core` (`--embedder fake`) + `reset.sh`. **Key pattern:** the sample ships broken but lives OUTSIDE the pnpm workspace + root Vitest `include`, so it never reddens the gate; Biome still lints it (style-clean, logic-only bug). Two guards keep it honest — a TS guard (`test/tutorial-todo.test.ts`, main suite) pins the intentional bug + docset/README sync, and a pytest guard (`py/sackville_ingest/tests/test_tutorial_todo.py`) actually ingests the docset offline and asserts FTS searchability. Finding-during-build: the default `sackville-cli` bin wires a `QueryEmbedder`, so `search` attempts a one-time model download and falls back to FTS offline — the README says so. Decisions ratified with the human: CLI-TODO (not full-stack), bundled offline docset, drop the README narrative. Commits: README+skill `2617d8b`, tutorial `687aa67`. See [[sackville-onboarding-docs]] + ADR 0020. NEXT: pick a new direction with the human (e.g. the staged web/API/browser tutorial variant, or the operator branch-protection item below).

**SLICE 13 VERIFIED END-TO-END — the automated OIDC release pipeline is LIVE (2026-06-06).** `0.0.1-alpha.2` was published for ALL 18 packages via the full Changesets flow (changeset → "Version Packages" PR #1 → merge → `release.yml` publish), **token-free over OIDC with SLSA provenance attached** — which confirms trusted publishing is configured correctly on every one of the 18 packages (the answer to "did I get them all?" = YES). The canary (PR #1) earned its keep by catching + fixing two pipeline bugs before any real release: (a) `release.yml` pinned Node **`22.14.0`**, too old for tsdown to load its config natively → it fell back to the uninstalled `unrun` loader → EVERY build failed; fixed to **`node-version: 22`** (latest 22.x, still ≥ the §18 OIDC floor; the `.ts`→`.mjs` tsdown-config rename was a red herring, kept as harmless). (b) the changesets action couldn't open the PR until the operator enabled repo **Settings → Actions → "Allow GitHub Actions to create and approve pull requests."** dist-tags now `{alpha: 0.0.1-alpha.2, latest: 0.0.1-alpha.2}` for all 18 (`latest` was MANUALLY repointed alpha.1→alpha.2; pre mode publishes only to `alpha` and never moves `latest`, so a future alpha release needs a manual repoint or `pre exit` to stable — the unscoped `sackville-mcp` needed an npm access-setting change before its `latest` would repoint, since the org-scoped token couldn't write a user-owned package). Pre-mode bookkeeping: a consumed changeset `.md` LINGERS on disk but `pre.json.changesets` records it, so `changeset status` shows nothing pending (no spurious next PR) — it clears on `pre exit`. **STILL OPERATOR-PENDING (non-blocking):** branch protection on `main` with required checks = `gate` + `package-checks` (enforces "green gate before publish"; `release.yml` only builds). See [[sackville-alpha-publish]].

**PACKAGING-CI slices 2 + 10 — DONE (ADR 0019, 2026-06-05; gate green 1601 TS + 45 Py).** Build-then-assert packaging checks, kept OUTSIDE `pnpm gate` (they need a real build + packed tarballs): `scripts/package-checks.sh` builds → packs all 18 → runs **`attw --profile esm-only`** (ESM-only by design, ADR §17 — node10/CJS resolutions ignored) + **`publint`** on each tarball, then **`scripts/assert-lazy-boundary.mjs`** proves the aggregate `bin.mjs` STATIC startup closure imports ZERO native/heavy specifiers (playwright/sqlite/onnx/transformers + the heavy optional-peer pkgs — they live only in `await import()` chunks; non-vacuous: asserts they're present SOMEWHERE in dist). New CI job **`package-checks`** (no browsers/Python) + `pnpm package-checks`. attw/publint caught + fixed a REAL defect: the shipped tarball's legacy top-level `types` pointed at unshipped `./src` — added `publishConfig.types: ./dist/index.d.mts` to all 18 (gate-locked by a new per-package assertion in `test/packaging.test.ts`). **Slice 13 (now VERIFIED — see the top block)** (Changesets FIXED/lockstep `.changeset/config.json` [`fixed: [["sackville-mcp","@sackville-mcp/*"]]`, access public, baseBranch main] + `.github/workflows/release.yml` + `scripts/release.sh` + `pnpm changeset`/`pnpm release` scripts). The release flow: push to main → changesets/action opens/updates a "Version Packages" PR (NO publish); merging that PR → `pnpm release` publishes via **pnpm** (rewrites `workspace:*`) with a **prerelease-aware dist-tag** (pre mode → that tag, else `latest` — avoids the alpha.0 `latest` trap) + `changeset tag`. OIDC: workflow pins Node 22.14.0 + npm 11.5.1, `id-token: write`, no token, provenance auto (NOT `publishConfig.provenance`, §18). **OPERATOR SETUP REQUIRED before the first CI publish (UNVERIFIABLE here):** (1) enable **trusted publishing** per-package on npmjs.com for repo `ceautery/sackville` + workflow `release.yml`; (2) enable **branch protection** on `main` with required checks = the CI `gate` + `package-checks` jobs (this is how §18 "green gate first" is enforced — release.yml only builds, not gates); (3) confirm pnpm 11.4 does OIDC, else add an `NPM_TOKEN` secret + uncomment `NODE_AUTH_TOKEN`; (4) for the next ALPHA: `pnpm changeset pre enter alpha` → add a changeset → merge the Version PR. See ADR 0019 §slices 2/10/13 + [[sackville-alpha-publish]].

**ALPHA NPM PUBLISH — DONE (2026-06-05). All 18 packages are live on npm at `0.0.1-alpha.1`, dist-tag `alpha`, `latest` → alpha.1, under scope `@sackville-mcp` + unscoped aggregate `sackville-mcp` (`npx -y sackville-mcp`). Gate green 1583 TS + 45 Py. Verified end-to-end: real `npx -y sackville-mcp@alpha` prints `sackville-mcp: enabled [api, deps, verify]; disabled [docs]`.**

**SCOPE CORRECTION (load-bearing): the `@sackville` scope is NOT ours — it is owned by the npm user `~sackville`.** The rename milestone's "`@sackville` scope verified-available" claim was WRONG: a package-name registry 404 does NOT prove the scope is free (an npm username silently reserves `@username`). So the published scope is **`@sackville-mcp`** (the org the operator owns) and the bare aggregate is the unscoped **`sackville-mcp`**. The fix was a literal `@sackville/` → `@sackville-mcp/` swap across 147 files + a surgical bare `sackville` → `sackville-mcp` rename (package `name`/`.mcp.json`/README only); **`SACKVILLE_*` env, `sackville://` URIs, `sackville_ingest` (Python), and the GitHub repo `ceautery/sackville` are UNCHANGED.** NOTE: that `@sackville/` sed also rewrote historical mentions in the docs below (incl. the rename narrative in the next paragraph) to `@sackville-mcp/` — read those as the corrected scope; THIS block is authoritative on naming.

**alpha.0 was BROKEN, superseded + deprecated.** The first publish (alpha.0) failed its smoke test two ways, both fixed in alpha.1 (TDD red→green): (1) **npx entrypoint dead** — all 10 mcp bins guarded server-start with `import.meta.url === pathToFileURL(process.argv[1]).href`, FALSE under symlink/npx invocation (Node realpaths `import.meta.url` but not `argv[1]`); replaced with a realpath-resolving `isMainModule()` (`packages/mcp/src/is-main.ts`; symlink regression test). (2) **default pillars collapsed to [api]** — `packages/mcp/src/deps.ts` statically value-imported the OPTIONAL peer `@sackville-mcp/core`, so the dynamically-imported deps chunk threw `ERR_MODULE_NOT_FOUND` on a native-free install, taking deps+verify down with it; `core` is now a guarded lazy `await import()` (graceful degrade to "version not detected"). Added a packaging guard test: no default-pillar wiring (api/deps/verify/aggregate) statically value-imports an optional peer. Validated pre-publish via a faithful native-free install (file: tarballs, optional peers absent) through the `.bin` symlink. `latest` repointed alpha.0→alpha.1 on all 18; alpha.0 `npm deprecate`d ("use 0.0.1-alpha.1 or later"). **2FA wall:** publishing required a GRANULAR token with "Bypass 2FA" enabled — a web-login session AND a no-bypass granular token both 403'd. NEXT: the OIDC publish-CI tail (ADR 0019 slices 2/10/13) stays deferred; alpha consumers add `@sackville-mcp/browser`/`core`/`embed`/`flake` to enable those pillars.**

**PROJECT RENAMED: Strummer → SACKVILLE (2026-06-05) — see ADR 0001. The bare `strummer` npm name was taken by a dormant validation lib (`tabdigital`, 2019) + offshoots; `sackville` (LOTR Sackville-Baggins) has the bare name AND the `@sackville` scope verified-available (registry 404, no offshoots). NAMING SHAPE: the BARE `sackville` npm package IS the aggregate MCP server (`.mcp.json` = `npx -y sackville`; bin `sackville` + alias `sackville-mcp` + per-pillar `sackville-<pillar>-mcp`); the lib graph + CLI are `@sackville-mcp/*` (`@sackville-mcp/cli` bin = `sackville-cli`, distinct to avoid colliding with the server's bare `sackville` bin). Env prefix `SACKVILLE_*`; URI scheme `sackville://`; Python pkg `sackville_ingest` (`py/sackville_ingest`); schema `schema/sackville.schema.{sql,json}`; sidecars `*.sackville.yml`. EXECUTED as ONE gate-verified pass: 3 case-preserving content subs across 251 files + file/dir `git mv`s + the `golden.sqlite` fixture REGENERATED via `uv run sackville-ingest build-fixture` (the table name `sackville_meta` lived inside the binary — a text replace can't reach it; this was the only non-text spot, caught by the gate). Gate green 1571 TS + 45 Py; bare `sackville` bin smoke-verified on the built artifact (`enabled [api,deps,verify]; disabled [docs]`). PUSHED to **`github.com/ceautery/sackville`** (repo renamed; the existing token worked — a repo rename keeps creds). FOLLOW-UPS done after the rename commit: (a) `snapshot.ts` + `lsp/manager.ts` each used a raw-NUL delimiter in a Map key, which made git classify them BINARY → my `git grep -lI` rename pass (the `-I` flag skips binary) silently missed `snapshot.ts` (had 3 stale strummer refs) and would hide future grep tooling; both NUL delimiters swapped to `\x1f` (unit separator, equally collision-proof, keeps the files plain text) + the 3 refs fixed (commits 66f8229, 3e65237); (b) rebuilt the gitignored `data/react.sqlite` (old `strummer_meta` schema → new `sackville_meta`; React 19.2, 1279 fragments, fastembed; verified via a live CLI search returning `sackville://doc/...`). Only residual `strummer` = the intentional rename-doc in this file + ADR 0001. HEAD 3e65237, gate green 1571 TS + 45 Py.

**ALPHA NPM PUBLISH — DONE (see the authoritative top block; published `0.0.1-alpha.1` under `@sackville-mcp`/`sackville-mcp`). The historical plan follows.** A token-based MANUAL first-publish (the full OIDC-CI path = ADR 0019 slices 2/10/13 stays deferred for automation later). OPERATOR PREREQS at the start of the publish session: an npm account with a publish **automation token** (`NPM_TOKEN` / `npm login`), AND the **`sackville` npm org created** (required for the `@sackville-mcp/*` scope; the bare `sackville` mcp package publishes too) — re-verify `sackville` bare + `@sackville` scope still free (were, 2026-06-05). STEPS: (1) confirm gate green + clean tree; (2) version-bump all 18 PUBLISHABLE packages 0.0.0 → `0.0.1-alpha.0` FIXED/lockstep (root stays private/unversioned) — can hand-bump or wire `@changesets/cli` (fixed mode) if preferred; (3) `pnpm -r build` (topological); (4) DRY-RUN `pnpm -r publish --tag alpha --no-git-checks --dry-run` and eyeball that `workspace:*` deps rewrite to `0.0.1-alpha.0` + `access:public` (already in each `publishConfig`); (5) real publish `pnpm -r publish --tag alpha --no-git-checks` (pnpm publishes in dependency order + rewrites `workspace:*`); (6) verify `npm view sackville@alpha` + smoke `npx -y sackville@alpha` in a scratch dir (should print `sackville-mcp: enabled [api,deps,verify]; disabled [docs]`); (7) commit the version bump + push + tag `v0.0.1-alpha.0`. PUBLISHING IS OUTWARD-FACING + HARD TO UNDO (npm 72h unpublish window) — get explicit go before the REAL publish (step 5); the dry-run is safe. The heavy-engine OPTIONAL-PEER split means a bare `npm i sackville` is native-free; document that alpha consumers add `@sackville-mcp/browser`/`core`/`embed`/`flake` to enable those pillars. — — — NOW: Phase 6 — PACKAGING & DISTRIBUTION (ADR 0019, Accepted) — AGGREGATE + SPLIT + ONBOARDING COMPLETE; only the publish-CI tail remains (gated on operator npm/OIDC setup) (2026-06-05; gate green 1571 TS + 45 Py; renamed-from HEAD 87c0fe5). DONE since the aggregate milestone: slice 12 (package-graph SPLIT — heavy engines `@sackville-mcp/browser`/`core`/`embed`/`flake` + `playwright-core` moved from `sackville` deps → OPTIONAL peerDependencies [kept as devDeps for workspace resolution]; `bin-verify.ts`'s `@sackville-mcp/flake` import made LAZY (inside the flake run thunk) so the api+deps+verify default loads without flake installed; verify.ts's flake/browser imports were already type-only; publishability sweep — removed `private`, added `repository{url,directory}` case-exact + `publishConfig.access:public` across all 18 packages [root stays private]; guards: install-isolation + per-package publishability + verify-no-static-optional-peer-import; verified: build OK + aggregate default = enabled[api,deps,verify]); slice 14 (onboarding — aggregate-first `packages/mcp/README.md` rewrite + `examples/mcp/.mcp.json` [npx sackville, operator gate envs only] + guard that the documented npx command maps to a REAL bin [the npx trap]). Commits: 3ec77d7 (slice 12), 87c0fe5 (slice 14). NEXT ACTION (publish-CI tail — REQUIRES network installs of dev tooling + the operator's npm/GitHub-org setup; NOTHING publishes without explicit operator go): slice 2 = add `@arethetypeswrong/cli` (attw) + `publint` as dev tooling, run `attw --pack` + `publint` on a packed leaf TARBALL (build-then-assert CI, not gate); slice 10 = assert the aggregate's emitted `.mjs` keeps playwright/sqlite/onnx/transformers in await-import chunks ONLY (build-then-assert CI); slice 13 = `@changesets/cli` FIXED/lockstep config + `.github/workflows/release.yml` (topo `pnpm -r build` → `changeset publish` via pnpm; OIDC trusted publishing: cloud runner, `id-token:write`, Node≥22.14.0/npm≥11.5.1, NO token) + a `changeset publish --dry` check — BUT OIDC trusted-publishing must be configured on npmjs.com per-package by the operator (chicken-and-egg: the @sackville-mcp/* packages don't exist on npm until the first publish), so this slice needs the operator. STAGED REFINEMENT (minor, deferred): a browser-bin PREFLIGHT diagnostic — catch playwright's "executable doesn't exist" at launch and print a clear "run `npx playwright install chromium`" message (ADR 0019 §14; browser-pillar runtime path). See ADR 0019 slice plan + ROADMAP Phase 6. — — — PRIOR: Python MUTATION diff-scoping (cosmic-ray + mutmut) — COMPLETE (ADR 0010 addendum 2, 2026-06-05; gate green 1456 TS + 45 Py; HEAD fe30584, pushed). The full arc landed AND was verified end-to-end against the real cosmic-ray 8.4.6 + mutmut 3.5.0 (provisioned via `uv` in this container; NOT in the dev container). The Python mutation runners now honor `mutateFiles` like TS `runMutation`'s `--mutate`. (1) SLICE 0 capture (commit 15920b9): the load-bearing finding — mutmut 3.5.0 has NO `only_mutate`/`source_paths` (the ratified Fork B was doc-derived & WRONG); real keys are `paths_to_mutate` (scope) + `do_not_mutate` (fnmatch-glob exclusion), confirmed by reading the installed `Config`/`load_config`. cosmic-ray `module-path` accepts a FILE LIST (Fork A holds; A2 not needed); `excluded-modules` subtracts via exact path AND fnmatch glob (blocker #3 real); mutmut can't distinguish seen-but-empty from never-seen (Fork B2 ⇒ conservative reconcile). Fixtures `cosmic-ray-scoped-dump.jsonl` + `mutmut-scoped-results.txt` + README provenance + the Fork B correction in ADR 0010 §"Slice 0 RESULTS". (2) EMITTERS (commit d23c86e, `config.ts`, 15 tests, `smol-toml` ^1.6.1 added): `synthesizeScopedCosmicRayConfig` (override `module-path` to selected list, strip any inherited `excluded-modules` entry that fnmatch-matches a selected file); `planMutmutScope`+`synthesizeScopedMutmutPyproject` (`paths_to_mutate`=selected; `also_copy`=rest of the tree so unscoped tests still import; strip a colliding `do_not_mutate`). Python-fnmatch matcher (star crosses `/`). Verified by driving the real tools with the emitters' actual output. (3) RUNNER WIRING — `runCosmicRay` (commit 25b7b65, 7 tests): scoped config written into projectRoot so its RELATIVE module-path resolves (cosmic-ray then reports relative module_path keys, matched directly by `reconcileScope`); cleaned up in `finally`. `runMutmut` (commit bb85f8f, 14 tests): runs in a FRESH SANDBOX copy (excludes node_modules/.git/.venv/mutants/etc.) with the scoped pyproject; baseline-smoke is FREE (broken baseline → mutmut "not checked" → Pending → `assertComplete` inconclusive); new `reconcileMutmutScope` (mutmut summary is MODULE-keyed not path + emits NO record for a 0-mutant scoped file, so CONSERVATIVE — a selected file with no matching mutated module ⇒ inconclusive; suffix match tolerates src layouts; ZERO false-passes) + `pyPathToModule`. Four end-states (a noop ran:false; b total-zero/pending→assertComplete; c partial under-scope→reconcile throws; d clean→scopedFiles=mutatedFiles). Additive `RunMutationResult` fields (`scopeEmpty`/`unmatched`/`requestedFiles`) + optional `RunMutationInput.ownedRoots`; MCP/CLI unchanged. (4) VERIFY SELECTOR (Fork D, commit accd284): `SACKVILLE_MUTATE_TOOL`(stryker|cosmic-ray|mutmut, default stryker) + `SACKVILLE_MUTATE_CONFIG_PATH` (bin-verify); `--mutate-tool`/`--mutate-config` (verify CLI, unknown ⇒ exit 2); routes `changedFiles → mutateFiles`. E2E (real tools, out-of-gate): runCosmicRay scoped calc+strutil → 22 killed + 11 survived (66.7%), reconcile passed; runMutmut scoped calc → 2 killed; a truly-0-mutant `nomut.py` → correctly inconclusive. NO real spawn in `pnpm gate` (pure synthesis + injected runner / real-temp-project + fake runner). Invariants held: under-scoping (total OR partial) never silent-passes; absence-never-a-pass; compose-never-widen; operator gate untouched. RESUME / NEXT: arc DONE + committed to `main` (push at this milestone). Pick the next direction with the human — a NEW phase (packaging/distribution: publish `@sackville-mcp/*`, unified aggregate MCP server / single CLI; or an end-to-end "verify a PR" recipe / GitHub Action) or a staged tail (cosmic-ray `cr-filter-git` line-precise mode; mutmut `mutants/` cache reuse; Stryker PARTIAL-scope reconciliation; flake diff-scoping; src-layout precision for `reconcileMutmutScope`; ecosystem-aware changelog heading regex; Ruby coverage/mutation [license first]; pytest-reportlog parser; LSP recursive/dir delete + toolchain matrix). Re-run the real-tool checks next session via `uv venv` + `uv pip install 'cosmic-ray==8.4.6' 'mutmut==3.5.0' pytest`. See ADR 0010 addendum 2 + ROADMAP. — — — PRIOR (slice-0-gated snapshot — SUPERSEDED, the arc above is DONE): Closes the diff-scoping asymmetry: TS `runMutation` scopes via `--mutate`, but the Python runners (`runCosmicRay` PRIMARY / `runMutmut`) DROP `mutateFiles` (`scopedFiles: []`). pytest+coverage.py scoping already shipped (`runScopedPython`); this is the MUTATION half. Design = a research→synthesis→2-critic fan-out (Critic 1 needs-rework → 5 blockers folded; Critic 2 ship-with-fixes); forks A/A2/B/B2/C/D/E/F ratified. THE LOAD-BEARING CATCH: `assertComplete` (run.ts:188) only throws on TOTAL-zero mutants, so PARTIAL under-scope (synthesis selects 3 changed files, the tool mutates 1, those are killed, score reads clean, 2 changed files silently never mutated) is a latent absence-as-a-pass. SHIPPED THIS SESSION (pure, fixture-tested, no real tool in the gate; `packages/mutate/src/scope.ts`, 14 tests, commit 39e353f): (1) `selectMutationScope(mutateFiles, ownedRoots, exists)` → `{files, unmatched}` — mirrors `selectPytestScope` incl. the injected existence predicate; `.py`-only + in-tree + existing → `files`, out-of-tree/deleted/typo → `unmatched` (report-gap, never silently scoped); (2) `reconcileScope(selected, MutationSummary)` → `{mutatedFiles, missing}` — the post-spawn guard: a selected file ABSENT from `summary.files` was never mutated (the partial-scope sentinel → the staged runner throws → inconclusive); seen-but-empty (0 mutants) is benign. Both exported from the mutate index. ZERO-MUTANT RESOLUTION (4 states): (a) legit-empty-scope → early-return-noop, don't spawn; (b) total-empty/failed → `assertComplete` throws; (c) partial under-scope → `reconcileScope` throws; (d) clean → `scopedFiles = mutatedFiles` (what was genuinely mutated, not requested). STAGED — SLICE-0-GATED (the tools — cosmic-ray 8.4.6 / mutmut 3.5.0 — are ABSENT from the dev container; emitters MUST be pinned to captured behavior, NOT doc guesses; capture out-of-gate in the reference env per the addendum-1/LSP convention): slice 0 (capture `module-path` file-list shape [Fork A2], mutmut config keys [Fork F], `only_mutate` form, seen-vs-unseen [Fork B2]); the config emitters (`synthesizeScopedCosmicRayConfig` override `module-path` + reconcile inherited exclusions via `smol-toml`; `planMutmutScope`/`renderMutmutConfig` fresh-sandbox-cwd + baseline-smoke); the `runCosmicRay`/`runMutmut` wiring (honor `mutateFiles`: pre-spawn noop on empty, whole-project on `undefined`/`no-scope`, post-spawn `reconcileScope`; additive `RunMutationResult` fields); MCP/CLI need NO change (already forward `mutateFiles`); the verify selector (Fork D: `SACKVILLE_MUTATE_TOOL` + `SACKVILLE_MUTATE_CONFIG_PATH` in bin-verify, `--mutate-tool`/`--mutate-config` in the verify CLI). Stryker-under-verify total-zero path verified already-safe (`mutationScore===null` → `no-signal` → inconclusive via `fromMutationSummary`/`composeVerdict`); Stryker PARTIAL-scope reconciliation staged. Resume (AGREED PLAN): read ADR 0010 addendum 2 + ROADMAP "Python MUTATION diff-scoping"; **PROVISION cosmic-ray 8.4.6 + mutmut 3.5.0 (+ pytest) via `uv` in this container**, then do SLICE 0 (capture the `module-path` file-list shape [A2], mutmut config keys [F], `only_mutate` form, seen-vs-unseen [B2]), commit those fixtures, THEN build the emitters→`runCosmicRay`/`runMutmut` wiring→verify selector against the captures. The pure safety core (`selectMutationScope`/`reconcileScope`) already shipped; do NOT write the emitters from doc-derived guesses. Commits: docs a5b9e81 + safety core 39e353f. — — — PRIOR ARC: GraphQL directive-arg validation + custom-scalar variable coercers — COMPLETE (ADR 0018, 2026-06-05; gate green 1410 TS + 45 Py; all 7 implementation slices + docs landed TDD red→green; 3 critic blockers folded in pre-build; 5 forks human-ratified). A staged-tail arc deepening the GraphQL contract pillar (ADR 0015 follow-on). The decisive finding reshaped scope: graphql-js `validate()` (KnownDirectives/KnownArgumentNamesOnDirectives/ProvidedRequiredArgumentsOnDirectives/ValuesOfCorrectType) + the usage-agnostic `getVariableValues` loop ALREADY cover directive args + the VALUES of variables feeding them (exactly once, even when a variable also feeds a field arg) — so Feature A (directive args) is mostly a regression-LOCK (slice 1, tests-only). Cardinal rule held: anything `validate()` covers is SKIP-by-us (no double-report). TWO genuine new pieces: (D2) a custom-scalar directive-arg LITERAL folds to `unverified` (identity `parseLiteral`, never patched — may carry an inline secret; `visitWithTypeInfo` pass CONFINED to a `DirectiveNode` parent, skips `Variable` nodes, reuses the transitive `typeInvolvesCustomScalar`; field-arg literals UNCHANGED, S1 staged; COERCER-INDEPENDENT, BLOCKER-2) surfaced on the capture bridge under the distinct `graphql-directive-unverified` key (§8.4, additive `directiveUnverified?` flag); and (Feature B) operator-supplied custom-scalar variable COERCERS — `patchRegisteredScalars` overwrites `parseValue` ONLY (NEVER `parseLiteral`, the BLOCKER-1 redaction-leak guard), built-in names silently ignored (§8.5), `typeInvolvesCustomScalar` gains a `registered` set (registered scalar checkable; unregistered or input-object-with-any-unregistered-field stays `unverified`); fresh-per-call schema makes in-place patching safe. Coercers OPERATOR-SET (§8.1): MCP `validate_response.enableScalarCoercers: string[]` selects by NAME against an operator-bound registry; CLI `api validate/run --graphql --coercers <file.js>` loads an operator module (fail-LOUD non-zero on a bad module — never a silent no-coercer pass). Invariants held: ambiguity⇒unverified-skip, absence-never-a-pass (new unverified rides the existing bridge noSignal fold), redaction (findings RECONSTRUCTED from name+type, coercer throw consumed as a BOOLEAN; `validate_response` has NO verifyRedact backstop so value-free reconstruction is the SOLE guard — tested end-to-end through MCP), compose-never-widen (zero new `ContractFindingKind`, one additive `scalarCoercers?` opt + `directiveUnverified?` field), no real spawn/fetch in `pnpm gate`. STAGED: S1 custom-scalar FIELD-arg literals; S2 bridge coercers; S3 inline-literal coercion (NOT partially built — `parseLiteral` never patched); S4 fragment-only/cross-op vars; S5 indeterminate-coercer sentinel; S6 schema-cache × patch. Commits: docs ADR 0018 (6124b3d) + slices 1–7 (46fa5f2/00e5440/75a51fb/159d2d1/e414736/5d82ad1). Next: pick the next direction with the human — a NEW phase (packaging/distribution; an end-to-end "verify a PR" recipe/Action) or another staged tail (cosmic-ray/mutmut/pytest diff-scoping; ecosystem-aware changelog heading regex; Ruby coverage/mutation [license check first]; pytest-reportlog parser; LSP recursive/dir delete + toolchain matrix). See ADR 0018 + ROADMAP Phase 2.**

---

**PRIOR: Polyglot push (Python half) — COMPLETE (ADR 0010 addendum, 2026-06-04; gate was green 1382 TS + 45 Py). All 6 slices landed; 4 forks ratified by the human (cosmic-ray primary, keep mutmut; coverage scoping fallback = both modes operator-visible, default report-gap, testmon opt-in only; Ruby = deps lockfile-diff only this arc; pytest = json-report now, stage reportlog). No new architectural boundary — one-shot Python spawn-and-parse is the established vitest/stryker injected-runner pattern (ADR 0010 addendum), not the §1 docs-SQLite boundary nor the LSP fence. The Python verification half is now language-symmetric with the TS half: deps diff-scoping + changelog for PyPI/RubyGems, pytest flake runner, cosmic-ray/mutmut mutation runners, and pytest+coverage.py run-scoping — all gated, injected-runner, no real spawn/fetch in `pnpm gate`. Next: pick a NEW direction, or a remaining staged tail (GraphQL directive-arg validation + custom-scalar coercers; cosmic-ray/mutmut + pytest diff-scoping; the ecosystem-aware changelog heading regex; Ruby coverage/mutation [SimpleCov/mutant — license investigation first]; pytest-reportlog parser; LSP recursive/dir delete + toolchain matrix). SLICE 6: coverage `runScopedPython` (pytest+coverage.py) — mirrors `runScoped` (shared `assertAllowed`); `selectPytestScope` (changed test = selector; source → mirrored test via injected `testExists`); ratified no-test fallback report-gap(default)/widen, operator-visible, testmon OUT; pytest exit 5/2/3/4 → inconclusive (never a clean report); MCP `py_run_scoped` + CLI `coverage run-scoped --python`; coverage.py 7.14.1 coverage.json fixture out-of-gate. SLICES 1–5 also landed. SLICE 5: mutate Python mutation runner — `runMutmut` (`mutmut run`→`mutmut results` stdout→`parseMutmutResults`) + `runCosmicRay` (operator-config `init`→`exec`→`dump` over a throwaway session, dump stdout→`parseCosmicRayDump`) as siblings of `runMutation`, sharing the gate + `MutationRunner` seam. STDOUT-fed ⇒ `RunMutationResult.reportPath` optional + `tool` field. Transport-completeness guard `assertComplete` (zero mutants OR any Pending ⇒ throw inconclusive, never a clean pass). MCP `mutate_run`/CLI `mutate run` gain `tool: stryker|mutmut|cosmic-ray` (+ cosmic-ray `configPath`). Injected runner ⇒ no real spawn. Staged: cosmic-ray/mutmut diff-scoping. SLICE 4: flake `runAndRecordPytest` (gated runner) — refactored `runAndRecord` onto a framework-agnostic core (`FrameworkAdapter`); vitest behavior-preserving; pytest spawns `pytest --json-report` + ingests via the existing `parsePytestJson`; repeats re-run the whole suite (NOT pytest-repeat — nodeid fragmentation). MCP `flake_run` + CLI `flake run` gain `framework: vitest|pytest` (agent-supplied tool choice; the allowRun+allowlist gate still governs whether to spawn). Injected runner ⇒ no real spawn in the gate. SLICE 3: mutate `parseCosmicRayDump` (pure) — `cosmic-ray dump` JSON-lines → MTE `MutationReport`, keyed by the real `module_path` with real line+operator (actionable survivors). Each line is `[work_item, work_result|null]`; mutation fields nest under `work_item.mutations[]` (corrected vs the draft, against a real 8.4.6 capture). Mapping folds ambiguity/null → Pending (never a phantom survivor); no_test→NoCoverage, incompetent/exception/abnormal→RuntimeError, skipped→Ignored. summarizeMutation unchanged. Real dump fixture captured out-of-gate (provenance in mutate/test/fixtures/README.md). SLICE 2: deps `changelog_diff` for PyPI + RubyGems — extracted pure repo-derivation into `@sackville-mcp/deps` `repo.ts` (`githubOwnerRepo`/`npmRepoUrl`/`pypiRepoUrl`/`gemRepoUrl`/`CHANGELOG_FILENAMES`, shared by MCP bin + CLI); `sliceChangelog` now takes an injected `comparator` (default semver) so PyPI/Gem versions order via `comparatorFor(ecosystem)`; both fetchers resolve the source repo per ecosystem (npm packument; PyPI `info.project_urls`; RubyGems a separate `/gems/<name>.json` — packument stays on the versions array for freshness). Staged: the ecosystem-aware heading-token regex (SEMVER_TOKEN still detects only X.Y.Z headings). SLICE 1: deps `changedDependencies` for PyPI + RubyGems — generalized the npm block-aware walker into per-file *classifiers* selected by basename, unioning names. PyPI: pyproject.toml (PEP 621 arrays w/ `]`-outside-quotes close detection + Poetry tables, python skipped), requirements*.txt, TOML `[[package]]` lockfiles (uv/poetry/pylock; name-from-context named-block), PEP 503-normalized so manifest+lockfile dedupe. RubyGems: Gemfile + Gemfile.lock 4-space concrete-version spec rows (operator/transitive rows excluded). Under-scope-safe. The `sackville verify run --deps` CLI already threads the ecosystem; MCP bin-verify deps audit stays npm-only (separate fetcher wiring). Next action: the polyglot-push arc is DONE and pushed. Pick the next direction with the human — a NEW phase (e.g. packaging/distribution: publish `@sackville-mcp/*`, a unified aggregate MCP server / single CLI; or an end-to-end "verify a PR" agent recipe / GitHub Action) or a remaining staged tail (see the staged list in the NOW block + ROADMAP). Hold the load-bearing invariants. See ROADMAP "Python (+Ruby) second half" + ADR 0010 addendum.**

---

**Phase 5 — Cross-pillar verification: 5a–5f COMPLETE. Most recent: ARTIFACT RETENTION / GC LANDED (ADR 0017) — the shared `@sackville-mcp/artifacts` store was append-only (a long-running server grew its dir without bound); it now has an opt-in `RetentionPolicy` (`maxAgeMs`/`maxEntries`/`maxBytes`) applied by a disk-based `sweep()` scoped to the store's own prefix subtree, triggered opportunistically + throttled on `put()` (injected clock), wired into every long-running server bin (browser/deps/lsp/verify) via `SACKVILLE_<PILLAR>_ARTIFACT_MAX_*` env; no policy ⇒ no GC (backward-compatible); gate green (1330 TS + 45 Py). Before that: the ADR 0016 STAGED PAIR resolved (HAR-capture form bodies validated non-authoritatively + per-property `encoding` permanently-out — the ADR 0016 tail list is EMPTY), non-JSON request BODY validation v1 (addendum 4), non-scalar param OBJECT/array matrix (slices 4–8), GraphQL-request variable validation (ADR 0015), live `api run --openapi` REQUEST validation (ADR 0014), `@sackville-mcp/severity` extraction. Next: pivot to a new phase, or a remaining tail (the Python second half; `changedDependencies`/`changelog_diff` for PyPI/Gem; a mutate cosmic-ray/`runMutmut` adapter; LSP recursive/dir delete + toolchain matrix).**
_**ARTIFACT RETENTION / GC (ADR 0017) — COMPLETE** (2026-06-04, all TDD red→green; gate green at 1330 TS +
45 Py; human ratified both forks: opportunistic-on-put-throttled + exposed `sweep()`, and wire all
long-running server bins). Closes a real operational gap: the disk-backed `@sackville-mcp/artifacts` store was
append-only, so a long-running MCP server grew its artifact dir (browser traces/video/HAR, deps/lsp/verify
detail) without bound. **Slice 1 — engine:** an opt-in `RetentionPolicy {maxAgeMs?, maxEntries?, maxBytes?}`
applied by a DISK-based `sweep(now?)` (cold-process-safe — the in-process Map is empty after a restart),
**scoped to the store's OWN `<baseDir>/<prefix>` subtree** (a pillar never GCs a foreign pillar's
artifacts; the cross-pillar verify store reads foreign prefixes but never evicts them); eviction unit = the
`<id>` dir (a run's whole set), order age→count→size oldest-first by mtime (a just-written run is evicted
LAST), realpath-confinement-checked before every `rmSync` (never deletes THROUGH a symlink escaping
baseDir), evicted handles dropped from the Map. Trigger: a THROTTLED opportunistic sweep on `put()` (≤ once
per `sweepIntervalMs`, injected `now` default `Date.now`; mirrors the browser idle reaper) + a public
`sweep()` for an explicit startup pass. **No policy ⇒ no GC ⇒ byte-identical to today** (existing stores /
tests / CLI temp-dir stores untouched). Constructor gains an optional `ArtifactStoreOptions {retention?,
now?, sweepIntervalMs?}`. **Slice 2 — wiring:** the browser `ArtifactStore` subclass forwards opts; shared
`retentionFromEnv()` (ignores non-numeric/negative so a typo never silently wipes everything) +
`DEFAULT_SWEEP_INTERVAL_MS` (60s) exported; `bin-browser`/`bin-deps`/`bin-lsp`/`bin-verify` parse
`SACKVILLE_<PILLAR>_ARTIFACT_MAX_AGE_MS`/`_MAX_ENTRIES`/`_MAX_BYTES`. Design = ADR 0017. 10 tests (7 engine +
helper + 2 browser-subclass). Invariants held: opt-in / no surprise deletion, ownership (own-prefix only),
realpath confinement, no real sleeping in `pnpm gate` (injected clock). STAGED: a global cross-prefix cap;
LRU-by-access / refcounting (eviction is by write-age, not last-read)._
_**ADR 0016 STAGED PAIR resolved (form bodies over the capture bridge + `encoding` permanently-out) —
COMPLETE** (2026-06-04, all TDD red→green; gate green at 1320 TS + 45 Py; human ratified: ship the
capture path, keep `encoding` permanently-out). **(A) HAR-capture form bodies — DONE:**
`harEntriesToFacts` resolves a `form`-style request `postData` into the same
`RequestFacts.form`/`formFileFields` channel — PREFER structured `postData.params[]` (each
`{name,value?,fileName?}`, URL-decoded by the capturer; a `fileName` ⇒ FILE part, names-only), with an
`urlencoded`-ONLY `postData.text` fallback (well-defined percent-decoding); a `multipart` body with no
`params[]` (only raw `_file`/`text`) is NOT parsed (boundary parse = embedded-delimiter trap) so it
stays `unverified`. The bridge REST branch drives `validateOpenApiRequest` NON-authoritatively: an
absent required field ⇒ `unverified` → `noSignal` (never a false `missing-*`); a PRESENT invalid value ⇒
a TRUE `request-body-schema` finding (authority-independent, like the param path), redacted through the
existing operator-`Redactor` chokepoint. No surface change (`validate_capture` MCP/CLI auto-resolve it);
no new finding kind. New seams `formBaseOf`/`formFieldsFromPostData`/`appendFormField`; `HarContent.params`
+ `CaptureEntry.req.form`/`formFileFields`. 11 tests. **(B) per-property `encoding` — PERMANENTLY OUT
(not staged):** any `encoding` block `unverified`-skips the body (re-introduces the full param style/
explode ambiguity matrix inside the body — mostly the irreducible embedded-delimiter class — for a rare
feature). Invariants held: ambiguity ⇒ `unverified`-skip never a false finding, absence-never-a-pass
(non-authoritative absent-required folds to `noSignal`), redaction-before-verdict (raw field value only,
operator chokepoint), no real fetch in `pnpm gate` (inline `zipSync` HAR fixtures). **The ADR 0016 tail
list is now genuinely EMPTY.**_
_**NON-JSON request BODY schema validation (ADR 0016 addendum 4) — COMPLETE** (2026-06-04, all TDD
red→green; gate green at 1311 TS + 45 Py; design = a 2-stream research fan-out — OpenAPI form/multipart
serialization + the `encoding` object, and an adversarial false-positive-trap sweep; the human ratified
the scope: urlencoded + multipart text fields over the LIVE run + direct MCP/CLI). Converts the prior
presence-only `unverified` skip for `application/x-www-form-urlencoded` + `multipart/form-data` bodies into
real `request-body-schema` findings. **The key insight:** form bodies arrive as a flat field→value(s) map
via DISCRETE keys, so even STRING array items are sound (no delimiter to over-split) — `validateFormBody`
mirrors `validateObjectParam`'s coerce-declared-scalar-props-then-ajv logic plus scalar-item arrays.
**Representation (load-bearing, both research streams flagged it):** a NEW authoritative
`RequestFacts.form` (`Record<string,string|string[]>`, repeated keys → array) + `formFileFields` (multipart
FILE part NAMES only — bytes NEVER inlined), populated at PREPARE time by the runner from the structured
parts (post-secret-fill wire values, secrets registered with the redactor), NEVER by re-parsing the
serialized string (lossy/impossible for multipart). **REFUSE → `unverified` (never a false finding):** any
per-property `encoding`; non-UTF-8 charset; non-flat-object schema; typed `additionalProperties`; nested/
typeless/array-of-object props; fractional `multipleOf`; a scalar prop arriving with repeated keys; a
single-occurrence array + cardinality constraint; an ambiguous empty value (non-string/non-null scalar); a
declared prop satisfied by a multipart FILE part. **Slices:** (1+2) the validator core —
`RequestFacts.form`/`formFileFields`, `validateFormBody`, `selectContentSchema` now surfaces matched media
base + `encoding`, `hasBody` counts `req.form`, the body-block routing (19 tests); (3) the runner —
`PreparedBody.formFields`/`formFileFields`, `materializeBody`(urlencoded) + `materializeMultipart`(text +
file names) populate them, `buildRequestFacts` copies into `RequestFacts` so live `api run --openapi`
reaches it via `runRequestForContract`, `RunResult` UNCHANGED (2 tests); (4) surfaces — MCP
`validate_request` `form`/`formFileFields` inputs, CLI `api validate-request --form`/`--form-file`, a live
form-urlencoded run test (3 tests). Signature + `RequestValidationResult` shape + finding kinds UNCHANGED
(reuse `request-body-schema`); zero new `ContractFindingKind`. Invariants held: ambiguity ⇒
`unverified`-skip never a false finding, absence-never-a-pass (every refusal sets `unverified`, folded to
`noSignal` by the bridge), redaction-before-verdict (findings echo only the raw field value; run-resolved
secrets pre-registered), no real fetch in `pnpm gate` (pure validator + the existing in-process live-run
test). **This closes the LAST ADR 0016 tail.** STAGED: HAR-capture form bodies (`postData.params[]`,
non-authoritative); per-property `encoding` overrides._
_**NON-SCALAR PARAM — OBJECT reconstruction + multipleOf guard (slice 8) — COMPLETE** (2026-06-04, all TDD
red→green; gate green at 1287 TS + 45 Py; design = ADR 0016 addendum 3, a 2-critic adversarial fan-out
over a drafted design [both ship-with-fixes; every blocker folded in]; the comprehensive-multipleOf-scope
fork human-ratified). Lands the last param ARRAY+OBJECT matrix cell. **CHECKed (query only):** `deepObject`
(`?color[R]=100&color[G]=200` — collect `^name\[prop\]$` discrete keys, so STRING props are sound, no
split; coerce declared scalar props via the normalized per-prop type, ajv the assembled object) and
`form`/`explode=false` (`?color=R,100,G,200` — split on `,`, pair, coerce, ajv; INTEGER/BOOLEAN props
ONLY + `additionalProperties:false`, because a string value's comma cascades and a number mis-coerces).
**Refuse → `unverified`:** no flat scalar `properties`; an object-form `additionalProperties` (only literal
true/false/absent proceed — a typed one would false-fail an undeclared key, critic FP-5); a deepObject
nested (`a[b]`) or repeated (`string[]`) key; a form/explode=false odd/empty split or non-(int|bool) prop.
**Cross-cutting fix (the critics' real find):** a fractional `multipleOf` is an IEEE-754 false-positive
trap (`validateSchema({type:number,multipleOf:0.1},0.3)` ⇒ valid:false — empirically confirmed), PRE-EXISTING
in the shipped scalar (slice 2) + array (slices 4–7) number paths; `hasFractionalMultipleOf` now folds any
such number-typed scalar to `unverified` UNIFORMLY at scalar/array-item/object-prop coercion (integer
multipleOf divides exactly, stays validated; the response-body ajv path is left as a separate concern).
**Undoc refinement:** three-way EXPLICIT-explode metadata branch (query object explode defaults to true) —
deepObject → exclude `name[...]` keys; form/`explode===false` → declare its single `name`; else → suppress
the whole pass; all pre-validation so a REFUSED object still declares its name (no undoc FP, critic H2/H3).
Seams: `objectSerializationSupported` (object half of `styleSupported`), `validateObjectParam`,
`hasFractionalMultipleOf`, `escapeRegExp`. Signature + `RequestValidationResult` shape + finding kinds
UNCHANGED; `form/explode=true` objects stay permanently out (shared namespace). Slice-5 deepObject tests
updated (now validate). 19 tests added. **Only remaining ADR 0016 tail: non-JSON request BODY schemas.**_
_**NON-SCALAR PARAM — PATH label/matrix arrays (slice 7) — COMPLETE** (2026-06-04, all TDD red→green; gate
green at 1268 TS + 45 Py; design = ADR 0016 addendum 2). Un-stages the remaining path array styles via
`splitArrayValue` (strip the RFC 6570 prefix, split per explode): `label` `{.ids}`→`.a,b,c` /
`{.ids*}`→`.a.b.c`, `matrix` `{;ids}`→`;ids=a,b,c` / `{;ids*}`→`;ids=a;ids=b`. Same non-string-scalar
soundness gate, ONE new wrinkle: label-EXPLODE joins with `.` — the one delimiter that occurs inside a
JSON `number` (decimal) — so `number` items are excluded there (integer/boolean only), flagged by
`arraySplitUsesDot`; every other delimiter (`,`/`;`/`=`/` `/`|`) admits all non-string scalars. A
malformed prefix (segment not starting with `.` / `;name=`) ⇒ `splitArrayValue` returns undefined ⇒
`unverified`, never a false fail. Seams: `arrayDelimiter`→`queryArrayDelimiter` + location-aware
`arraySerializationSupported` (the array half of `styleSupported`), `splitArrayValue`, `arraySplitUsesDot`,
`itemTypesSplittable(types, usesDot)`. Signature + `RequestValidationResult` shape + finding kinds
UNCHANGED. Invariants held (ambiguity ⇒ unverified-skip; absence-never-a-pass; redaction; no real fetch
in gate). The non-scalar param ARRAY matrix is COMPLETE except object reconstruction. 9 tests added (one
obsolete slice-6 `label`-staged test removed)._
_**NON-SCALAR PARAM — DELIMITED ARRAYS (slice 6) — COMPLETE** (2026-06-04, all TDD red→green; gate green
at 1260 TS + 45 Py; design = ADR 0016 addendum 1 — no new fan-out, the v1 critics already mapped this
matrix). Un-stages the delimited (single-string) array serializations behind the soundness rule the v1
adversarial pass established. **CHECKed:** query `form`/`explode=false` (split `,`), `spaceDelimited`
(` `), `pipeDelimited` (`|`); path `simple` (`,`); header `simple` (`,`, each segment trimmed) — **only
when every item type is a NON-STRING scalar** (integer/number/boolean). The delimiter provably cannot
occur inside such an element, so the split is EXACT — element coercion AND cardinality (minItems/maxItems/
uniqueItems) are sound; a single delimiter-free value is a 1-element array. **Still `unverified`:**
delimited arrays with STRING/typeless items (embedded delimiter over-splits → would false-fail a per-item/
cardinality constraint — the irreducible class, critics FP-2/FP-5/FP1) and any empty segment (trailing/
internal delimiter). The v1 `explode=true` query-form paths (≥2 occ = the array; single-occ wrap;
`array-values` discrete-no-split admits string items) are UNCHANGED. New internal seams: `arrayDelimiter`
(location/style→delimiter, now also the array half of `styleSupported`), `itemTypesSplittable` (the
non-string-scalar gate); `validateQueryArray`→`validateArrayParam` (location-agnostic). Signature +
`RequestValidationResult` shape + finding kinds UNCHANGED; reaches the capture bridge + live `api run
--openapi` with no surface change. Invariants held: ambiguity/unsupported ⇒ `unverified`-skip never a
false finding, absence-never-a-pass, redaction (raw element echoed only), no real fetch in `pnpm gate`.
**STAGED next:** path `label`/`matrix` arrays; object reconstruction (`form/explode:false` + `deepObject`
flat scalar props); non-JSON body schemas. 12 tests added._
_**NON-SCALAR request-PARAM serialization v1 — COMPLETE** (2026-06-04, all TDD red→green; gate green at
1248 TS + 45 Py; design = ADR 0016, a fan-out: 3 research streams → synthesis (CHECK-vs-SKIP decision
matrix + slice plan) → 2 adversarial critics [both ship-with-fixes, converging on the same tightening,
every blocker folded in]; the one scope fork human-ratified). The contract pillar now validates the
soundly-reversible non-scalar parameter cells, converting prior `unverified`-skips into real findings.
**Shipped CHECK set (exactly):** query `form` ARRAYS, `explode=true`. ≥2 wire occurrences = the array
(coerce each element via `coerceScalar` to the item scalar type, assemble, ajv the whole array — count
is known so minItems/maxItems/uniqueItems are all sound). Single occurrence wrapped to `[v]` ONLY when
it carries no `,` AND the schema has no cardinality constraint (else `unverified` — a single occurrence
can't disambiguate a 1-element array from an explode=false disagreement, nor prove a cardinality bound:
critics FP-1/FP-3). Non-scalar items / `prefixItems` tuples / typeless → `unverified`. **Mandatory
undocumented-param suppression (lands now even though object VALIDATION stays staged):** a form/explode
OBJECT query param shares the top-level namespace irreducibly (critic FP-4) ⇒ suppress the ENTIRE
undoc-param pass + `unverified`; a `deepObject` param's `name[...]` bracket keys are excluded (plain
undeclared keys still flag); an unresolved non-local `$ref` param ⇒ suppress (could be an object,
critic H1). **Wiring fix (the blocker both critics independently caught):** a SCALAR param that receives
a repeated key now folds to `unverified` via an explicit new `array-values` `ParamLookup` state — never
a fall-through into `coerceScalar` on an absent `.value`. **Engine-only:** new internal seams
(`nonScalarType`, `hasCardinalityConstraint`, `validateQueryArray`, the `array-values` state;
`styleSupported` takes the normalized schema, `normSchema` computed once per param); `validateOpenApiRequest`
signature + `RequestValidationResult` shape UNCHANGED; ZERO new `ContractFindingKind` (reuse param-schema/
missing-required-param/undocumented-param). Reaches the capture bridge + live `api run --openapi` with NO
surface change. Invariants held: ambiguity/unsupported ⇒ `unverified`-skip never a false finding (the
cardinal sin), absence-never-a-pass (every skip → noSignal fold), redaction (findings echo the RAW
element only), no real fetch in `pnpm gate`. **STAGED (parseable, deferred — ADR 0016):** query
`form/explode:false` comma-arrays (DROPPED from v1: embedded-delimiter false-positive class), space/pipe-
Delimited arrays, path/header arrays (simple/label/matrix), object reconstruction (form/explode:false +
deepObject flat scalar props); plus non-JSON body schemas. 20 tests added (14 slice-4 + 6 slice-5)._
_**GRAPHQL-REQUEST VARIABLE VALIDATION — COMPLETE** (2026-06-04, all TDD red→green; gate green at 1228 TS +
45 Py; design = ADR 0015, a design fan-out — 3 research streams → synthesis → 1 adversarial critic [found 4
holes, all folded in]; both forks human-ratified). The contract-pillar deepening: `validateGraphqlOperation`
now validates the runtime `variables` payload against the chosen operation's declared types — the GraphQL
analogue of ADR 0014's OpenAPI request validation. **Fork 1 (ratified):** EXTEND `validateGraphqlOperation`
(not a `validateGraphqlRequest` sibling) — it already spans request (query-vs-SDL drift) AND response
(`errors[]`) and reuses the same built schema + parsed document + chosen operation node; returns a
`GraphqlValidationResult extends ContractResult { unverified? }` (additive subtype, NEVER widening
`ContractResult`). Variable validation runs iff `opts.variables !== undefined` (existing query-only callers
behavior-preserved). **The redaction-safety mechanism:** graphql-js `getVariableValues` error messages ECHO
raw input values, so we iterate `variableDefinitions` ONE AT A TIME (`getVariableValues(schema, [varDef],
vars)`) → each error is structurally attributable → findings RECONSTRUCTED from variable name + printed type
+ category (`graphql-variable-missing`/`-invalid`, `graphql-undocumented-variable` warning), never from
graphql-js messages. **Authority:** `variablesAuthoritative` (direct surfaces true; capture omits) — absent
required (non-null, no-default; default-aware) is a finding only when authoritative, else `unverified`; a
present-but-invalid value is always a finding. **`unverified`-skip → noSignal:** custom-scalar-typed vars
(SDL identity scalars validate nothing — `typeFromAST`-resolved transitive walk, cycle-guarded), non-object
`variables`, multi-op with no operationName. **Fork 2 (full parity):** 3 slices — (1) engine; (2) capture→
contract bridge (`graphqlOperationOf` extracts `variables`; the GraphQL branch folds `unverified → noSignal++`
as `graphql-variable-unverified`, mirroring the REST `request-unverified` fold so absence-is-never-a-pass
holds for GraphQL); (3) direct surfaces — MCP `validate_response` gains `variables`, CLI `api validate
--graphql --variables`, and live `api run --graphql <schema>` (the symmetric parallel to `api run --openapi`,
findings redacted via `registeredSecrets`, folded into the exit code). Invariants held: absence-never-a-pass
(the bridge noSignal fold), redaction-before-verdict (value-free reconstructed messages + the bridge's single
chokepoint), compose-never-widen (`unverified` on a subtype; verdict shape/`fromCaptureVerdict`/`orchestrate`
UNCHANGED), no-real-fetch-in-gate (pure validator; in-process server for the live-run test). 21 tests added
(13 engine + 3 bridge + 4 CLI + 1 MCP)._
_**LIVE `api run --openapi` REQUEST validation — COMPLETE** (2026-06-04, all TDD red→green; gate green at
1207 TS + 45 Py; design + 2 forks human-ratified). Closes the ONE surface ADR 0014 explicitly staged.
`RunResult` still exposes only the REDACTED `PreparedRequest` by design, so a new out-of-band channel —
**`runRequestForContract`** → `{ result, capture: { request: RequestFacts, registeredSecrets } }` (sibling of
`runRequestForHar`, populated at PREPARE time so it works even on a withheld dry-run; `RunResult` UNCHANGED) —
surfaces the un-redacted request facts (method, pathname, decoded query, lower-cased headers, JSON-parsed
body). **Slice 1:** the channel + `buildRequestFacts` (a present non-JSON/binary body — multipart/file/
urlencoded/xml — is routed to the validator's presence-only `unverified` path, NEVER a false
`missing-required-body`; multipart's undici-set Content-Type is synthesized as bare `multipart/form-data` so
that routing is correct). **Slice 2:** CLI `api run --openapi` now drives `validateOpenApiRequest`
(authoritative — both presence flags true, it holds the real request) over those facts ALONGSIDE the existing
response check, redacts findings (message+path) via a `Redactor` rebuilt from `registeredSecrets`, folds
request-contract validity into the exit code, and prints/JSON-surfaces it as `requestContract`. A GraphQL
request envelope skips OpenAPI request validation (consistent with `validate_request`). **Ratified forks:**
(1) request validation runs even on a dry-run — the request is fully known at prepare time, catching drift
before unlocking `--unsafe`; exit code unchanged (a dry-run still exits non-zero). (2) CLI-only — the MCP
`run_request` does NO inline validation (it keeps run/validate as separate tools), so an inline-validating
MCP `run_request` would be a different shape, left unstaged. Invariants held: `RunResult` byte-identical
(the seam is a separate out-of-band channel, never attached to the agent-facing result), redaction-before-
output (findings scrubbed via the run's resolved secrets — verified by a test that a secret echoed in a
failing param finding becomes `[redacted:API_TOKEN]`, never the raw value), absence-never-a-pass (non-JSON
bodies → `unverified`, never a false missing/pass), no real fetch in `pnpm gate` (in-process server, same as
the existing run tests). 5 tests added (2 runner + 3 CLI)._
_**REQUEST-BODY/PARAM CONTRACT VALIDATION — COMPLETE (v1)** (2026-06-04, all TDD red→green; design = ADR
0014, the `request-contract-validation-design` fan-out: 4 research streams → synthesis → 3 adversarial
critics → corrected design; human ratified all 4 forks). The contract pillar now validates the REQUEST half
of an exchange, not just responses — so the cross-pillar verdict catches request-side drift too. 6 slices:
(0) extract `resolveOpenApiOperation` + `normalizeOpenApiSchema` shared helpers out of the response validator
(pure refactor, response suite = regression guard) — request body/param schemas now reuse the SAME treatment
(3.0 `nullable` shim, local + external-local-file `$ref` deref, `$defs` merge); (1) `validateOpenApiRequest`
requestBody: required+schema + the load-bearing `bodyPresenceAuthoritative` flag (a required-but-absent body
is `missing-required-body` ONLY when the caller is authoritative — direct surfaces; else `unverified`);
(2) parameters (SCALARS ONLY): merged path-item+operation params, positional path extraction
(multi-param-per-segment ⇒ inconclusive-skip), strict whole-string scalar coercion then ajv,
`missing-required-param` (authoritative) else `unverified`; (3) media-type-aware body selection (CT
specificity; CT present + no match ⇒ `unsupported-media-type` warning; CT ABSENT + no JSON key ⇒ `unverified`,
NEVER unsupported-media-type), local `$ref` deref for requestBody/params (non-local ⇒ inconclusive-skip, never
`undocumented-body`), `undocumented-param` (query only; declared-but-skipped never flagged), 3.0 `nullable` on
PARAMS; (4a) `harEntriesToFacts` now captures `req.query`+`req.headers` so param validation is REACHABLE from
the capture/verify path; (4b) the bridge's REST branch drives `validateOpenApiRequest` over each entry
(non-authoritative), merges findings (drops the duplicate `missing-operation`), and **folds `unverified` →
`noSignal++`** (out-of-band `request-unverified`, kept OUT of `results[]`) so a present-but-uncheckable body /
uncapturable required param forces `clean:false` ⇒ no-signal, NEVER pass — closing the absence-as-pass leak a
critic proved; (5) MCP `validate_request` (authoritative; refuses a GraphQL envelope via the exported
`isGraphqlEnvelope`; message+path redacted) + CLI `api validate-request`. **Fork-1 (ratified):** `pushResult`
now redacts finding `path` too (request bodies/params are secret-bearing) — one chokepoint, request+response.
New `ContractFindingKind`s: request-body-schema/missing-required-body/undocumented-body/unsupported-media-type/
missing-required-param/param-schema/undocumented-param. `RequestValidationResult.unverified` is additive — the
verdict shape + `fromCaptureVerdict` + `orchestrate` are UNCHANGED (compose-never-widen). Invariants held:
absence-never-a-pass (the unverified→noSignal fold), redaction-before-verdict (message+path; coerced values
never echoed — only the raw substring), no-real-fetch-in-gate (pure validator; bridge reads a stored HAR).
**One surface STAGED (honest, not amputated):** the live `api run --openapi` inline request check — `RunResult`
exposes only the REDACTED `PreparedRequest`, so it needs the runner to surface the un-redacted sent request
(pairs with the existing `runRequestForHar` channel). 9 surface + 38 engine/bridge tests added._
_**TAIL — `@sackville-mcp/severity` extraction — COMPLETE** (2026-06-04, behavior-preserving, gate green at
1164 TS + 45 Py; the human ratified the "unify the qualitative base" depth fork). A new pure ZERO-dependency
leaf `@sackville-mcp/severity` (mirrors `@sackville-mcp/diff`/`assert`/`artifacts`) owns the shared severity vocabulary:
`QualitativeSeverity` ('critical'|'high'|'moderate'|'low') + `QUALITATIVE_RANK` (single source of truth) + the
verdict scale `Severity` (= `QualitativeSeverity | 'none'`) + `SEVERITY_RANK` (DERIVED from `QUALITATIVE_RANK`,
not re-typed, so the common buckets can't drift) + `maxSeverity`/`atLeast`. **`@sackville-mcp/verdict`'s
`severity.ts` is now a thin re-export shim** — its public surface AND every internal `./severity.js` import are
unchanged (verdict suite = the regression guard); verdict gains exactly ONE runtime workspace import (the pure
leaf — no heavy dep dragged in; the tsdown comment updated to say so). **`@sackville-mcp/deps` builds `SeverityBucket`
(= `QualitativeSeverity | 'unknown'`) + `BUCKET_RANK` (= `{...QUALITATIVE_RANK, unknown:0}`) on the same base**,
and `audit.ts` now imports `BUCKET_RANK` from `osv.ts` (killed the byte-identical duplicate rank map that lived
in both osv.ts and audit.ts). **The load-bearing `none` ≠ `unknown` distinction is PRESERVED** — deps' `'unknown'`
stays a deliberately separate member that maps to a `no-signal` pillar, never to `none`/`low`
(absence-is-never-a-pass). New `@sackville-mcp/severity` alias in `vitest.config.ts`; runtime dep of verdict + deps. 4
new severity tests (incl. a no-drift lock: `SEVERITY_RANK`'s qualitative entries === `QUALITATIVE_RANK`)._
_**MILESTONE 5f — verify-driven API-RUNNER capture — COMPLETE** (2026-06-04, all TDD red→green; design =
ADR 0013 Addendum 4, the `verify-api-capture-5f-design` fan-out; human ratified 2 forks: ADD
`SACKVILLE_API_COLLECTIONS_DIR`, and the DEEPER `@sackville-mcp/verdict` fix). Adds a SECOND verify-driven
produce source: a single gated call drives the **`@sackville-mcp/api` runner** for an operator-authored request
(by NAME), SYNTHESIZES a HAR from the run, and validates it via the SHIPPED `validateCapturedTraffic` —
full REST + GraphQL parity. Closes the 3 gaps Addendum 3 staged: (a) per-hop HAR entries in the redirect
loop, (b) the real request body as `postData` (GraphQL), (c) a `finalizeHar`-style blanket-redaction pass
extracted to shared code. 9 slices: (1) extract pure `redactHarZip`+`summarizeHar` into `@sackville-mcp/api`
`har-synth.ts` (fflate-only leaf); (2) browser `finalizeHar` delegates to it (acyclic browser→api edge,
ONE redaction path, the 5e attach-mimeType fix inherited); (3) `synthesizeRedactedHarZip` (pure; inline
text; redact folded in so no un-redacted buffer escapes; THROWS on a status-less record); (4) runner
`runRequestForHar`/`runSequenceForHar` out-of-band channel (per-hop records via `text()` not `dump()`,
labeled the CURRENT vetted url; the REAL wire request body; `redirectTruncated`; `Redactor.entries()` →
run-resolved secret pairs; `RunResult` UNCHANGED); (5) the `runRequestToHar`/`runSequenceToHar` produce
driver + TRANSPORT-completeness guards that THROW ⇒ inconclusive (a withheld/dry-run/blocked request, any
non-sent step per `step.result.sent` [the critics' blocker, NOT `step.sent`], a truncated redirect chain)
+ the secret-union fold; returns the FULL `CaptureContractVerdict`; (6) **the ratified deeper fix** —
`@sackville-mcp/verdict` `fromCaptureVerdict` folds `clean===false` ⇒ inconclusive (closing a CONFIRMED latent
absence-as-pass hole in the shipped 5e produce + consume paths: a valid REST entry rode a sibling
no-signal/unresolved entry to a PASS because the thunk handed the adapter only `.results`), threaded
through orchestrate's contract thunk (`ContractResult[] | CaptureVerdictFacts`, type-only — invariant 1
intact) + retrofitted into both bin-verify runners; (7) the `verify_change` `produce-api` contract variant
(target = `request` + optional `collection` NAME + vars; EXACTLY ONE of request/flow/harHandle); (8)
`bin-verify` produce-api branch composing the api pillar's OWN gate (`SACKVILLE_ALLOW_UNSAFE`/`_ALLOWED_HOSTS`/
`_BLOCK_PRIVATE` + `{{secret:NAME}}`) + the ratified `SACKVILLE_API_COLLECTIONS_DIR` (by-NAME, traversal
refused) — gate-denied when unmet, a mutating request without ALLOW_UNSAFE dry-runs ⇒ inconclusive; (9)
`sackville verify run --request <name> --collection-dir <dir>` CLI (mutually exclusive with `--flow`;
straight-through `--allow-unsafe`/`--allow-host`; a REAL redactor at BOTH chokepoints, NOT the empty `{}`
the browser path can use — the synthesized api HAR holds raw bytes until `redactHarZip`). Invariants held:
core `.mjs` untouched (the verdict threading is type-only), compose-never-widen (api pillar's own gate, one
ratified env, agent supplies only the target NAME), absence-never-a-pass (transport guards throw +
`clean===false` folds to inconclusive), no real fetch in `pnpm gate` (injected runners; the loopback e2e
is the api pillar's accepted style), redaction (union) before the verdict inline AND stored._
_**MILESTONE 5e — verify-driven LIVE capture (browser-spawn) — COMPLETE** (2026-06-04, all TDD red→green;
design = ADR 0013 Addendum 3, human-ratified forks: browser-spawn only / API-runner→5f; test-first
attach-body redaction; keep `source:'capture-from-HAR'`; live-capture extracted to `@sackville-mcp/browser`).
Turns the consume-only capture→contract bridge into a verify-DRIVEN one: ONE gated `verify_change` call (or
`sackville verify run --flow`) drives a browser flow, captures the HAR, and validates it. **The fan-out's
load-bearing correction (all 3 critics, independently):** `runFlow` SWALLOWS step errors (returns
`passed:false`, never throws), so a partially-denied flow yields a NON-empty HAR that could validate to a
PASS — "absence as a pass." Fix: **`driveBrowserFlowToHar` gates on FLOW COMPLETENESS, not HAR emptiness**
(throws if `!flow.passed` ⇒ inconclusive, never finalizes/validates the partial HAR). 8 slices: (1) brand the
browser `GateError` (`Symbol.for('sackville.gate-denial')`); (2) `ContractCaptureContext` → `consume|produce`
discriminated union + the `verify_change` `contract:{flow,vars}` input (core UNTOUCHED — `orchestrate.test.ts`
import-scan still green); (3) extract single-source **`buildBrowserRuntimeFromEnv`** from `bin-browser` (the 3
interlocking egress mechanisms: proxy started + `proxyServer`/hardening args + gate installed) so the verify
path can't omit one; (4) **`driveBrowserFlowToHar` + the flow-completeness guard** (single-shot
`runtime.shutdown()` in `finally` — no SSRF-proxy leak; lazy import); (5) **redact attach-mode HAR bodies by
declared mimeType** — test-first confirmed the leak (a JSON/GraphQL body stored under a non-`.json`
content-addressed filename bypassed `finalizeHar`'s extension gate); (6) `bin-verify` produce branch behind
the FULL browser gate (`ENABLE_RUN ∧ ALLOW_CAPTURE ∧ BROWSER_ALLOWED_HOSTS ∧ _HAR_DIR ∧ _FLOWS_DIR`, no new
env) + the **union redactor** (verify ∪ browser secrets) at BOTH chokepoints (`finalizeHar` + `validate`);
(7) surface the produced HAR handle (`capture:{harHandle,summary}`) for auditability — via a widened SURFACE
runner return, core still `() => Promise<ContractResult[]>`; (8) extract live-capture to `@sackville-mcp/browser`
(its natural home — shared by the MCP bin AND the CLI, ONE flow-completeness guard) + `sackville verify run
--flow` (gated by browser egress flags, not `--allow-run`; injectable runner so the suite never spawns).
Invariants held: core `.mjs` untouched, compose-never-widen, absence-never-a-pass, no real spawn in `pnpm
gate`, redaction (union) before the verdict inline AND stored. **5f staged:** the API-runner capture path
(per-hop HAR + request-body capture for GraphQL + a finalizeHar-style redaction pass); request-body/param
contract validation; extract the shared `Severity` scale out of deps; artifact GC/TTL; the Python half._
_**MILESTONE 5d — diff-scoping + deps run-wiring — COMPLETE** (2026-06-04, all TDD red→green; the
shared-primitive placement fork was ratified by the human: EXTRACT `@sackville-mcp/diff`, not extend coverage).
Two coupled threads, 6 slices: **(a) diff-scoping.** **Slice 1** extracted the new pure, zero-dependency
**`@sackville-mcp/diff`** package — `parseUnifiedDiff` MOVED out of `@sackville-mcp/coverage` (which re-exports it
for back-compat + consumes it via `report.ts`; behavior-preserving, coverage suite is the regression guard)
+ a new `changedFiles(diff)` scope primitive (all non-deleted touched paths, incl. removal-only
modifications `parseUnifiedDiff` omits; excludes deletions). The placement is forced, not aesthetic:
`@sackville-mcp/verify` must RUNTIME-call the parser to scope pillars, and its source-scanned "imports zero
spawn-capable code" invariant forbids a runtime import from the engine-listed `@sackville-mcp/coverage` (re-exports
`runScoped`→`child_process`) — a pure shared package keeps the invariant provable. Mirrors safety/assert/
artifacts. **Slice 2** added pure block-aware **`changedDependencies(diff, ecosystem)`** to `@sackville-mcp/deps`
(over `@sackville-mcp/diff`): tracks the open `dependencies`/`devDependencies`/`peerDependencies`/
`optionalDependencies` block so a changed `version`/`engines.node`/`packageManager`/`scripts` value (which
also LOOKS like a version) is never mistaken for a dependency. Under-scopes (never invents a dep) when a deep
dependency's block header is outside the diff context — documented, caller falls back to whole-project.
PyPI/Gem lockfile diffs return `[]` (staged). **Slice 3** — `verify_change` now DERIVES `changedFiles` from
a supplied `diff` (explicit `changedFiles` still wins) so ONE diff scopes coverage (`vitest related`), mutate
(`mutateFiles`), and flake (`files`); deps scoping is delegated to its runner (it owns the ecosystem). flake's
`files` was already on its `flake_run` MCP tool. **(b) deps run-wiring (carried from 5c).** **Slice 4**
factored `audit_project`'s per-package pipeline into the reusable **`auditProjectDependencies(config)`**
(`packages/mcp/src/deps.ts`) → `{audits, osvSnapshotLoaded, snapshotDate, errors}` (the `RunDrivingOptions.deps`
shape) with an optional `names` scope; `audit_project` refactored to consume it (behavior-preserving). **Slice 5**
wired `rd.deps` into `bin-verify`: deps' OWN gate is NETWORK (it fetches packuments, never runs project code),
so it composes "both required" — `SACKVILLE_VERIFY_ENABLE_RUN` AND `SACKVILLE_DEPS_ALLOW_NETWORK`; a shared
`depsNetworkConfig(env)` (factored in `bin-deps`) is the single source for the SSRF-pinned fetcher + OSV dir;
the runner scopes the audit to `changedDependencies(ctx.diff)`, whole-project fallback when none changed.
**Slice 6** added `--deps` to `sackville verify run` over a reusable `auditProjectScoped` (factored into
`cli/deps.ts`); `--deps` is NETWORK-gated (no `--allow-run`), a `--diff` scopes it, fetcher = the same
`makeFetcher(registriesFrom)` as `sackville deps`. Load-bearing invariants HELD: "compose, never widen" (no
umbrella gate; deps composes `ALLOW_NETWORK` under `ENABLE_RUN`); scoping only NARROWS what runs; no real
spawn/fetch in `pnpm gate` (every runner/fetcher injected). The `@sackville-mcp/diff` alias was added to
`vitest.config.ts` + it is a dep of coverage/deps/mcp; verify's built `.mjs` still imports only `node:crypto`
+ `@sackville-mcp/verdict` (verify uses the MCP/CLI layer's diff derivation, not its own runtime diff import — the
invariant is untouched)._
_Make the pillars COMPOSE: a captured browser/API run's traffic is validated against the API
contract (the capture→contract bridge), and that folds with the four Phase-4 signals into ONE
structured verdict an agent requests for a change. **5b LANDED (1038 TS + 45 Py green):** the new
pure **`@sackville-mcp/verdict`** package — `Severity`/`SEVERITY_RANK`/`maxSeverity`, the five `from*`
pillar adapters, and `composeVerdict` (type-only pillar imports, **zero runtime pillar deps** — the
built `.mjs` has no imports at all, so it never drags `better-sqlite3`/`playwright-core` in). The
load-bearing invariant holds: **absence is never a pass** — an empty fold, or any present
`missing`/`no-signal` pillar, yields `inconclusive` (`ok:false`), never `pass`; deps `'unknown'` ⇒
`no-signal` (never `low`/`none`); mutation `survivors[]` drives warn/fail (not just
`mutationScore===null`); **no baked-in `failAtOrAbove`** — the caller declares the cut. Surface:
`request_verdict` MCP tool (compact inline + detail by `sackville://verify/{id}/verdict`) +
`sackville-verify-mcp` bin (reads ONLY `SACKVILLE_ARTIFACTS_ROOT` + `SACKVILLE_VERIFY_ALLOW_CAPTURE`,
the §3c guard — no per-pillar `*_ALLOW_RUN`) + `sackville verify` CLI (exit 0 pass / 1 fail|warn /
2 inconclusive). Earlier: **5a** the capture→contract bridge (below). Both compose-only / zero-spawn
in v1; orchestration/run-driving, GraphQL-from-HAR, and
the Python half are explicitly staged. **MILESTONE 5a COMPLETE (1011 TS + 45 Py green) — the
capture→contract bridge works end-to-end:** (slice 1) `@sackville-mcp/artifacts` is now
**prefix-qualified on disk** (`<baseDir>/<prefix>/<id>/<kind>`) so one shared `baseDir` is
collision-free across pillars and a store **rehydrates a foreign-prefix handle it never `put()`**
(the cross-pillar read) — per-segment allowlist + realpath-confinement (symlink-escape closed) +
a `<kind>.meta.json` contentType sidecar; (slices 2–5) pure `harEntriesToFacts`/
`validateCapturedTraffic` in `packages/api/src/har-capture.ts` — resolve a REAL Playwright
`content:'attach'` HAR `.zip` (bodies as separate `_file` entries; an unresolved attached body is
a hard finding, never an empty pass), JSON-only origin/content-type filter, OpenAPI server
base-path reconciliation, drive each entry through the SHIPPED `validateOpenApiResponse` + an
`spec.paths × methods` exercised/unexercised drift walk, **every finding message + captured path
routed through the operator `Redactor`**; (slice 6) the gated MCP `validate_capture` (api server,
registered only when a HAR resolver is wired, refuses without `SACKVILLE_VERIFY_ALLOW_CAPTURE`,
detail by handle under the `verify` prefix) + the human `sackville api validate-capture <har.zip>
--openapi <spec>` CLI. Verified vs a real captured HAR (schema drift + base-path + redaction).
**Phase-5 tail LANDED — GraphQL drift over captured traffic (1053 TS + 45 Py green, incl. the real-capture fixture):** the
capture→contract bridge now validates GraphQL traffic, not just REST. `harEntriesToFacts` resolves
the **request** body (`postData._file` attach → inline `text` → JSON-parse) into `req.body` — the
GraphQL `query` lives in the request, not the response. `validateCapturedTraffic`'s 2nd arg is now
the discriminated **`CaptureContract { openapi?, graphql?: {endpointPath, sdl} }`** (clean break;
only the MCP + CLI callers + tests updated): a JSON entry matched by the contract's `endpointPath`
OR the `{query}` request shape routes to the SHIPPED `validateGraphqlOperation` (query-vs-SDL drift +
response-`errors[]`), and a GraphQL entry **never** falls through to the OpenAPI validator (no
`missing-operation` flood). **Absence is still never a pass:** a detected GraphQL entry with NO SDL
is no-signal `graphql-sdl-not-supplied`, a REST entry with no OpenAPI spec is no-signal
`no-contract-for-entry`, and any `noSignal>0` blocks `clean` (new `verdict.noSignal` field). Surface:
`validate_capture` MCP gained `graphqlSchema`+`graphqlEndpoint` (openapiSpec now optional; ≥1 required)
+ `sackville api validate-capture <har.zip> --graphql <schema> --graphql-endpoint <path>` CLI.
**Backed by a REAL capture:** `packages/api/test/fixtures/graphql-capture.har.zip` is a genuine
Playwright `content:'attach'` HAR of headless chromium POSTing `query Widgets { widgets { id name } }`
to an in-process `/graphql` (generated by a one-off `gen-graphql-har.mjs` mirroring
`packages/browser/src/har.test.ts`; regenerate via the generator in this milestone's commit). It
revealed a real-shape detail: attach-mode stores the **request** `postData` in a `_file` entry (with
`text` also present), so the fixture exercises the attached request-body resolution path. The
api/MCP/CLI GraphQL tests all consume this fixture (clean SDL ⇒ clean, `name`-dropped SDL ⇒
graphql-validation drift); only the response-`errors[]` / no-query / operationName edge cases that one
clean capture can't express stay hand-authored.
**MILESTONE 5c — run-driving / orchestration `verify` — UNDERWAY (design = ADR 0013 Addendum, Accepted 2026-06-04).** The
goal: a `verify` that DRIVES the gated pillars (coverage/flake/mutate/deps + the consume-only capture
bridge) and folds them into one verdict in a SINGLE agent call — the "is this change safe?" one-shot.
Load-bearing contract ("compose, never widen"): verify reuses each pillar's OWN paired deny-by-default
gate; the env model is **"both required"** — verify runs pillar P iff (P's own `SACKVILLE_<PILLAR>_ALLOW_RUN`
is set) AND a SEPARATE `SACKVILLE_VERIFY_ENABLE_RUN` opt-in is set (NOT verify-scoped renames — the
adversarial pass killed those as a drift footgun); no agent input can set `allowRun`/`allowedRoots`.
The design was forged via the `verify-orchestration-design-research` (6 streams) → human ratification
of 4 forks → `verify-orchestration-adversarial-critics` (3 critics) fan-outs; the critics materially
changed the gate-env mechanism + the status model (recorded in the ADR Addendum's corrections list).
Decisions: a NEW `@sackville-mcp/verify` runtime package (orchestration core; imports ZERO spawn-capable
code — all runners/store/validator injected, engines `external`, so `pnpm gate` never loads
better-sqlite3/playwright-core); a NEW sibling `verify_change` MCP tool (deny-by-default REGISTRATION,
only when run-driving enabled) + `sackville verify run <root>` CLI (the compose-only `request_verdict` +
`sackville verify` stay unchanged); run-driving FIRST/unscoped (diff-scoping = 5d); capture CONSUME-only
(live capture = 5e). Per-pillar failure isolation via `Promise.allSettled`; gate-denial ⇒
`skipReason:'gate-not-set'`, any other rejection ⇒ `errorReason` (REDACTED); injected `idFactory`
(default `randomUUID`). **Slice 1 of 6 LANDED (1057 TS + 45 Py green):** the pure `@sackville-mcp/verdict`
provenance fields — `PillarVerdict` gains optional `skipReason:'gate-not-set'|'not-requested'` +
`errorReason?` (redacted); skipped/errored map to `status:'no-signal'`, not-requested to `'missing'`
(both already ⇒ `inconclusive`); **`PillarStatus` is UNCHANGED** (adversarial correction — extending the
exhaustively-switched union would corrupt the fold + `failsByPolicy`); `composeVerdict`'s inconclusive
predicate widened defensively so a present `skipReason`/`errorReason` can NEVER be laundered into a pass.
**Slice 2 of 6 LANDED (1063 TS + 45 Py green):** the new **`@sackville-mcp/verify`** runtime package — the
gated `orchestrate(request, options)` core. Each requested pillar carries an async `run` thunk producing
its NATIVE result; orchestrate fans them out concurrently (per-task `.catch` = the failure isolation
`Promise.allSettled` gives — one pillar's crash never sinks the verdict), maps each via the existing
`@sackville-mcp/verdict` `from*` adapter, and folds via `composeVerdict` (omitted pillars ⇒ `missing`). A
rejected run ⇒ an errored, **redacted** `no-signal` contributor (injected `redact`); the verdict id is
minted by an injected `idFactory` (default `randomUUID`). **The "imports zero spawn-capable code"
invariant holds and is proven two ways:** a source-scan test (every `@sackville-mcp/<engine>` import is
`import type`; no `defaultVitestRunner`/`HistoryStore`/`better-sqlite3`/`playwright-core` token) AND the
built `.mjs` imports ONLY `node:crypto` + `@sackville-mcp/verdict` (verified, dist not committed). The pillar
`run` thunks (wired by the surface to each gated runner) are the only side-effecting code; verify itself
type-imports the result interfaces and runtime-imports only the pure verdict package.
**Slice 3 of 6 LANDED (1072 TS + 45 Py green) — gate composition ("compose, never widen"):** a pillar
whose OWN gate denies ⇒ `skipReason:'gate-not-set'` (surfaced, NOT run, raw message dropped; siblings
still fold); any OTHER rejection ⇒ redacted `errorReason`; both `no-signal` ⇒ `inconclusive`, never pass.
The mechanism is a **structural brand via the global symbol registry** — `@sackville-mcp/verify` exports
`isGateDenial`/`gateDenied`/`GATE_DENIAL` keyed by `Symbol.for('sackville.gate-denial')`, and the three
engine `*GateError` classes (Coverage/Flake/Mutate) now set that symbol in their constructors — so verify
recognizes a REAL gate denial WITHOUT importing any engine code (the spawn-free invariant holds; reuses
the real `assertAllowed`, no predicate drift). `gateDenied()` covers the deps-network-off / flake-no-DB
cases the surface detects (wired in slice 5). Verified: orchestrate invokes each pillar `run` thunk with
ZERO args (it cannot inject/widen a gate — the gate lives entirely in the operator-wired thunk), and the
`OrchestrateRequest`/`Options` types carry no `allowRun`/`allowedRoots` knob at all.
**Slice 4 of 6 LANDED (1078 TS + 45 Py green) — the `verify_change` MCP tool.** In
`packages/mcp/src/verify.ts`: a NEW sibling tool (compose-only `request_verdict` unchanged) that DRIVES
the wired pillars via `@sackville-mcp/verify` `orchestrate` and folds one `CompositeVerdict`. Deny-by-default
REGISTRATION — registered ONLY when `opts.runDriving` wires ≥1 pillar runner (mirrors `run_scoped`). Input:
`projectRoot` + optional `changedFiles`/`diff` + optional `pillars[]` (default = all wired) +
consume-only `contract:{harHandle,...}` + `failAtOrAbove` (no default). Each pillar's runner is INJECTED
(operator-wired in slice 5, gate satisfied); a requested-but-unwired pillar gets a `gateDenied()` thunk ⇒
`skipReason:'gate-not-set'` (never run). Output = compact verdict inline (pillars carry the provenance) +
detail by `sackville://verify/{id}/{kind}`. Contract sub-verdict folds in behind the injected capture
runner (`source:'capture-from-HAR'`). (`@sackville-mcp/verify` added to mcp deps + the vitest alias map; tests
inject fake runners so the suite never spawns.)
**Slice 5 of 6 LANDED (1082 TS + 45 Py green) — `bin-verify.ts` run-driving entrypoint, the "both
required" env gate.** Run-driving wires ONLY when `SACKVILLE_VERIFY_ENABLE_RUN` is set; THEN each pillar's
runner is wired ONLY when its OWN gate is satisfied (`SACKVILLE_<PILLAR>_ALLOW_RUN` + `_PROJECT_ROOTS`
[+`_TIMEOUT_MS`], the single source of truth shared with the standalone server — coverage→`runScoped`,
flake→`runAndRecord` [needs `SACKVILLE_FLAKE_DB`], mutate→`runMutation`; consume-only contract→
`validateCapturedTraffic` behind the EXISTING capture gate, resolving the foreign-prefix browser HAR by
handle). `verify_change` registers only when ≥1 runner is wired. The §3c guard HOLDS and is STRENGTHENED:
with `ENABLE_RUN` unset, per-pillar `*_ALLOW_RUN` envs are IGNORED and `verify_change` is not registered
(tested). The bin builds the operator `Redactor` (`SACKVILLE_VERIFY_SECRET_*`) for both capture findings +
errored-pillar messages. Runners are closures invoked only at call time, so `pnpm gate` never spawns.
**KNOWN GAP (staged, not amputated): deps run-driving is NOT yet wired** — `audit_project`'s per-package
pipeline (manifest names → detect installed → SSRF-pinned packument fetch → OSV snapshot → `auditDependency`)
has no single exported runner; factoring it out is a clean follow-up, naturally paired with 5d's deps
`changedDependencies` diff-scoping. Until then, deps is reachable via the deps server's `audit_project` →
fed to `request_verdict` (compose path).
**Slice 6 of 6 LANDED (1087 TS + 45 Py green) — `sackville verify run <root>` CLI.** A `run` subcommand on
`sackville verify` (bare `verify` = compose, unchanged): drives the selected pillars (`--coverage` /
`--mutate` / `--flake --flake-db <path>`) over `@sackville-mcp/verify` `orchestrate` + folds them. The human is
the operator: `--allow-run` is the straight-through gate, the typed `<root>` is auto-allowed; without it
each pillar's own `assertAllowed` denies (⇒ `skipReason:gate-not-set`, exit 2). `--changed-file`/`--diff`/
`--timeout-ms`/`--fail-at-or-above`/`--json`; exit `0 pass / 1 fail|warn / 2 inconclusive`. Per-pillar run
thunks are injectable (the test seam mirrors the MCP `RunDrivingOptions`) so the suite never spawns; the
no-`--allow-run` test exercises the REAL engine gate (denies before any spawn). **MILESTONE 5c COMPLETE.**
**Next action: milestone 5d — diff-scoping the non-coverage pillars + deps run-wiring.** (a) a shared
changed-set primitive (extend coverage's `parseUnifiedDiff` or extract `@sackville-mcp/diff`); expose flake's
existing `files` in MCP; a pure `changedDependencies(diff, ecosystem)`; `verify_change` then scopes each
pillar from one diff. (b) Wire deps into the verify run path — factor `audit_project`'s per-package
pipeline into a reusable runner, add `rd.deps` to `bin-verify` (gated by `SACKVILLE_DEPS_ALLOW_NETWORK`
under `ENABLE_RUN`) + a `--deps` flag to `sackville verify run`. Then 5e (live capture). See ROADMAP
milestone 5d + the ADR 0013 Addendum § "what stays staged"._

**Phase 4 — Cross-cutting verification: COMPLETE (all 5 pillars: engine + agent surface).**
_(`@sackville-mcp/deps`, `@sackville-mcp/coverage`, `@sackville-mcp/flake`, `@sackville-mcp/mutate`, AND now
`@sackville-mcp/lsp` are all COMPLETE; only explicitly-staged, non-blocking tails remain — see the
end of the Next-action block. `@sackville-mcp/lsp` (the last pillar) shipped as **ADR 0011** slices
1–5: pure encoding + normalize (1), `client.ts` LSP JSON-RPC client (2), `registry.ts` +
`manager.ts` lifecycle (3), the gated `query.ts` engine (4), and the MCP surface + `sackville-lsp-mcp`
bin (5) — all over a fake-peer harness replaying recorded `typescript-language-server` payloads
(NO real server in `pnpm gate`). Design pass done via the `phase4-design-research` fan-out — 5 parallel research
streams → synthesis → 3 adversarial critics → corrected synthesis; captured in **ADR
0010**. Sequence (by leverage-per-effort): **`@sackville-mcp/deps` (dependency/version
intelligence) first** ∥ `@sackville-mcp/coverage` (parallel track), then `@sackville-mcp/flake`
→ `@sackville-mcp/mutate` (after a Stryker/Vitest-4 compat spike) → `@sackville-mcp/lsp` (last —
the only candidate that breaks ARCHITECTURE §1's no-live-RPC rule). Cross-cutting
decisions in ADR 0010: extract a shared **`@sackville-mcp/artifacts`** (parameterized
prefix) before the first handle-emitting slice; **explicit pins, no transitive
imports**; **paired deny-by-default operator gate** for any code-running surface;
**TS/Vitest first, Python staged**. **Slice 1 landed:** `@sackville-mcp/deps`
`auditDeprecation(packument, installedVersion)` — a pure, offline deprecation reducer
(version-scope wins over package-scope; npm empty-string un-deprecate idiom honoured)
over committed npm-packument fixtures. **Slice 2 landed:** `matchVulnerabilities`
— a pure OSV version-range matcher (the documented sort-events-then-scan algorithm;
SEMVER/ECOSYSTEM via `semver`, `fixed` exclusive vs `last_affected` inclusive,
explicit `versions`, ecosystem+name filter; severity bucketed
`critical|high|moderate|low|unknown`) over committed OSV-advisory fixtures.
`semver ^7.8.1` added as the package's first explicit pinned dep (matches `core`).
**Slice 3 landed:** `loadOsvSnapshot(dir, ecosystem)` — reads an operator on-disk OSV
snapshot (`<dir>/<ecosystem>/all.zip`, fflate-unzipped, one advisory JSON per entry)
→ `{ecosystem, advisories (sorted by id), snapshotDate (newest advisory `modified`)}`
feeding `matchVulnerabilities`; fails loud on an absent ecosystem snapshot; zero
network (real FS round-trip in tests). `fflate ^0.8.3` added as an explicit pinned
dep (matches `browser`). **Slice 4 landed:** `auditDependency(input)` — the
agent-facing roll-up composing `auditDeprecation` + `matchVulnerabilities` + freshness
(latest / latestSameMajor / isOutdated via `semver`, prereleases excluded) into one
verdict (`worstSeverity`, conservative newest-same-major `recommendedTarget`,
`snapshotDate`, `hasFindings`); pure (caller gathers inputs). **The deps engine's pure
core is complete.** **Slice 5 landed (agent surface):** `audit_dependency` (single
package) + `audit_project` (compact npm-manifest roll-up; per-package error non-fatal)
MCP tools in `packages/mcp/src/deps.ts` (`registerDepsTools`/`createDepsServer`) +
`sackville-deps-mcp` bin (`bin-deps.ts`). The surface wires the I/O the pure core needs —
detect the INSTALLED version (`core.detectInstalledVersion`, ecosystem-mapped npm→node) →
an **injected** packument fetch (so the surface stays offline/deterministic in tests) →
the operator OSV snapshot (`loadOsvSnapshot`) → pure `auditDependency`; reports
`osvSnapshotLoaded` so "no known vulns" is never authoritative absent a snapshot, and
fails clearly when the version can't be detected or network is off. The bin is the sole
reader of namespaced `SACKVILLE_DEPS_*` (`OSV_DB_DIR`, `ALLOW_NETWORK` **off by default**,
`NPM_REGISTRY`, `ALLOW_PRIVATE`) and the sole builder of the **SSRF-pinned**
(`@sackville-mcp/safety` `resolveAndPin`, private blocked by default) npm packument fetcher;
safety/network are operator-set, never agent inputs. The first **handle-emitting** deps
slice (`changelog_diff` + by-handle `audit_project` detail) is deferred to the shared
`@sackville-mcp/artifacts` extraction. **Shared `@sackville-mcp/artifacts` extraction DONE** (ADR
0010 cross-cutting): the on-disk `ArtifactStore` moved out of `@sackville-mcp/browser` into a
new shared package with a **parameterized** `sackville://<prefix>/<id>/<kind>` handle
prefix (browser keeps `browser/run`; deps/coverage emit their own — e.g.
`sackville://deps/...`). Behavior-preserving — browser is a thin subclass that bakes in
the `browser/run` prefix so every call site is unchanged; the full browser suite is the
regression guard. **`changelog_diff` landed (first handle-emitting deps slice):** a
pure `sliceChangelog(markdown, {from, to?})` core in `@sackville-mcp/deps` (versioned ATX
headings — Keep-a-Changelog `## [x.y.z] - date` + plain `## vX.Y.Z`; returns the
sections in `(from, to]`, or `> from` when `to` is omitted, newest-first, semver-ordered;
date tokens/"Unreleased" never become versions; unparseable bounds throw) + a
`changelog_diff` MCP tool that detects the installed `from`, fetches the changelog via an
**injected** fetcher, slices it, and returns a compact summary with the sliced markdown
stored **by handle** in `@sackville-mcp/artifacts` (`deps` prefix) — served by a new
`sackville://deps/{id}/{kind}` resource. Deny-by-default: the tool + resource register only
when BOTH a fetcher and an artifact store are configured. Bin adds
`SACKVILLE_DEPS_ARTIFACT_DIR` (→ `ArtifactStore(dir,'deps')`) + a SSRF-pinned GitHub-raw
CHANGELOG fetcher (packument repo → `raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>`,
`resolveAndPin` per attempt, private blocked by default). It is the first consumer of the
extracted `@sackville-mcp/artifacts`. **`audit_project` full detail by handle also landed:**
when an artifact store is configured, `audit_project` stores the full per-package
`DependencyAudit` verdicts (vulnerability lists, deprecation messages, freshness) as one
JSON blob by handle and surfaces `detailHandle` (inline result stays a compact roll-up;
without a store, `detailHandle` is omitted — `audit_project` is not gated on artifacts).
The `sackville://deps/{id}/{kind}` resource now serves both audit detail + changelog slices
(decoupled from the changelog fetcher; emits each artifact's own contentType). The
vuln-aware `minimumSafeUpgrade` target also landed (lowest release clearing all known
vulns, distinct from `recommendedTarget`), and the `behindBy` freshness metric
(`FreshnessVerdict.behindBy`: upgrade distance by semver component — releases/major/minor/
patch). **CVSS-vector → bucket scoring also landed** (pure `cvssV3BaseScore` v3.0/3.1 base
formula; `matchVulnerabilities` derives the severity bucket from a CVSS vector when no
qualitative GHSA string is present, so a vector-only advisory is no longer `unknown`).
**Track A `@sackville-mcp/coverage` is now open (slice 1):** the pure `uncoveredNewLines` differ
classifies a diff's added lines against an istanbul `FileCoverage` as covered / uncovered /
`nonExecutable` and surfaces the executable-but-unhit lines (the forgotten-assertion catch);
the no-statement `nonExecutable` third state + a guard test address ADR 0010's documented
correctness trap. **Slice 2 landed:** `parseUnifiedDiff` extracts per-file new-side added
lines from a unified diff (count-tracking hunk state machine; handles multi-file/prefix-less/
new/deleted files). **Slice 3 landed:** `uncoveredInDiff` joins the two halves — parse the
diff → match each file to its `coverage-final.json` entry (path reconciliation: exact
`<projectRoot>/<path>` else a unique path-suffix match, ambiguous refused) → classify →
report every executable-but-unhit new line + per-file breakdown + aggregate summary. The
pure offline core of the forgotten-assertion catch is complete. **Slice 4 landed:**
`runScoped` runs only the tests a change touches (`vitest related`) with v8 JSON coverage
→ feeds `coverage-final.json` into `uncoveredInDiff`; behind a paired deny-by-default
operator gate (`allowRun` + `allowedRoots` + timeout, `CoverageGateError`), with the
`vitest` run an injected `TestRunner` (default spawns a subprocess — the child-process
boundary that dodges Vitest-in-Vitest; engine unit-tested with a fake runner, no real spawn
in the gate). **MCP surface landed:** `uncovered_in_diff` (free, read-only) + `run_scoped`
(gated, registered only when the operator set `allowRun` + a non-empty root allowlist) in
`packages/mcp/src/coverage.ts` + the `sackville-coverage-mcp` bin (`SACKVILLE_COVERAGE_ALLOW_RUN`
/ `_PROJECT_ROOTS` / `_TIMEOUT_MS`, wires the live vitest runner). **The coverage pillar's
agent surface is complete.** **`@sackville-mcp/flake` is now open (slice 1):** the pure
`wilsonInterval(failures, runs, z=1.96)` (Wilson score interval for a binomial proportion,
clamped to [0,1], degenerate-zero for zero runs — chosen over naive p̂=failures/runs, which
is overconfident at small n and collapses at the p̂=0/1 boundaries) + `classifyHistory`/
`classifyHistories` over per-test run histories → `FlakeVerdict {state, runs, passes,
failures, failureRate, wilson, flakeScore}`. Policy: a **mixed** history is `flaky` at any
run count (observed inconsistency = flaky); an all-pass/all-fail history is `reliable`/
`broken` only after it clears `minRuns` (default 5), else `insufficient-data`; empty →
`insufficient-data`. `flakeScore` = the Wilson lower bound of the failure rate — the
conservative, sample-size-aware magnitude the (later, operator-gated) quarantine slice
thresholds on. Pure/offline over a committed `run-history.json` fixture shaped like the
future private better-sqlite3 history store ({passed, at} runs; `at` ignored). No runtime
deps yet (better-sqlite3 arrives with the history-DB slice). **`@sackville-mcp/flake` is now
COMPLETE (engine + agent surface), slices 2–6:** slice 2 `HistoryStore` — the private
better-sqlite3 run-history DB (append-only `test_run` + `flake_meta`; record/history/
classify; a SECOND SQLite owner per ADR 0010, outside the docs-pillar invariant); slice 3
`parseVitestJson` + `ingestReport` — pure parser of a `vitest run --reporter=json` report
→ RecordedRuns (stable `<relFile> > <ancestorTitles>title` ids, skipped/pending/todo
dropped), over a committed real-shaped fixture; slice 4 `Quarantine` — the only WRITE
surface, paired deny-by-default gate adapted here (`allowQuarantine` + load-bearing
`maxExpiryMs`; expiry MANDATORY, refused past the cap, no permanent quarantine; reads/
`release` ungated + expiry-aware; pure `quarantineCandidates` proposes, never `broken`/
`reliable`); slice 5 `runAndRecord` — the gated vitest runner (spawn `--reporter=json`,
`repeat`×suite, record, classify; mirrors coverage's runScoped — paired `allowRun`+
`allowedRoots` gate, injected TestRunner so no real spawn in the gate); slice 6 the MCP
surface + `sackville-flake-mcp` bin (`flake_status`/`flake_candidates`/`flake_release`
always on; `flake_run` behind the run gate; `flake_quarantine` behind the quarantine gate;
bin requires `SACKVILLE_FLAKE_DB` + the two independent paired gates). **`@sackville-mcp/mutate`
is now COMPLETE (engine + agent surface):** the **Stryker/Vitest-4 compat spike resolved
positively** (ADR 0010 update 2026-06-01 — vitest-runner 9.x declares `vitest >=2.0.0` +
ships Vitest 4/4.1 support, so thin-wrap is viable and Stryker stays an injected,
operator-spawned runner, NOT a gate dep); slice 1 pure `summarizeMutation` over the stable
mutation-testing-elements report schema (no `@stryker-mutator` import) → mutationScore
(detected/valid) + mutationScoreBasedOnCoveredCode + per-file metrics + an actionable
`survivors` list (Survived + NoCoverage — the complement to coverage's forgotten-assertion
catch); slice 2 the gated `runMutation` (spawn `stryker run --reporters json`, read,
summarize; paired `allowRun`+`allowedRoots` gate + injected MutationRunner so no real
Stryker in the gate; diff-scoped via `mutateFiles`→`--mutate` + `--incremental`) + the
`mutate_summarize`(free)/`mutate_run`(gated) MCP surface + `sackville-mutate-mcp` bin. With LSP
slices 1–5 (encoding/normalize + `client.ts` + `registry.ts`/`manager.ts` + gated `query.ts` +
MCP surface/bin) now also landed — Phase 4 pillars COMPLETE (at 659 TS). **Since then the
non-blocking tails landed: the cross-pillar Python adapters (flake/coverage/deps/mutate), the LSP
capability-gated read tails, **LSP write-mode (`lsp_rename`, ADR 0011 addendum slices A–G:
dry-run-default + a separate `allowWrite` gate)**, and **the five human verification CLIs
(`sackville mutate`/`coverage`/`flake`/`deps`/`lsp`), the LSP cold-project-load fix, and now the
**LSP `workspace/symbol` search tail** (project-wide symbol search by name — `lsp_workspace_symbols`
MCP tool + `sackville lsp workspace-symbols` CLI + the gated query path; an optional anchor `file`
opens a document so a tsserver-style project loads, a bug caught running the greeter live), and now
the **LSP `diagnostics` tail** (push-model errors/warnings for a file — `lsp_diagnostics` MCP tool +
`sackville lsp diagnostics` CLI; the server PUSHES `publishDiagnostics` after analysis, so the client
waits out indexing then returns the post-settle publish; empty = clean, not_ready = retry), and now
the **LSP multi-ROOT tail** (one server bound to multiple `workspaceFolders` via an additive,
opt-in `workspaceRoots[]` / `--workspace-root`; the manager keys a server by the sorted root group,
single-root behavior byte-identical), and now the **LSP write-mode multi-root tail** (`lsp_rename`
accepts the same `workspaceRoots`: a cross-root rename in a monorepo applies, with every edited URI
confined to the allowlisted root GROUP — primary ∪ workspaceRoots — realpath-hardened, all-or-nothing
via `confineEditedUriToRoots`; `workspaceRoots` threads into BOTH the compute and apply phases so
they key the SAME group-server; verified live on tsserver 5.3.0 — a cross-root `Greeter`→`Welcomer`
rename applied to disk in both roots), and now the **LSP resource-op write-mode tail** (`lsp_rename`
APPLIES `CreateFile`/`RenameFile`/`DeleteFile` interleaved with text edits — e.g. a module rename that
renames its backing file: ordered `operations` normalize, URI-union lock, group confinement of both
rename endpoints, a virtual-content-map Phase 1, a stage-then-commit `PhysicalOp` plan with terminal
`partial` on a mid-commit fault, and `didFileRename`/`didFileDelete` open-map migration; v1 cuts
non-default options / recursive delete / editing-a-renamed-file). It came with a **readiness
generalization** (servers that signal not-ready via an ERROR — rust-analyzer's `-32602` mid-index —
now route through the tri-state, not a hard failure) and **provisioning rust-analyzer 0.3.2921**
(local/untracked; gate stays fixture-only) to verify live: a `mod greeter;`→`welcome` rename edited
`main.rs` AND renamed `greeter.rs`→`welcome.rs` on disk, and now the **LSP resource-op SAFE-SUBSET v1
cuts** (operator chose the safe subset): `ignoreIfExists`/`ignoreIfNotExists` are now conditional
NO-OPS (not blanket-refused — `hasNonDefaultOptions`→`hasRefusedOptions`, only `overwrite`/recursive
stay refused), AND editing a file that is ALSO renamed/deleted in the same batch now APPLIES —
`applyEdit`'s replay was rewritten onto a per-file `Fate` VFS keyed by the ORIGINAL uri so content
flows THROUGH a rename (rename(A→B)+edit(B) import fix-up, and edit(A)+rename(A→B), both write the
edited content to the final path in documentChanges order; create+delete net-no-ops drop out). One
ordered write/rename/delete physical plan with a shared digest index per op; resync derives bytes
from what ACTUALLY landed (pristine on a partial commit) and migrates the open buffer only when the
rename landed; genuinely conflicting batches are REFUSED not reconciled (rename cycle, two-into-one,
edit-of-renamed-away-path, delete-of-a-rename/create-target = a data-loss guard). Designed via the
`lsp-resource-op-safe-cuts-design` fan-out (2 proposals → synthesis → 3 adversarial critics, five
holes folded in) + a recall-biased review fan-out. Then **LSP PULL-diagnostics**
(`textDocument/diagnostic`, dispatched by `diagnosticProvider`; live-verified vs rust-analyzer), and
now **LSP dynamic `didChangeWorkspaceFolders`** (grow-only warm-server reuse: a query whose root
group is a SUPERSET of a warm same-language server's folders extends that server in place via
`workspace/didChangeWorkspaceFolders` + re-keys it, instead of spawning a fresh server and re-paying
indexing — capability-gated on the server advertising `workspaceFolders.changeNotifications`; live-
verified vs rust-analyzer 0.3.2921). Most recent: the **LSP Python adapter** — pyright as a THIRD
real server (the engine is language-agnostic, so this is fixtures + an example + docs, NO engine
code): recorded `pyright-langserver` 1.1.410 payloads in the gate (object-form caps, no `serverInfo`
⇒ `versionWarning`, no `positionEncoding` ⇒ utf-16, no `diagnosticProvider` ⇒ push, flat-`Location`
definition, a `documentChanges`+`version:null` multi-file rename — a REAL payload for the branch the
synthesized fixture only guessed) + the `examples/lsp/pygreeter` quickstart (offline coordinate
guard) + a documented pyright quirk. **Quirk (verified live, deep-dived after a follow-up question):
pyright's `references` AND `rename` are scoped to the OPEN files** (+ queried file + whatever pyright
auto-analyzed) — it does not scan unopened workspace files, so on a non-trivial project a
references/rename from a *declaration* misses every unopened file; coverage scales linearly with the
open set; **a pyright cross-file `rename` can therefore be silently INCOMPLETE** (a 62-file repro
renamed only the declaration). An anchor file does NOT fix it (unlike `workspace/symbol`); server
config (diagnosticMode/indexing) doesn't either. The 2-file example's complete rename is a
small-workspace artifact. Single-target nav (definition/hover/type-def) is unaffected. Provenance:
python has no clean single-pkg toolchain map, so `bin-lsp.ts` deliberately maps none (versionWarning
is the honest signal). **Most recent: DESTRUCTIVE resource-op `overwrite` (ADR 0011 addendum
2026-06-03), 9 TDD slices** — a Create/Rename `overwrite:true` truncate-and-replaces an EXISTING
regular file behind a SEPARATE deny-by-default operator gate (`allowDestructiveResourceOps`,
self-enforcing ⇒ allowWrite; `SACKVILLE_LSP_ALLOW_DESTRUCTIVE_RESOURCE_OPS` / `--allow-destructive-
resource-ops`; default off everywhere with hard errors on the contradiction). Destroyed bytes are
audited (a `<path> (overwritten)` digest row folded into the partial-commit-safe
`extraRowsForPhysical` reconstruction) and surfaced as a new `overwritten[]` result field (landed
only). Designed via the `lsp-destructive-overwrite-design` fan-out (1 draft → 3 adversarial critics →
synthesis) which caught **2 blockers**: an overwrite-create kept in a SEPARATE `overwroteExisting`
set (NOT `created`, else a following delete silently no-ops, leaving the file intact); and symlink
targets REFUSED via `lstatSync`/`isOverwritableRegularFile` (clobber-through-link = an audit lie +
the real file survives). Also: directory targets refused, queried-file drift guard, clobbered-buffer
close (`didFileDelete` before `didFileRename`), and a destructive batch ESCALATES the completeness
guard (`unknown`/truncated ⇒ blocking like `suspect`). STAYS refused-by-design even with the gate:
recursive/dir delete (own unconditional branch), overwrite-on-delete (malformed), in-batch
two-into-one. Plus a CONSERVATIVE toolchain-mismatch `versionWarning` (toolchain-identity servers
only — rust-analyzer/gopls; tsserver EXCLUDED as a wrapper version; the full cross-version matrix
stays staged). Hand-authored INPUT fixtures (no real server emits overwrite in a rename flow — an
honest limitation, no live verification). — **current count is 988 TS + 45 Py green**; see the
Next-action block for the detail.**)_

**Phase 3 — Browser/UI testing pillar: FEATURE-COMPLETE.** _(Latest: **multi-engine**
(item 34, ADR 0009) — firefox/webkit support via `engine.ts` (`resolveEngine` +
`engineLauncher`/`engineLaunchOptions`); the injected-`launch()` `BrowserManager`
is unchanged (engine-agnostic), selection lives at the launch seam; bin
`SACKVILLE_BROWSER_ENGINE`, CLI `--engine`. The SSRF proxy applies to every engine;
chromium-only hardening args stay chromium (firefox/webkit lean on the Tier-1 route
allowlist + proxy — chromium is the hardened default); Lighthouse perf stays
chromium. Verified end-to-end (firefox + webkit drive navigate→snapshot→click). On
top of **visual regression** (33), the **container-hardening ADR** (32),
**vision/coordinate caps** (31), and **video capture** (30). **Developer live-view
was DROPPED — headless only** (ADR 0008: LLM-first; trace/HAR/console/video answer
"what happened" better than watching pixels). Only the explicitly-aspirational
bucket remains — `@playwright/mcp` embed, autonomous self-healing, cross-pillar
contract tie-in.)_ The agent surface AND the human `sackville browser`
CLI both ship over the engine; the full gating bundle (downloads/uploads/dialog/
auth) is done, plus trace-query, browser assertions, Lighthouse perf,
**network heavy mode (HAR capture + replay)**, and **persisted `.bru` browser-step
flows**. Visual regression and multi-engine have since landed; Phase 3 is
feature-complete (only the explicitly-aspirational bucket remains). Design locked by a 5-stream
research workflow w/ adversarial verification (`docs/research/2026-05-31-pillar3-
browser-testing.md`); captured in **ADR 0006 (+ dated updates) + ARCHITECTURE §10
+ ROADMAP Phase 3**. A new pure-TS **`@sackville-mcp/browser`** built **thin on stable
`playwright-core` 1.60.0** (NOT a wrap of `@playwright/mcp`, which pins an alpha
core + inlines artifacts); ARIA-snapshot-first driving; artifacts by handle;
deny-by-default operator-set safety. Shipped slices (all TDD, real-chromium tested
against in-process fixtures):

1. a11y-audit summarizer + on-disk `ArtifactStore`.
2. `BrowserManager` (shared browser, ephemeral context/session, idle reaper, caps).
3. ARIA-snapshot capture + serializer — Sackville mints its own ref-ids over the
   public `ariaSnapshot()` YAML (1.60.0 lacks `_snapshotForAI`/snapshot-refs; ADR
   update 2026-06-01); token-capped diff + full-snapshot handle.
4. `PageDriver` step tools (navigate/click/fill/select/press/waitFor/snapshot +
   free reads) over generation-tagged refs.
5. `BrowserGate` deny-by-default action gate — navigation allowlist + mutation
   dry-run (one-shot route capture+abort) vs execute; operator-set.
6. Shared **`@sackville-mcp/safety`** (SSRF range classifier + `Redactor` moved from
   `api`) + Tier-1 `installSafetyRoutes` allowlist (allowlist-authoritative).
7. Tier-2 `createSsrfProxy` — loopback DNS-pinning forward proxy; `allowPrivate`
   opt-in for local-app testing (never link-local/metadata).
8. Dry-run preview redaction completeness (`url` + `postData`, slice 8a) + the
   **artifact-capture pipeline** `RunRecorder` (slice 8b): trace.zip / console /
   network by `sackville://browser/run/<id>/<kind>` handle with compact summaries;
   text channels redacted before write; per-channel enable flags.
9. **Engine hardening for the MCP surface (Milestone A, slices A1–A6)** — surfaced
   by a fan-out design+adversarial-review workflow (`browser-mcp-design`): snapshot
   redaction seam (secrets reflected in the DOM no longer leak into the snapshot/
   artifact), per-generation immutable artifact handles (no overwrite), bounded
   diff output, dry-run popup-block + `crossOriginEgress` flag, no-snapshot vs
   stale-ref error, `BrowserManager.onReap` flush hook.
10. **Browser MCP surface (Milestone B)** — `registerBrowserTools`/
   `createBrowserServer` (`packages/mcp/src/browser.ts`): 15 session-oriented tools
   over a surface session registry + per-session async mutex; server-minted UUID
   sessionId+runId (never agent input); reads redacted at the surface; reaper
   reconciliation via `manager.onReap` + `hasSession` eviction; the two-variable
   `sackville://browser/run/{runId}/{kind}` resource. No tool input can flip a
   safety flag.
11. **`sackville-browser-mcp` server bin (Milestone C)** — `bin-browser.ts`
   (`buildBrowserServerFromEnv`, exported + unit-tested): namespaced
   `SACKVILLE_BROWSER_*` operator env with no api-var fallback; **mandatory**
   DNS-pinning SSRF proxy (no disable env) + Chromium `--proxy-bypass-list=
   <-loopback>` (loopback also traverses the proxy); trace-off-by-default; sandbox
   on by default (`--no-sandbox` opt-in); SIGINT/SIGTERM shutdown.

12. **Browser secret boundary — `{{secret:NAME}}` fill resolution** (`bffdf07`):
   `browser_fill`/`browser_fill_form` resolve `{{secret:NAME}}` to the operator
   secret server-side at the fill boundary (cleartext typed into the input, never
   in a tool arg or agent-visible result; redactor scrubs it everywhere); fails
   closed on an unknown name; the bin wires `resolveSecret` from the same
   `SACKVILLE_BROWSER_SECRET_*` map as the redactor.
13. **Browser secret boundary — origin-scoped `httpCredentials`** (`4841fb2`):
   `BrowserManager` applies operator HTTP Basic creds (optionally origin-scoped) to
   every session context; bin parses `SACKVILLE_BROWSER_HTTP_USERNAME/PASSWORD/
   ORIGIN`, registers the password with the redactor, and keeps it out of the
   config (config exposes `{username, origin}` only).
14. **Browser secret boundary — `storageState` by handle** (`24e47ff`):
   operator-gated `browser_save_storage_state` captures the context storageState to
   an operator-path artifact, returns a handle + cookie/origin counts (never
   inlined); the resource refuses the password-equivalent `storage-state` kind.
   Bin gates it behind `SACKVILLE_BROWSER_ALLOW_STORAGE_STATE` (default off).
15. **Browser secret boundary — trace-internal redaction** (`acc6536`):
   `RunRecorder.stop` unzips the trace.zip (fflate), scrubs its text entries (JSONL
   metadata + DOM/sources snapshots), and re-zips before write; binary resources
   pass through. **ADR 0006 §6 secret boundary is now COMPLETE.**
16. **Browser hardening — `serviceWorkers:'block'` + WebRTC** (`9207224`):
   `BrowserManager` blocks service workers on every context (no SW cache/intercept
   bypassing the Tier-1 SSRF layer); the bin adds
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (WebRTC limited to
   proxied UDP — no P2P egress bypassing the SSRF proxy, no local-IP leak).
17. **Browser caps — session wall-clock + max-pages** (`f0fc419`):
   `BrowserManager` reaps a session past `maxSessionMs` (wall-clock, even when
   active) and closes pages opened beyond `maxPages` per context; bin-set via
   `SACKVILLE_BROWSER_SESSION_MS`/`SACKVILLE_BROWSER_MAX_PAGES`, default no cap.
18. **On-demand screenshot step tool — operator-gated:** `PageDriver.screenshot()`
   captures a PNG to the `ArtifactStore` under an immutable indexed handle
   (`screenshot-s<n>`), returns a summary (handle/byteSize/contentType/fullPage),
   never inlines the image, and does NOT re-snapshot (refs preserved). MCP
   `browser_screenshot` is **off by default** (`allowScreenshots`) — a screenshot
   is unredactable pixels, so it is gated like the trace.zip; the run-artifact
   resource serves PNGs as a base64 blob (`image/png` → binary). Bin-wired via
   `SACKVILLE_BROWSER_ALLOW_SCREENSHOTS` (default off).
19. **Dialog gating — deny-by-default:** `PageDriver` installs a `page.on('dialog')`
   handler that **dismisses** alert/confirm/prompt/beforeunload by default (a
   `confirm` returns false, so a destructive flow gated behind it cannot proceed)
   and records each as a `DialogEvent {type, message(redacted), accepted}` drained
   onto the triggering step's `StepResult.dialogs`. Operator opt-in
   `BrowserGate.allowDialogs` flips to **accept**; bin-wired via
   `SACKVILLE_BROWSER_ALLOW_DIALOGS` (default off). Registering the handler overrides
   Playwright's auto-dismiss, so the page never hangs.
20. **Download gating — deny + opt-in quarantine:** `BrowserManager` creates contexts
   with `acceptDownloads:false` by default (Playwright **cancels** every download —
   race-free deny). An operator quarantine dir (`SACKVILLE_BROWSER_DOWNLOAD_DIR`)
   flips `acceptDownloads:true` and sets `PageDriver.downloadDir`; a started download
   is saved there under a **sanitized, indexed** name (`<n>-<basename>`, no traversal)
   and recorded as a `DownloadEvent {suggestedFilename(redacted), savedAs, byteSize,
   accepted}`. Surfaced by the race-free **`browser_downloads`** read tool
   (`collectDownloads(waitMs?)` awaits in-flight saves; optional bounded wait) —
   **metadata only, bytes never served** to the agent.
21. **Upload gating — confined to an operator allowlist dir:** `PageDriver.uploadFiles`
   (MCP `browser_upload`) sets files on a file-input ref but is **deny-by-default** —
   it requires an operator `uploadDir` and every requested path must resolve to
   within it (no `..` traversal, no absolute escape), throwing `GateError` otherwise.
   This is the exfiltration control: an agent cannot upload arbitrary local files
   (`~/.ssh/id_rsa`, `/etc/passwd`). Selecting a file makes no network request; the
   later submit is gated separately by the mutation gate. Bin-wired via
   `SACKVILLE_BROWSER_UPLOAD_DIR` (unset ⇒ uploads denied). **The downloads/uploads/
   dialog/auth gating bundle is now COMPLETE** (auth = origin-scoped `httpCredentials`).
22. **Human `sackville browser` CLI:** `@sackville-mcp/cli` gains `browser snapshot|audit|
   screenshot <url>` (`packages/cli/src/browser.ts`) — single-shot page inspection
   over the engine (navigate once + read; per-snapshot refs needn't outlive the
   process). Reuses the bin's egress boundary: a gated `BrowserManager` + **mandatory**
   `createSsrfProxy` (`--proxy-bypass-list=<-loopback>` + WebRTC arg); the typed
   host is auto-allowed (explicit operator intent) plus `--allow-host`; flags
   `--allow-private`/`--no-sandbox`/`--headed`/`--json`/`--out`/`--full-page`.
   `audit` exits 1 on a11y violations (CI-usable). Real-chromium CLI tests.
23. **Browser assertions — one assertion engine across pillars.** Factored a shared
   **`@sackville-mcp/assert`** package (the pillar-agnostic operator core: `AssertionOp` +
   `applyOp`, moved out of `@sackville-mcp/api`, which now consumes it — behavior-preserving,
   mirroring the `@sackville-mcp/safety` extraction). `@sackville-mcp/browser` `assertions.ts` +
   `PageDriver.assert(specs)` evaluate declarative assertions against the live page:
   sources `url`/`title`/`ariaSnapshot` (page) + `text`/`value`/`visible`/`count`
   (element, by `ref` or `role`+`name`), each **auto-waiting** via a fast poll
   (count-gated probes; the loop owns waiting, never Playwright's default timeout) up
   to its timeout — so a condition that becomes true after an async update still
   passes. Observed string values are redacted; `pass` reflects the true (raw) value.
   MCP `browser_assert` tool (free read) returns `{pass, results}`.
24. **`browser_trace_query` — trace.zip → action timeline.** `@sackville-mcp/browser`
   `trace.ts`/`queryTrace(zip, opts)` parses a captured Playwright trace.zip's `.trace`
   **JSONL directly** (no `npx playwright trace` subprocess — its `open` is a GUI
   viewer and there are NO `console`/`network`/`errors` subcommands; those live inside
   the trace). Pairs `before`/`after` events by `callId` into an **action timeline**
   (`api` = `class.method`, timing, error, optional params) + console + an errors list
   + `{playwrightVersion, browserName}`; filters `apiFilter`/`errorsOnly`/`limit`/
   `includeParams`. MCP `browser_trace_query` resolves the stored (already-redacted)
   trace by `runId` — **no live session needed** (query after close); errors actionably
   when trace capture was off. Schema probed against the 1.60.0 pin.
25. **`browser_perf_audit` — Lighthouse perf over the node API.** `@sackville-mcp/browser`
   `perf.ts`/`auditPerf(url, opts)` runs **Lighthouse 13.3.0** (`onlyCategories:
   ['performance']`) by launching its own Chrome via **`chrome-launcher`** at the
   operator chromium path + **operator-supplied flags** (the bin passes the mandatory
   SSRF proxy + loopback-bypass + WebRTC arg, so Lighthouse's navigation traverses the
   same egress boundary). Returns `{performanceScore, metrics[FCP/LCP/TBT/CLS/SI/TTI],
   lighthouseVersion}`; the full LHR **JSON + HTML** reports are stored by handle
   (`perf` / `perf-html`), **redacted before write**. MCP `browser_perf_audit` is
   standalone (mints its own `runId`, no session), **allowlist-gated** at the surface
   (`gate.checkNavigation`); the bin binds the real audit closure (absent ⇒ "not
   enabled"). Per ADR 0006 callers assert metric **shape/thresholds, never exact
   scores**. Feasibility + LHR shape probed against the pin.

26. **Network heavy mode — HAR capture** (`a6ead53` + `c6a5303`). New
   `@sackville-mcp/browser` `har.ts`: `finalizeHar` reads the HAR `.zip` Playwright
   writes on context close, redacts every text entry (`.har` JSON + persisted text
   bodies, via fflate) BEFORE surfacing, stores by
   `sackville://browser/run/<id>/har` handle, returns a compact summary
   (entryCount/byStatus/byMethod/byteSize), and removes the raw staged file.
   `BrowserManager` gains operator `harDir` → `recordHar` (content:'attach',
   mode:'full') at newContext, plus an **`onClosed`** hook firing AFTER
   `context.close()` (HAR is only on disk post-close — opposite timing to the
   recorder's `onReap`); shutdown fires it too. MCP surface: `onReap` now only
   flushes the recorder, `onClosed` finalizes the HAR + does registry cleanup, so
   the explicit close, idle reaper, and shutdown all finalize (no unredacted HAR
   lingers); `browser_close_session` surfaces the `har` handle/summary. Bin:
   `SACKVILLE_BROWSER_HAR_DIR`. HAR is a heavy secret surface (registered-secret
   redaction only) so capture is operator-gated **off** by default, like the trace.
27. **Network heavy mode — HAR replay** (`ca88685`). `PageDriver.replayFromHar`
   arms `page.routeFromHAR(notFound:'abort')` so a session is served from a recorded
   HAR instead of the network — deterministic offline runs, zero egress (unmatched
   requests aborted). **Deny-by-default**: requires an operator replay dir and the
   HAR must resolve within it (reuses `uploadFiles`' path confinement). MCP
   `browser_replay_har` (call before navigate). Bin:
   `SACKVILLE_BROWSER_REPLAY_HAR_DIR`. Real-chromium proof: record a HAR, shut the
   server down, replay → page still loads from the HAR. **Network heavy mode is now
   COMPLETE.**

28. **Persisted `.bru` browser-step flows** (`227263a`/`d7ad2a4`/`e23427e`; mirrors
   ADR 0004). New `@sackville-mcp/browser` `flow.ts`: a Bruno-openable `<name>.bru`
   (meta) + `<name>.sackville.yml` sidecar holding ordered `steps`, keyed by
   `SemanticLocator {role,name?,nth?}` (NOT ephemeral refs, so a flow is stable
   across runs). `loadFlow`/`loadFlowCollection` parse + validate (fail-loud);
   `runFlow(driver, flow, opts)` replays sequentially with `{{var}}` interpolation +
   fail-closed `{{secret:NAME}}` resolution (driver redactor scrubs cleartext;
   assert expected-values get vars only, never secrets — no cleartext `expected`
   leak). A step that throws stops the flow `ok:false`; a failed assertion fails the
   flow but continues. PageDriver gained semantic-locator action methods
   (`clickAt`/`fillAt`/`selectAt`/`pressAt`) driving via `getByRole` directly,
   reusing the same mutation gate; factored a shared `locatorFor()`; `waitFor` takes
   `nth`. Surfaced by **`sackville browser run <flow.bru>`** (`@sackville-mcp/cli`,
   --var/--unsafe/--allow-host/--json, exit-nonzero on failure, env-secret redaction)
   + bundled `examples/browser/login/` with an offline guard test.

29. **MCP `browser_run_flow` + `browser_list_flows`** (the deferred flow follow-up,
   so the agent surface reaches parity with `sackville browser run`). The agent passes
   a flow **name** (resolved against `loadFlowCollection(flowsDir)` — a Map-key lookup,
   so there is NO caller-supplied path / traversal surface) + non-secret `{{var}}`s;
   the flow replays on the named session's gated `PageDriver` behind the per-session
   mutex, so it composes with `browser_replay_har`/artifacts/close. `{{secret:NAME}}`
   resolves from the operator secret store (fail-closed); the driver redacts surfaced
   values and the surface additionally redacts step `error` strings. Deny-by-default:
   no operator flows dir ⇒ both tools report "not enabled". Bin: `SACKVILLE_BROWSER_
   FLOWS_DIR`. (TDD, real-chromium against the in-process fixture.) Both surfaces are
   documented side-by-side in `examples/browser/README.md` (CLI `sackville browser run`
   + the MCP `browser_list_flows`→`browser_run_flow` sequence over the login example).

30. **Video capture (webm) — operator-gated.** New `@sackville-mcp/browser` `video.ts`:
   `finalizeVideo` reads the `.webm` Playwright writes on context close, stores it by
   `sackville://browser/run/<id>/video` handle (NO redaction — video is unredactable
   pixels, so it is gated **off** by default like the trace/screenshots), returns a
   compact summary (`byteSize`/`video/webm`), and removes the temp recording.
   `BrowserManager` gains `videoDir`/`videoSize` → `recordVideo:{dir,size?}` per
   context; the MCP surface finalizes the video in the **same `onClosed` hook as the
   HAR** (resolved via `page.video().path()`, since Playwright auto-names the file —
   the HAR's deterministic `harPathFor` has no video analogue) and surfaces the
   `video` handle in `browser_close_session`; the run-artifact resource serves
   `video/*` as a base64 blob. Bin: `SACKVILLE_BROWSER_VIDEO_DIR` (+ `_VIDEO_WIDTH`/
   `_HEIGHT` size cap; the session wall-clock cap bounds duration). Real-chromium
   tested (asserts the EBML/webm container magic). **ffmpeg is present in the cache**
   (Playwright needs it for video). Operator enablement + the on-close `video` handle
   are documented in `examples/browser/README.md` ("Recording the run as video").

31. **Vision/coordinate caps — operator-gated.** `PageDriver.mouseClick(x,y)` /
   `mouseMove(x,y)` drive the raw pointer at a viewport CSS-pixel coordinate, for
   canvas / non-AX-tree UI the ARIA-snapshot path can't reach (coords come from a
   screenshot). `mouseClick` is a **mutation routed through the existing gate**
   (dry-run vs execute — distinct method name from the semantic-locator `clickAt`);
   `mouseMove` is non-mutating positioning (hover egress still governed by the
   always-on Tier-1 routes + SSRF proxy). MCP `browser_vision_click`/
   `browser_vision_move` are **off by default** (`allowVision`) — a blind click on a
   *point* sidesteps the accessible-tree safety story, so it is an explicit operator
   opt-in, **decoupled from `allowScreenshots`** (read-only pixels out vs blind input
   in). Bin: `SACKVILLE_BROWSER_ALLOW_VISION`. Real-chromium tested via a
   document-level coordinate recorder (execute lands the coord; locked gate ⇒ dryRun).

32. **Container-hardening ADR — `docs/decisions/0007-container-hardening.md`.**
   The deployment-security posture (the container/kernel boundary **behind** the
   in-process spine, for when a renderer RCE bypasses the documented-API defenses):
   keep the Chromium sandbox by default, resolving the sandbox-in-container tension
   via **unprivileged user namespaces** (so **no `SYS_ADMIN`**; `--no-sandbox` only a
   documented operator fallback); non-root + no-new-privileges; `cap_drop: ALL`; a
   default-derived **seccomp** profile pinned to the Playwright image; read-only
   rootfs + minimal tmpfs/volume mounts (incl. the `/dev/shm` footgun — `--shm-size`,
   **not** `--ipc=host`); **WebRTC + QUIC disabled**; container-level **egress
   firewalling** as defense-in-depth behind the SSRF proxy (metadata unreachable). A
   threat→boundary table maps each risk across the two layers. A **design doc** (no
   code/tests) — extends ADR 0006 §7's one-liner; referenced from ARCHITECTURE §10 +
   ROADMAP. The dev harness (`docker/`) stays separate (gitignored).

33. **Visual regression — `compareScreenshots` engine + `browser_visual_compare`.**
   `@sackville-mcp/browser` `visual.ts` (pixelmatch 7.2.0 + pngjs 7.0.0): a **pure,
   deterministic** pixel diff — diff count/ratio, `maxDiffPixelRatio`/`maxDiffPixels`
   budget, pixel-rect `mask[]` (dynamic regions), size-mismatch hard-fail, diff PNG.
   `PageDriver.screenshot()` gained stable-capture options (`animations:'disabled'`/
   `caret:'hide'`/`clip`). MCP `browser_visual_compare` (operator `baselineDir`,
   **deny-by-default**): captures the current page, diffs vs `<name>.png`, stores the
   diff PNG by `visual-diff-s<n>` handle on mismatch; `update:true` records a baseline
   (**separately** operator-gated `allowBaselineUpdate` — an agent can't rewrite the
   golden). Bin: `SACKVILLE_BROWSER_BASELINE_DIR` + `_ALLOW_BASELINE_UPDATE`. The
   flake-prone part — **committing** cross-platform baselines — is deferred (operator-
   managed, generated in the pinned Docker image keyed by name/browser/platform), so
   the green gate stays deterministic: tested with in-memory PNGs + a real-chromium
   **self-captured** baseline (nothing committed to the repo).

34. **Multi-engine (firefox/webkit) — operator-selected.** New `@sackville-mcp/browser`
   `engine.ts`: `resolveEngine` (default chromium, throws loud on a typo) +
   `engineLauncher`/`engineLaunchOptions`. The injected-`launch()` `BrowserManager`
   is unchanged (already engine-agnostic) — selection lives only at the launch seam.
   The Tier-2 SSRF **proxy applies to all engines** (`proxy.server`); the
   **chromium-only** hardening CLI args (`--proxy-bypass-list=<-loopback>`,
   `--force-webrtc-ip-handling-policy`, `--no-sandbox`) are emitted **only for
   chromium** (firefox/webkit reject them) — those engines lean on the always-on
   **Tier-1 route allowlist** + the proxy, so chromium stays the hardened default.
   Bin `SACKVILLE_BROWSER_ENGINE` (resolved early, before the proxy is allocated;
   `config.engine` + per-engine `launchArgs`); CLI `--engine chromium|firefox|webkit`
   (unknown ⇒ clean exit-1). **Lighthouse perf stays chromium** (Chrome-only),
   whatever the session engine. One engine per server instance. Cross-engine probe
   confirmed `serviceWorkers:'block'`/`httpCredentials`/`route`/`ariaSnapshot` are
   identical on firefox/webkit (manager + driver needed no changes). TDD: engine
   unit tests + a **real cross-engine** test driving navigate→snapshot→click→
   re-snapshot on firefox AND webkit (`skipIf` the binary is absent → chromium-only
   envs stay green); bin/CLI wiring tests. CI + the dev image install all three
   engines. (ADR 0009.)

**(Point-in-time at Phase-3 close: 390 TS + 45 Py green; the authoritative current
count is the one in the Phase-4 current-phase block at the top of this file.)** _(Latest milestone:
**multi-engine** (item 34, ADR 0009) — firefox/webkit support landed; Phase 3 is
now FEATURE-COMPLETE. On top of **Pillar 2 fully COMPLETE** (request-body matrix +
keyring wiring, SSRF range-block + redirect re-check, contract reach, import).
**Developer live-view was DROPPED** (ADR 0008, headless-only/LLM-first).)_
**Next action:** Phase 4 is underway (ADR 0010). `@sackville-mcp/deps` slices 1–4 (pure core:
`auditDeprecation`, `matchVulnerabilities`, `loadOsvSnapshot`, `auditDependency`) **and
slice 5 (the agent surface)** are landed: `audit_dependency` + `audit_project` MCP tools
(`packages/mcp/src/deps.ts`) + the `sackville-deps-mcp` bin (`bin-deps.ts`, namespaced
`SACKVILLE_DEPS_*`, network off by default, SSRF-pinned packument fetch via
`@sackville-mcp/safety` `resolveAndPin` — **note:** `assertSsrfAllowed` does NOT exist on
`safety`, only in the api package). **The shared `@sackville-mcp/artifacts` extraction is now
DONE** (parameterized `sackville://<prefix>/<id>/<kind>`; browser rewired as a thin
subclass, behavior-preserving), **and `changelog_diff` (the first handle-emitting deps
slice) is DONE**: pure `sliceChangelog` core + the `changelog_diff` MCP tool (injected
fetcher → slice → store by handle in `@sackville-mcp/artifacts` `deps` prefix → compact
summary) + the `sackville://deps/{id}/{kind}` resource + bin wiring
(`SACKVILLE_DEPS_ARTIFACT_DIR` + SSRF-pinned GitHub-raw CHANGELOG fetch), **and by-handle
full `audit_project` detail is DONE** (`detailHandle` → the `sackville://deps` resource),
**and the vuln-aware `minimumSafeUpgrade` target is DONE** (`auditDependency.minimumSafeUpgrade`:
lowest stable release newer than installed that re-matches ZERO advisories — re-evaluated
per candidate against the full set, so a release fixing the original vuln but hit by another
is skipped; distinct from the conservative same-major `recommendedTarget`; surfaced in
`audit_dependency` + the `audit_project` roll-up), **and the `behindBy` freshness metric is
DONE** (`FreshnessVerdict.behindBy`: upgrade distance by semver component), **and
CVSS-vector → bucket scoring is DONE** (pure `cvssV3BaseScore`; `matchVulnerabilities`
falls back to the CVSS vector's bucket when no qualitative GHSA string is present).
**Next for deps:** the staged **Python/PyPI + RubyGems advisory adapters** (the non-npm
ecosystems — `audit_project` is npm-only today; `detectInstalledVersion` already dispatches
by ecosystem). **Track A `@sackville-mcp/coverage` is open** — slices 1–3 landed (`uncoveredNewLines` differ,
`parseUnifiedDiff`, and the `uncoveredInDiff` integrator) — **the pure offline core of the
forgotten-assertion catch is complete**, **the live `runScoped` engine (slice 4)
landed**, **and the MCP surface + `sackville-coverage-mcp` bin landed** — so **the
`@sackville-mcp/coverage` pillar (engine + agent surface) is complete** (`uncovered_in_diff`
free/read-only + gated `run_scoped`). **Next for deps/coverage:** the staged
**Python/PyPI + RubyGems advisory adapters** (deps) and, optionally, a `sackville coverage`
human CLI / `istanbul-lib-coverage` for `CoverageMap` merging. **`@sackville-mcp/flake` is now
COMPLETE (engine + agent surface)** — the pure Wilson classifier (slice 1) + the private
better-sqlite3 `HistoryStore` (slice 2) + `parseVitestJson`/`ingestReport` (slice 3) + the
operator-gated `Quarantine` with mandatory expiry (slice 4) + the gated `runAndRecord`
vitest spawner (slice 5) + the MCP surface/`sackville-flake-mcp` bin (slice 6:
`flake_status`/`flake_candidates`/`flake_release` always on, `flake_run` + `flake_quarantine`
each behind their own paired gate). **`@sackville-mcp/mutate` is now COMPLETE (engine + agent
surface)** — the Stryker/Vitest-4 spike resolved (thin-wrap viable; Stryker injected, not a
gate dep), pure `summarizeMutation` over the mutation-testing-elements schema, the gated
diff-scoped `runMutation` (spawn `stryker run`), and the `mutate_summarize`/`mutate_run` MCP
surface + `sackville-mutate-mcp` bin.

**LAST Phase-4 candidate: `@sackville-mcp/lsp` — semantic code navigation. DESIGN DONE (ADR
0011); coding NOT started.** The design pass ran as the `lsp-bridge-design` fan-out (3
research streams → synthesis → 2 adversarial critics — the adversarial pass materially
reshaped it, ADR-0010 style). Locked decisions (full detail in **ADR 0011**): it is the
**documented, fenced exception** to ARCHITECTURE §1's no-live-RPC rule (the LSP subprocess
must never touch the docs SQLite; results ephemeral); the right analogy is the **browser
subprocess** (resident, code-executing → runs inside the ADR-0007 hardened container), NOT
the test-runner — `allowRun`+`allowedRoots` is load-bearing *because indexing executes
project code*; the **operator binds a JSON `language→{command,args[]}` registry**, the agent
picks only a *language*; **v1 reads-only**; the green gate uses a **fake in-process JSON-RPC
peer replaying recorded real-server payloads** (no real server in `pnpm gate` — a deliberate,
stricter posture than coverage/flake/mutate). The adversarial pass forced these into the
design: **position-encoding is the #1 silent-wrong trap** (a pure `toLspCharacter` for
utf-8/16/32 with non-BMP fixture tests; read back the negotiated `positionEncoding`, fail
loud on unsupported); **tri-state results** (ok / not_ready / no_result — never collapse
"still indexing" into "no definition"), one operator deadline with `$/progress`-gated retry
inside it; a **per-(server,uri) mutex** + open-once/refcount docs + in-flight-aware reaper;
**`serverInfo.version` provenance + v1 warn-on-toolchain-mismatch** (honoring "answer for the
installed version"); `vscode-jsonrpc` + `vscode-languageserver-protocol` as **explicit pins**
(the playwright-core pattern, not a hand-roll); **MVP = `lsp_find_definition`/
`lsp_find_references`/`lsp_hover`** (hover restored, call-hierarchy staged behind capability
detection). **`@sackville-mcp/lsp` slice 1 is LANDED:** the pure `encoding.ts`
(`toLspCharacter`/`fromLspCharacter` for utf-8/16/32 with non-BMP fixtures + cross-encoding
round-trip; `resolvePositionEncoding` fail-loud-on-unsupported; `toLspPosition`/
`fromLspPosition` with LF/CR/CRLF split + BOM strip) + `normalize.ts` (`normalizeLocations`
Location-vs-LocationLink, `normalizeHover`, `normalizeDocumentSymbols` hierarchical-vs-flat,
tri-state `decideStatus`) — no spawn/network, 31 tests, 605 TS + 45 Py green. **Slice 2 is
LANDED:** `client.ts` — the LSP JSON-RPC client over an injected `serverSpawn` seam
(`defaultServerSpawn` = real `child_process.spawn`). Handshake advertises
`positionEncodings:["utf-16","utf-8"]` → reads back the negotiated `positionEncoding`
(absent ⇒ spec-default utf-16) + `serverInfo` provenance + capabilities; sends `initialized`;
`ensureOpen` does `didOpen` full-text once, refcounted, **no `didClose` by default**;
navigation requests (`definition`/`references`/`hover`) are **capability-gated** (`LspUnsupportedError`)
and **tri-state** — empty-while-`$/progress`-indexing ⇒ `not_ready` (returned fast), empty-while-ready
⇒ `no_result`, with bounded backoff retry living strictly **inside the single operator deadline**
via the **injected clock** (`now`/`delay`; production never calls `setTimeout` directly except the
default `delay` seam); deadlock-safe `null` replies to inbound `workspace/configuration` (array of
null) / `window/workDoneProgress/create` / `client/{register,unregister}Capability`; results carry
`{serverInfo, encoding}`. `vscode-jsonrpc ^8.2.1` + `vscode-languageserver-protocol ^3.17.5` added
as **explicit pins** (method names via the protocol package's `*Request.method` constants; transport
imported from `vscode-jsonrpc/node.js` — the explicit `.js` subpath NodeNext-ESM requires for a
CJS-without-`exports` dep). Tested against a **fake in-process JSON-RPC peer** (paired
`PassThrough` duplex streams à la vscode-jsonrpc's TestDuplex) replaying **RECORDED real-server
payloads** captured out-of-gate from `typescript-language-server` 5.3.0 (definition returned as
a real `LocationLink[]`, references as `Location[]`, hover as `MarkupContent`, a genuine indexing
`$/progress` begin/end pair; provenance in `test/fixtures/README.md`). 13 client tests.
**Slice 3 is LANDED:** `registry.ts` — the operator-bound JSON `language→{command,args[],
initializationOptions?}` registry (`parseServerRegistry` fails loud on malformed config; `command`
+ `args[]` **structurally separate**, no `lang=cmd args;…` DSL the engine would re-split;
`resolveServer` refuses an unbound language, never spawning an unregistered server) + `manager.ts`
— `LanguageServerManager` keyed by `(language, projectRoot)`, **shared across MCP sessions** with a
longer idle TTL than browser's (15 min default), lazy spawn via the injected `serverSpawn` seam,
**`rootUri`/`workspaceFolders` pinned to the allowlisted `projectRoot`** (agent never supplies a
root; a root outside `allowedRoots` is refused **before any spawn**), a **per-`(server, uri)` async
mutex** (chained-promise locks) serializing the open+query critical section, and an
**in-flight-aware reaper** (`sweepIdle(nowMs)` never reaps `inFlight > 0`; resets the idle clock on
request start/end; reap = LSP `shutdown`→`exit` then a **clock-driven `delay` grace** before the
hard `connection.dispose()`/SIGKILL) + a production `startReaper(intervalMs)` trigger. The shared
fake-peer test harness was factored to `src/peer.ts` (test-only, not in the barrel/`dist`; gained
an `onInitialize` capture so the manager test asserts `rootUri` pinning). 10 registry + 8 manager
tests. **Slice 4 is LANDED:** the gated `query.ts` — `LspQueryEngine` mirroring coverage's
`runScoped`: the **paired deny-by-default gate** (`allowRun` + `allowedRoots` + the manager's
per-request deadline; `LspGateError`/`assertAllowed`; refuses + **never spawns** when denied),
**queried-file confinement to the project root** (no `..` traversal/absolute escape), human↔LSP
position mapping (`toLspPosition` on the way in with the negotiated `client.encoding`; result ranges
mapped **back** via `fromLspPosition` reading **each target file's own text** — a definition
legitimately lives in another file/dep — with a documented best-effort `+1` fallback flagged
`mapped:false` when a target is unreadable), **tri-state passthrough** (ok/not_ready/no_result, never
collapsed), and version provenance (`serverInfo` on every result + a `versionWarning` when the
server reports none; echoes optional caller-supplied `toolchain` provenance). 10 query tests; **646
TS + 45 Py green**. The richer **warn-on-toolchain-mismatch** heuristic (reusing
`core.detectInstalledVersion`) is deliberately staged to the surface (it has the `core` dep + is
genuinely per-server heuristic). **Slice 5 is LANDED — the `@sackville-mcp/lsp` pillar is COMPLETE
(engine + agent surface):** the MCP surface (`packages/mcp/src/lsp.ts`,
`registerLspTools`/`createLspServer`) + the `sackville-lsp-mcp` bin (`bin-lsp.ts`,
`buildLspServerFromEnv`). `lsp_find_definition`/`lsp_find_references`/`lsp_hover` are **gated as a
group** (registered only when `allowRun` + a non-empty root allowlist + a non-empty server registry
are all set — there is NO free-read tier, since every answer needs a live indexing daemon); the
always-on, no-spawn **`lsp_languages`** reports the bound languages + (once a server is live in-session)
its advertised capabilities + `serverInfo.version` via `manager.describe()` — **never** the
command/path. A long reference list is capped inline (head of 50) + the full list emitted **by handle**
via `@sackville-mcp/artifacts` (`lsp` prefix; `sackville://lsp/{id}/{kind}` resource, registered only when a
store is set). The surface is **pure wiring over an injected `query` + `describeServers`** (so the mcp
tests use stubs — no peer harness reach-in); the bin builds the real `LanguageServerManager` +
`LspQueryEngine` (the sole reader of `SACKVILLE_LSP_ALLOW_RUN`/`_PROJECT_ROOTS`/`_TIMEOUT_MS`/
`_SERVERS`(JSON)/`_ARTIFACT_DIR`/`_MAX_SERVERS`/`_IDLE_TTL_MS`; `bool`/`csv`/`num` helpers +
executable-tail guard; `startReaper`+SIGINT/SIGTERM `shutdown`), and wires the `toolchain` provenance
via `core.detectInstalledVersion` (language→toolchain map; the conservative v1 warn — full
mismatch heuristic still staged). 7 surface + 6 bin tests; **659 TS + 45 Py green**. **Next action:
Phase 4's pillars are DONE; the chosen next milestone is the cross-pillar PYTHON-ADAPTER tail (the
verification pillars are TS/npm-only today; `core.detectInstalledVersion` already dispatches
node/python/ruby). A fan-out research pass (4 parallel pillar-seam maps) found the pattern: every
pillar's pure core is ecosystem-agnostic; only the live RUNNER is JS-coupled — so a Python adapter is
a pure input-shape converter (+ optionally a sibling runner). Effort tiers: flake/coverage are
near-trivial pure converters; `deps` needs a pluggable `VersionComparator` (PEP 440 / Gem — semver is
hardcoded in ~7 funcs across `audit.ts`/`osv.ts`, the silent-wrong trap); mutate needs a
status-vocabulary conversion (mutmut). Sequence chosen: flake → coverage → deps → mutate.
**Slice 1 (flake pytest) DONE:** pure `parsePytestJson` in
`packages/flake/src/pytest.ts` (pytest-json-report `tests[]`→`RecordedRun[]`; `nodeid` is the stable
id verbatim — no reconstruction; per-phase seconds summed→`durationMs`; `error`→fail,
`skipped`/`xfailed`/`xpassed` dropped), `HistoryStore.ingestPytestReport`, and a NEW always-on,
format-discriminated **`flake_ingest`** MCP tool (vitest|pytest, no spawn — records a CI-produced
report; the only way to feed pytest history). Store/classifier/quarantine unchanged (test-id-opaque).
**Slice 2 (coverage.py) DONE, 674 TS + 45 Py green:** pure `fileCoverageFromCoveragePy`/
`coveragePyToIstanbul` in `packages/coverage/src/coveragepy.ts` (`coverage json` line lists →
istanbul `FileCoverage`: one synthetic single-line statement per executed/missing line, executed→hit
1, missing→0, excluded omitted→`nonExecutable`). The differ (`uncoveredInDiff`/`uncoveredNewLines`)
is unchanged (ecosystem-agnostic); `uncovered_in_diff` gained a `coverageFormat: istanbul|coveragepy`
discriminator so the Python path is agent-reachable.
**deps PyPI: DESIGN (ADR 0012) + slices 1-3 DONE, 693 TS + 45 Py green.** Fan-out design pass
(PEP440/Gem comparator libs + OSV/registry semantics + the call-site seam) → ADR 0012: pin
`@renovatebot/pep440` + `@renovatebot/ruby-semver` behind a pluggable `VersionComparator`,
hand-roll fallback documented; `changelog_diff` stays npm/semver-only; OSV `ECOSYSTEM` ranges
must use the ecosystem comparator (semver silently mis-coerces PEP440/Gem). **Slice 1:** the
`VersionComparator` seam (`comparator.ts` + `semverComparator`) threaded through `audit.ts`/`osv.ts`,
behavior-preserving for npm (the 46-test deps suite is the guard); `behindBy`/`latestSameMajor` now
derive from `releaseComponents()`. **Slice 2:** `pep440Comparator` (`pep440.ts`, on the pinned
`@renovatebot/pep440` — loads under tsc/tsdown/Vitest; `compare`→`Math.sign`) + PEP 440 canonical-
sequence conformance fixtures + OSV-PyPI range-scan tests (correct across the prerelease/epoch
boundary semver mis-handles). **Slice 3:** PyPI `audit_dependency` end-to-end — pure `pypiJsonToPackument`
+ PEP 503 `normalizePypiName` (`pypi.ts`), a per-ecosystem `COMPARATORS` map + `comparatorFor`/`matchName`
in `packages/mcp/src/deps.ts`, and a PyPI JSON-API packument fetcher in `bin-deps.ts`
(`SACKVILLE_DEPS_PYPI_REGISTRY`, default `https://pypi.org/pypi`). RubyGems stays unsupported (clear
error from `comparatorFor`); `audit_project` stays npm-only.
**Slice 4 (RubyGems audit_dependency) DONE, 704 TS + 45 Py green:** `gemComparator` (`gem.ts`, on
the pinned `@renovatebot/ruby-semver` — loads cleanly; no native `compare`/`clean`, so `compare`
derives from `eq`/`gt` and `clean` from `valid`) + Gem conformance fixtures; pure `rubygemsToPackument`
(`rubygems.ts`: RubyGems API versions array → `Packument`, no `dist-tags` so freshness derives latest
via gemComparator); wired into the `COMPARATORS` map (now total over all 3 ecosystems) + a RubyGems
API fetcher in `bin-deps.ts` (`SACKVILLE_DEPS_RUBYGEMS_REGISTRY`, default `https://rubygems.org/api/v1`).
**All three ecosystems now audit a single package end-to-end.**
**`mutate` (mutmut) DONE, 708 TS + 45 Py green:** pure `parseMutmutResults` (`mutmut.ts`) maps
`mutmut results --all true` text — captured from **real mutmut 3.5.0** (`<module>.x_<fn>__mutmut_<n>:
<status>`; fixture `packages/mutate/test/fixtures/mutmut-results.txt`) — into a `MutationReport`,
mapping the status vocabulary conservatively (suspicious→Survived, segfault→RuntimeError,
unknown→Pending) so the score is never overstated; `summarizeMutation` is reused unchanged.
`mutate_summarize` gained a `format: stryker|mutmut` discriminator (mutmut input = results text,
no spawn). **The Python-adapter milestone is functionally COMPLETE:** flake (pytest), coverage
(coverage.py), deps (PyPI+RubyGems `audit_dependency`), and mutate (mutmut) all ship engine + agent
surface; both new pins (`@renovatebot/pep440`, `@renovatebot/ruby-semver`) validated to load under
tsc/tsdown/Vitest.
**`audit_project` for PyPI + RubyGems DONE, 715 TS + 45 Py green:** pure `pythonManifestNames`
(`pypi.ts`: PEP 621 `[project]` deps + optional-dependencies, Poetry deps + group deps,
requirements.txt fallback; PEP 503-normalized + deduped) and `rubyManifestNames` (`rubygems.ts`:
Gemfile.lock `DEPENDENCIES` block — declared, not the resolved spec tree — else Gemfile `gem` lines);
`packages/mcp/src/deps.ts` dispatches the name reader by ecosystem (`dependencyNames`) and the
npm-only throw is lifted. **`audit_project` now rolls up all three ecosystems** (npm/PyPI/RubyGems);
`auditOne` already carried the per-ecosystem comparator + matchName from slice 3.
**LSP capability-gated read tails DONE, 728 TS + 45 Py green (ADR 0011):** `lsp_type_definition`
(reuses `normalizeLocations`), `lsp_document_symbols` (position-less; reuses the slice-1
`normalizeDocumentSymbols`; query engine gained a no-position path + recursive range mapping;
`line`/`column` now optional per kind), and `lsp_call_hierarchy` (two-round-trip `prepareCallHierarchy`
→ `incoming`/`outgoing`; new call-hierarchy normalizers; keeps all overloads; per-direction
`fromRanges` file attribution; the client now declares the `callHierarchy` capability). All gated as
part of the navigation group. Captured **fresh real `typescript-language-server` 5.3.0** payloads
(`type-definition-locations.json`, `call-hierarchy-{prepare,incoming,outgoing}.json`; the deterministic
gate still replays recorded payloads, NO real server in `pnpm gate`). The capture harness used an
extended greeter project (a free `hello()` that `greet()` calls); provenance in the fixtures README.
**LSP WRITE-MODE (`lsp_rename`) DONE, 797 TS + 45 Py green (ADR 0011 addendum, slices A–G):** the
first WRITE surface. **Dry-run by default**; applies to disk only behind a SEPARATE operator gate
`SACKVILLE_LSP_ALLOW_WRITE` that is enforced to REQUIRE `allowRun` (hard bin-startup error otherwise).
Design via the `lsp-write-mode-design` fan-out (3 research → synthesis → 2 adversarial critics →
corrected contract, appended to ADR 0011); the adversarial pass caught real corruption/confinement
holes (all folded). Slices: **A** pure `apply.ts` (`lspPositionToOffset` raw-terminator/CRLF-faithful
JS-offset walker + `applyTextEdits` distinct-start/overlap-throw/descending-splice + `isPlausibleRenameName`)
· **B** pure `normalizeWorkspaceEdit` (changes vs documentChanges, resource-ops flagged, annotations
carried) — the captured fixture FLIPPED the design assumption: real tsserver 5.3.0 returns the legacy
`changes` map (not `documentChanges`) + a bare-Range `prepareRename` + NO resource ops · **C** shared
realpath-hardened write-confinement (`confine.ts`; symlink-escape closed, non-`file://` refused,
confine-all-before-I/O) · **D** `client.rename`/`prepareRename` + the `textDocument.rename`/
`workspace.workspaceEdit` handshake caps (object-form `renameProvider{prepareProvider}`) · **E**
`client.applyEdited` full-text `didChange` doc-sync + open-map refcount→`{refs,version}` (strictly
increasing) + inbound `workspace/applyEdit` deadlock guard · **F** `LspRenameEngine` single-file
(dry-run preview with offset-faithful redacted hunks; gated apply: hash-drift refuse → `applyTextEdits`
→ stage-then-commit writer seam → post-write `didChange`; SHA-256 digests) · **F′**
`manager.runWithUris` (sorted multi-URI lock, deadlock-free) → atomic MULTI-FILE apply (confine-all,
old-identifier staleness guard, stage-then-commit-all) · **G** the `lsp_rename` MCP tool (no `write`
input — apply is the engine's internal decision; large edit sets by handle) + bin wiring. Fixtures
captured from real `typescript-language-server` 5.3.0 (out-of-gate; gate replays recorded payloads, NO
real server). Independent golden-file byte assertion (not `applyTextEdits` output) guards the writer.
**HUMAN VERIFICATION CLIs DONE, 839 TS + 45 Py green:** all five Phase-4 pillars now have a
`sackville <pillar>` subcommand in `@sackville-mcp/cli`, each a thin human wrapper over its engine
mirroring the `api`/`browser` CLI pattern (the human IS the operator, so run/write gates are
straight-through flags like `api`'s `--unsafe`, the typed root/host is auto-allowed, and the
engine runner/fetcher is **injectable** so the suite never spawns/fetches — ADR 0010
no-real-spawn-in-gate): **`mutate`** (`summarize` stryker|mutmut + gated `run`); **`coverage`**
(`uncovered-in-diff` istanbul|coveragepy + gated `run-scoped`; exit 1 when a new line is uncovered);
**`flake`** (always-on `status`/`candidates`/`ingest`/`release` over `--db`; gated `run` +
`quarantine`, the two paired gates as flags); **`deps`** (`audit`/`audit-project`/`changelog`; exit
1 on a security/deprecation finding; reports `osvSnapshotLoaded`); and **`lsp`** (single-shot
`languages`/`definition`/`type-definition`/`references`/`hover`/`symbols`/`call-hierarchy` + write-mode
`rename`, dry-run unless `--allow-write`; `--allow-run` + `--servers`(JSON registry) + `--project`
allowlist; the engine is injectable so the gate never spawns a real server — production builds the
real manager/engine per invocation and shuts it down; exit 2 = `not_ready`; ships
`examples/lsp/greeter` — a tiny runnable TS project + an offline coordinate guard). The deps CLI forced a
**behavior-preserving refactor**: the pure ecosystem-dispatch helpers (`comparatorFor`/`matchName`/
`dependencyNames` + `OsvEcosystem`/`OSV_ECOSYSTEMS`) were lifted out of `packages/mcp/src/deps.ts`
into a new `@sackville-mcp/deps` `ecosystem.ts` (one source of truth, shared by the MCP surface + the
CLI; the surface rewires to import them, guarded by the 90-test deps+mcp suite); the CLI builds its
own SSRF-pinned packument/changelog fetcher from `@sackville-mcp/safety` `resolveAndPin` (the established
per-surface pattern; private registries gated by `--allow-private`). The `lsp` CLI followed the MCP
surface's stub pattern (inject `query`/`rename`/`describeServers` for success paths; the gate-refusal
path uses the real build, where `assertAllowed` throws before any spawn — so no real server in the
gate, ADR 0011). 41 new CLI tests across five files (`mutate`/`coverage`/`flake`/`deps`/`lsp`).
**LSP COLD-PROJECT-LOAD FIX DONE, 842 TS + 45 Py green:** running the new `examples/lsp/greeter`
live (typescript-language-server 5.3.0) caught a real bug — tsserver answers an early request from
a single-file **inferred** project (a non-empty BUT partial result) while still loading the
configured `tsconfig` project, and the client's `withRetry` trusted any non-empty result as `ok`
(so a cold cross-file `references`/`rename` saw only the opened file — e.g. renaming `Greeter`
missed its `index.ts` usages). A live capture proved the `$/progress` timeline. Fixed in
`client.ts` `withRetry`: a result returned **while indexing is active is untrusted** — wait out the
project-load `$/progress` (event-driven on the `end`, injected-`delay` deadline backstop) before
trusting/returning, and re-query if the send itself triggered the load. Traded "return `not_ready`
fast" for "wait for the correct answer within the deadline" (bounded). Applies to all withRetry
paths (definition/references/hover/symbols/prepareRename/rename). Verified live: cold
`references`/`rename` on `Greeter` now return the full cross-file set (3 locs / 3 edits across 2
files). The example README + the `sackville-lsp-cold-single-shot` memory updated to reflect the fix.
**LSP `workspace/symbol` SEARCH DONE, 861 TS + 45 Py green (ADR 0011 staged tail):** project-wide
symbol search by name — the first file-less, position-less navigation. Slices, all TDD: pure
`normalizeWorkspaceSymbols` (flat `SymbolInformation[]` with `location.range` AND the uri-only LSP
3.17 `WorkspaceSymbol` shape — range omitted, never crashes) over a **recorded real
`typescript-language-server` 5.3.0** `workspace/symbol` payload (`workspace-symbols.json`, captured
out-of-gate against the greeter; provenance in the fixtures README); `client.workspaceSymbols(query)`
(capability-gated on `workspaceSymbolProvider`, tri-state via `withRetry` so a still-indexing empty
is `not_ready`; advertises the `workspace.symbol` client cap, NO `resolveSupport` so the server
returns full ranges); a new `'workspaceSymbol'` `LspQueryKind` (file-less path via
`manager.runWithUris([])`, cross-file ranges mapped per target file); `manager` reports the
`workspaceSymbol` capability in `describe()`; the gated `lsp_workspace_symbols` MCP tool (navigation
group; large lists by handle) + `sackville lsp workspace-symbols <language> <query> [anchorFile]` CLI.
**Live run caught a real bug (the cold-load lesson again):** tsserver only builds a project once a
file is open, so a file-less `workspace/symbol` errors "No Project" — fixed by an OPTIONAL anchor
`file` that the engine opens first to establish the project (eager indexers gopls/rust-analyzer
don't need it). Verified live: `Greeter` returns the const + class with correctly mapped human
ranges; file-less surfaces the honest "No Project" error. Greeter + CLI READMEs document the anchor.
**LSP `diagnostics` DONE, 876 TS + 45 Py green (ADR 0011 staged tail):** errors/warnings for a file
via the **PUSH model** — `textDocument/publishDiagnostics` is a server NOTIFICATION, not a request
(tsserver advertises no `diagnosticProvider`, so the LSP 3.17 pull `textDocument/diagnostic` is
unavailable; pull is staged). Slices, all TDD: pure `normalizeDiagnostics` (severity/tag names,
numeric|string `code`, `source`, `relatedInformation`) over a **recorded real
`typescript-language-server` 5.3.0** `publishDiagnostics` payload (`diagnostics-publish.json`,
captured out-of-gate by temporarily adding a type error to `index.ts`); `client.documentDiagnostics`
(NOT capability-gated — push has no provider; accumulates pushed diagnostics per-uri, marks a fresh
`didOpen` as awaiting-first-publish, waits out the project-load `$/progress` then returns the
post-settle publish — empty = clean `ok`, never `no_result`; no publish/never-settles = `not_ready`);
a `'diagnostics'` `LspQueryKind` (file-based, position-less; ranges + relatedInformation mapped to
human coords); the gated `lsp_diagnostics` MCP tool (nav group; large lists by handle) + `sackville
lsp diagnostics <language> <file>` CLI. **The readiness model was grounded in the captured timeline,
not guessed** — `didOpen` → `$/progress` begin/end → publish ~60ms AFTER the project loads. Gate
determinism: push diagnostics arrive as async stream I/O, which the instant injected test-clock would
race ahead of, so the "ok" paths use a real timer (publish lands in ~1ms) while `not_ready` stays on
the clock. Verified live: a clean file → 0 diagnostics; an introduced type error → the 2322 error +
a 6133 unused-var hint (both severities + human-mapped ranges).
**LSP multi-ROOT DONE, 887 TS + 45 Py green (ADR 0011 staged tail):** one language server bound to
MULTIPLE `workspaceFolders` (a monorepo of packages) so cross-root navigation resolves through one
server. **Additive + opt-in** so single-root behavior is byte-identical. Slices, all TDD:
`client.initialize` accepts `workspaceFolders[]` (default the single `[{rootUri,'root'}]`); the
**manager keys a server by the sorted, de-duplicated root GROUP** (`(language, NUL-joined roots)` —
a single-root key is the lone root, unchanged; `A+[B]` and `B+[A]` share one server; `A` alone stays
distinct), `assertRootAllowed`s EVERY group root before any spawn, inits all as `workspaceFolders`
(rootUri = first sorted root), and `describe()` reports `roots[]` for a multi-root server; the query
engine threads `LspQueryInput.workspaceRoots[]` (each paired-gated) and confines the queried file to
the primary `projectRoot`; the MCP nav tools gained an optional `workspaceRoots` input (a nav-only
`navSchema` — `lsp_rename` deliberately does NOT expose it, write-path multi-root is staged and its
confinement is single-root) and `sackville lsp` gained a repeatable `--workspace-root` (the human is
the operator, so passing a root authorizes it → joins the allowlist). **Verified live against real
tsserver:** the multi-folder `initialize` is accepted, a query confined to a non-primary root is
served by the multi-root server, and cross-root **definition** (b→a) resolves. **Honest nuance
(found live):** cross-root **references** depend on the server's indexing model — eager indexers
(gopls/rust-analyzer) cover all folders, but tsserver loads a folder's project lazily on file open,
so its reference search only spans roots whose files have been touched (documented in the greeter
README). **Remaining non-blocking tails:** recursive/dir delete (kept refused-by-design — the
least-reversible op) + the FULL toolchain cross-version resolution matrix (the conservative scaffold
shipped); mutate cosmic-ray/`runMutmut` spawner; deps `changelog_diff` for PyPI/RubyGems. _(DONE
since: the **destructive `overwrite` resource-op** (ADR 0011 addendum — gated truncate-and-replace,
2 blockers caught by the design fan-out, +20 TS tests → 988); LSP
pull-diagnostics, dynamic `didChangeWorkspaceFolders` — grow-only warm-server reuse — and the **LSP
Python adapter** (pyright as a third real server: recorded payloads in the gate + the
`examples/lsp/pygreeter` quickstart; no engine code — the engine is language-agnostic, verified live.
**Documented pyright limitation (found via a follow-up deep-dive): `references` AND `rename` are
open-files-scoped, so a pyright cross-file rename can be silently INCOMPLETE on a real project — an
anchor file does not fix it.** **GUARD SHIPPED:** `lsp_rename` now runs a server-agnostic
partial-rename completeness guard — it scans the allowlisted root group for same-language files
mentioning the old identifier that the edit does NOT cover; a `suspect` verdict is surfaced in the
dry-run preview AND **refuses the WRITE deny-by-default** (overridable by the operator-only
`allowPartialRename` / `--allow-partial-rename` / `SACKVILLE_LSP_ALLOW_PARTIAL_RENAME`). Verified
live: a 60-importer pyright project refuses the partial write (nothing lost), the override applies,
and complete renames (tiny pygreeter, tsserver greeter) are NOT false-flagged.)_
**NEXT MILESTONE is again open** — a Phase-5 boundary or one of these tails.
**LSP staged tails (ADR 0011, not amputated):** `lsp_type_definition`/`lsp_document_symbols`/
`lsp_call_hierarchy` (DONE); write-mode (`rename`, DONE — slices A–G); `workspace/symbol` search
(DONE — `lsp_workspace_symbols` + CLI, optional anchor file); `diagnostics` (DONE — push-model
`lsp_diagnostics` + CLI; pull-diagnostics `textDocument/diagnostic` still staged); multi-ROOT
(DONE — `workspaceRoots[]` / `--workspace-root`, server keyed by the sorted root group); dynamic
`didChangeWorkspaceFolders` (DONE — grow-only warm-server reuse, capability-gated, live-verified vs
rust-analyzer); then
the full toolchain-version-resolution matrix (the richer warn-on-mismatch),
write-mode resource-ops + multi-file conflict reconciliation, and a Python adapter posture. **Other
Phase-4 staged tails:** `istanbul-lib-coverage` `CoverageMap` merging; a Python `run_scoped` (pytest
--cov) sibling; mutate cosmic-ray adapter + gated `runMutmut` spawner. (The deps PyPI/RubyGems
adapters, the flake pytest + coverage.py adapters, the mutate mutmut adapter, the human `sackville lsp`
CLI, AND all five human verification CLIs are now DONE.)
Phase 3
has no remaining required tail — only the explicitly-aspirational bucket
(`@playwright/mcp` embed, autonomous self-healing, cross-pillar contract tie-in). The
deferred `browser_run_flow`
follow-up (item 29), **video capture** (item 30), **vision/coordinate caps** (item
31), the **container-hardening ADR** (item 32, ADR 0007), and **visual regression**
(item 33) are now done. See the detailed "Next action" section below + ROADMAP.

**Phase 2 — Web API testing pillar: core deliverables COMPLETE** (engine +
contract validation + MCP tools + CLI all shipped & CI-gated; only optional tail
items remain). **Pillar 1 (docs/idioms) is functionally complete _and all its
deferred polish is done_** (non-Node version detection, TOC-bleed/symbol
ingestion refinements, Dash docset adapter). Pillar 2 design is locked (ADR 0004
+ 0005 + ARCHITECTURE §9, grounded by a 4-stream research workflow archived in
`docs/research/2026-05-31-pillar2-api-testing.md`).

**`@sackville-mcp/api` so far (TDD, offline tests):**
- Loads Bruno `.bru` + `*.sackville.yml` sidecar; var interpolation; **undici**
  runner; declarative assertions (status/jsonpath/header); body by
  `sackville://run/<id>/body` handle.
- **Secrets:** `{{secret:NAME}}` resolved at the transport boundary from a
  `SecretStore` (`StaticSecretStore`/`EnvSecretStore`/`KeyringSecretStore`-lazy/
  `ChainedSecretStore`); **fails closed** on a missing secret; a `Redactor`
  scrubs values + base64/url encodings from request/headers/body before anything
  reaches the agent.
- **Mutation safety:** GET/HEAD/OPTIONS run; POST/PUT/PATCH/DELETE **dry-run** by
  default and only send with `allowUnsafe` + a host allowlist (`checkGate`).
- **Captures + chaining:** sidecar `captures` extract values from a response
  (`extractCaptures`); `runSequence` threads them into later requests' scope.
- **Request bodies (full matrix):** `.bru` `body:json/text/xml/sparql` (raw),
  `form-urlencoded`, **graphql** (`{query, variables}` JSON envelope — variables
  interpolated then JSON-parsed; empty block omitted), **multipart-form** (text +
  file parts via undici `FormData`, file bytes read from disk, undici mints the
  boundary), and **file** (raw bytes under the declared content-type). All sent
  via undici; vars/secrets interpolated in every part; the agent-facing preview
  summarizes file/binary parts by name + byte size (never inlines bytes) and is
  redacted. File paths resolve against the collection dir (operator-authored
  config; egress separately gated, so not sandboxed). _(Closed a latent graphql
  gap + an uncaught `formUrlEncoded`/`multipartForm` camelCase-discriminator
  regression via an alias map; `PreparedBody.content` is now
  `string | Buffer | FormData` with a separate redaction-safe `preview`.)_
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
  - **MCP** (`sackville` `registerApiTools`/`createApiServer`, new
    `sackville-api-mcp` bin): tools `list_requests`, `get_request` (reports
    required secret **names** only, never values), `run_request`, `run_collection`,
    `validate_response` (OpenAPI or GraphQL), + `sackville://run/{runId}/body`
    resource over a shared `ArtifactStore`. **`allowUnsafe`/`allowedHosts` are
    operator-set via `ApiToolsOptions` (env on the bin), never agent inputs** —
    the safety gate can't be self-authorized.
  - **CLI** (`sackville api …`): `list`, `get`, `run` (`--var k=v`, `--env`,
    `--unsafe`, `--allow-host`, `--openapi <spec>` for live response validation,
    `--json`), `run-collection` (`--stop-on-failure`), `validate --graphql
    <schema> --query <q>` (offline drift). Exit 0 only when sent + assertions
    pass (+ contract valid when checked).
- A runnable sample collection (`examples/api/jsonplaceholder`) + an API-testing
  quickstart in `packages/cli/README.md`; an offline guard test keeps the sample
  in sync with the `.bru` format.
- **127 TS + 45 Py tests** (1 skipped real-embed), all green. Contract validators
  adversarially verified; both API bins smoke-tested end-to-end.

**Pillar 2 tail: COMPLETE.** All previously-deferred items have landed:
- **Keyring** secret store wired into both surfaces (CLI `--keyring`, MCP
  `SACKVILLE_KEYRING`; chains the OS keyring ahead of `SACKVILLE_SECRET_<NAME>`).
- **SSRF range-block** on every request (`assertSsrfAllowed` via `@sackville-mcp/safety`
  `resolveAndPin`; metadata/link-local always refused, loopback/private gated by
  `allowPrivate` — default permissive, `SACKVILLE_BLOCK_PRIVATE` / `--block-private`
  to harden) **+ opt-in redirect following** (`maxRedirects`) re-checking SSRF +
  the mutation allowlist + stripping credential headers on a host change.
- **Contract reach** (ADR 0005): external local-file `$ref` deref (JSON+YAML,
  cycle-guarded; remote http stays out — SSRF), OpenAPI 3.0 `nullable` shim,
  `operationName`-scoped GraphQL.
- **Import**: Postman/Insomnia/OpenAPI/HAR → `.bru` (`import.ts`, native + CLI
  `api import`). The only remaining body types are the request-body matrix, which
  is also COMPLETE (graphql/multipart-form/file; form-urlencoded regression fixed).

Remaining ADR-0005-documented out-of-scope (not blocking): remote (http) `$ref`
deref; non-schema `$ref`s; ajv `strict:false`. Import defers multipart/file
bodies + non-header auth.

Decided (ADR 0004): new pure-TS **`@sackville-mcp/api`** package; **Bruno `.bru`** +
thin model (via `@usebruno/lang`); Sackville assertions/captures in a **sidecar
`*.sackville.yml`**; **deny-by-default** mutation safety (dry-run + allowlist +
`--unsafe`); secrets via `@napi-rs/keyring` + env fallback, value-redacted;
**QuickJS-sandboxed** JS scripts in v1. Engine: **undici 8**.

## Milestone log (historical)

> Pillar-by-pillar history. The **authoritative current state + test counts** are
> in the top block above; test counts in these bullets are point-in-time.

- Decisions locked (see ADR 0001 + ARCHITECTURE.md §7): **Sackville**, polyglot
  core, headless MCP+CLI, docs pillar first, **bge-small-en-v1.5 / 384-dim**
  embeddings, **React 19** first corpus, license posture local-index-only.
- Design grounded by a 6-stream research workflow → `ARCHITECTURE.md` (exact
  stack/versions, the SQLite contract, MCP tool shapes). Raw research archived in
  `docs/research/2026-05-31-design-research.md`.
- **Monorepo scaffolded and 100% green:** pnpm workspace + `@sackville-mcp/core` (TS;
  better-sqlite3 + sqlite-vec, Biome, Vitest, tsdown) and `py/sackville_ingest`
  (uv; Ruff, pytest). `pnpm gate` runs both toolchains.
- **Polyglot boundary proven (red→green):** Python builds `fixtures/golden.sqlite`
  (schema + FTS5 + vec0 float[384]); TS `openDb`/`searchDocs`/`getDoc` reads it,
  asserts the schema contract, finds `react/useState` via FTS with no
  cross-library leakage. sqlite-vec verified on **both** runtimes.
- **`sackville` shipped:** MCP server (SDK 1.29) over `core` exposing
  `search_docs` (compact + `resourceUri`), `get_doc` (full body), and the
  `sackville://doc/{id}` resource. License: **Apache-2.0** (ADR 0002).
- **Real React 19.2 ingestion working end to end:** DevDocs adapter (`react`
  slug = 19.2, CC-BY-4.0) → section chunking (`extract`) → type normalization
  (`types_map`) → bge-small embeddings (`embed`) → SQLite (`build`), driven by
  `sackville-ingest build --slug react`. Produced a **1,279-fragment** index
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
- **`@sackville-mcp/cli` shipped:** `sackville search|get|versions|detect` over `core`
  (hybrid via `@sackville-mcp/embed`, `--json`, version flags). The query embedder was
  extracted into **`@sackville-mcp/embed`** (transformers.js, dynamic import) shared
  by cli + mcp.
- **CI gate:** `.github/workflows/ci.yml` mirrors `pnpm gate` (both toolchains)
  on push/PR.
- Dev container provisions pnpm + uv. **39 TS + 36 Py tests** (1 skipped real
  embed), all green. **Pillar 1 (docs/idioms) is functionally complete.**

## Next action

> **The LIVE current phase + next action are in the top block of this file** ("Current
> phase" above) — Phase 5 is COMPLETE (5a–5f) and the contract pillar has since been
> deepened through ADR 0016 (request body/param validation, GraphQL variables, the full
> non-scalar param array+object serialization matrix, slice 8). **The only remaining ADR
> 0016 tail is non-JSON request BODY schemas.** Everything below in this section is retained
> as **Phase 3/4 historical context** and is no longer "current".
>
> _(historical, 2026-06-03)_ Phase 4 is COMPLETE (all five pillars: engine + agent surface + CLI),
> and the Python adapters + LSP capability-gated reads + LSP write-mode (`lsp_rename`, incl. multi-root
> AND resource ops) + the LSP tails (cold-load fix, `workspace/symbol`, push- AND pull-`diagnostics`,
> multi-root nav, resource-op safe-subset cuts) all landed. **Latest: LSP PULL-diagnostics**
> (`textDocument/diagnostic`) — `documentDiagnostics(uri)` dispatches by capability: PULL (a
> deterministic request/response) when the server advertises `diagnosticProvider` (rust-analyzer),
> else the existing PUSH model (tsserver). Capability-gated `client.pullDiagnostics` echoes the
> provider `identifier`, tri-state with the diagnostics rule that an empty `full` report is `ok`
> (clean), maps a soft `ContentModified`-class error to backoff-retry → not_ready; same result shape
> as push so the query/MCP/CLI surface is unchanged. Verified live vs rust-analyzer 0.3.2921
> (`sackville lsp diagnostics rust` → ok/0 — and since RA does not push in the no-cargo config, `ok`
> proves the pull path ran). **Prior: LSP resource-op SAFE-SUBSET v1 cuts** (operator chose the safe subset).
> Two slices, TDD: (A) `ignoreIfExists`/`ignoreIfNotExists` are now conditional NO-OPS (not blanket-
> refused — `hasNonDefaultOptions`→`hasRefusedOptions`, only `overwrite`/recursive stay refused); (B)
> editing a file that is ALSO renamed/deleted in the same batch now APPLIES — `applyEdit`'s replay was
> rewritten onto a per-file `Fate` VFS keyed by the ORIGINAL uri so content flows THROUGH a rename
> (rename(A→B)+edit(B) import fix-up, and edit(A)+rename(A→B), both write the edited content to the
> final path in documentChanges order; create+delete net-no-ops drop out). One ordered
> write/rename/delete physical plan with a shared digest index per op (edited-AND-renamed = rename+write
> sharing ONE audit row); resync derives bytes from what ACTUALLY landed (pristine on a partial commit)
> and migrates the open buffer only when the rename landed; genuinely conflicting batches are REFUSED
> not reconciled (rename cycle, two-into-one, edit-of-renamed-away-path, delete-of-a-rename/create-target
> = a data-loss guard). Designed via the `lsp-resource-op-safe-cuts-design` fan-out (2 proposals →
> synthesis → 3 adversarial critics, five holes folded in) + a recall-biased review fan-out (trimmed a
> migrate-on-write-without-rename resync branch + an O(n²) order scan). Fixture-only gate (no real
> server) — but **verified LIVE against rust-analyzer 0.3.2921**: a module rename (`mod greeter`→
> `welcome`) applied cross-file edits + the `RenameFile` to disk, AND the editing-a-renamed-file case
> (a `crate::greeter::` self-reference in the module file) applied with the moved `welcome.rs` carrying
> the EDITED content — the exact batch the old code refused (repro + the 30s-deadline gotcha in
> [[sackville-lsp-rust-analyzer]]). **988 TS + 45 Py green, Biome zero-warning, pushed.** No required work remains. **Remaining
> staged (non-blocking) LSP tails:** recursive/dir delete (kept refused-by-design); the FULL toolchain
> cross-version resolution matrix. _(DONE since: the **destructive `overwrite` resource-op** (ADR 0011
> addendum — gated truncate-and-replace + conservative toolchain-mismatch warning); the **LSP Python
> adapter** — pyright as a third real server, gate replays recorded `pyright-langserver` 1.1.410
> payloads + the `examples/lsp/pygreeter` quickstart; the engine is language-agnostic so NO engine
> code, verified live. **Documented pyright limitation (deep-dived after a follow-up question): both
> `references` AND `rename` are open-files-scoped — a pyright cross-file rename can be silently
> INCOMPLETE on a real project (62-file repro renamed only the declaration); an anchor file does not
> fix it. GUARD SHIPPED — `lsp_rename` now scans for same-language files mentioning the old name
> that the edit misses; a `suspect` verdict refuses the WRITE deny-by-default (operator override
> `allowPartialRename`); verified live (60-importer pyright refused, complete renames not flagged).** See
> [[sackville-lsp-pyright]]. And dynamic `didChangeWorkspaceFolders` — grow-only warm-server reuse: a query whose root group
> is a SUPERSET of a warm same-language server's folders extends that server in place via
> `workspace/didChangeWorkspaceFolders` + re-keys it (capability-gated on
> `workspaceFolders.changeNotifications`; ambiguous-tie/no-cap ⇒ spawn fresh; grow-only, never shrinks;
> allowlist + write-mode confinement unchanged), live-verified vs rust-analyzer 0.3.2921.)_ Other
> Phase-4 tails: `deps` changelog_diff for PyPI/RubyGems; `mutate` cosmic-ray + `runMutmut`. Or open
> Phase 5 (needs a design-pass/ADR first). The detailed historical slice log follows.

**Phase 3, Slice 1 (a11y-audit summarizer): DONE & committed** (`@sackville-mcp/browser`
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
ref-ids in `ariaSnapshot()`, so Sackville parses the public `ariaSnapshot()` YAML
and **mints its own ref-ids** → semantic-locator descriptors `{role,name,nth}`
(per-snapshot, non-persisted), token-capped serialize + full-snapshot handle +
ref-independent diff. (See ADR 0006 update 2026-06-01.)

**Slice 4 (imperative step tools): DONE.** `PageDriver` (`driver.ts`) — navigate,
click, fill, fillForm, selectOption, press, waitFor, snapshot, and free reads
(getText/getValue/getAttribute). Refs resolve via the snapshot descriptors to
`getByRole(role,{name}).nth(n)` with auto-waiting; each navigating/mutating step
re-captures under a new snapshot **generation** (refs like `s2e3`) and returns a
scoped diff + capped snapshot + handle, so a stale ref from an earlier snapshot
**fails loudly** instead of matching a different element. Real-chromium tested
against an in-process fixture (fill/click/select/press/wait_for/stale-ref).
**155 TS + 45 Py green.**

This completes a usable interaction unit (lifecycle + snapshot + step tools) —
slices 2–4 pushed to `main`.

**Slice 5 (deny-by-default action gate): DONE.** `BrowserGate` (`gate.ts`,
operator-set `{allowUnsafe, allowedHosts}`) + `PageDriver` wiring: reads free;
`navigate` gated by host allowlist (`checkNavigation` → `GateError`); mutating
interactions (click/fill/fillForm/selectOption/press) **dry-run by default** — a
one-shot `page.route` captures + aborts the first would-be request and returns a
`{dryRun, wouldRequest}` preview — and **execute** only with `allowUnsafe` + an
allowlisted current host (hard-deny otherwise). Gate omitted ⇒ raw ungated layer
(the MCP surface always supplies one). Pure policy tests + chromium integration
(navigate allow/deny, dry-run captures+blocks a POST, execute sends it). **161 TS
+ 45 Py green.** Committed to `main`; **not yet pushed** — push after the SSRF
slice rounds out the safety story.

**Slice 6 (`@sackville-mcp/safety` + Tier-1 SSRF): DONE.** New shared **`@sackville-mcp/safety`**
package (factored per ADR 0006): SSRF range classifier (`isBlockedIp`/
`isBlockedHost`/`isBlockedHostLiteral` via `ipaddr.js`, fail-closed) +
`resolveAndPin` (DNS resolve → refuse blocked range → pinned IP, the Tier-2
decision core) + the `Redactor` (moved from `@sackville-mcp/api`, re-exported there —
behavior-preserving). **Tier-1** `installSafetyRoutes` (deny-by-default
`browserContext.route`, wired into `BrowserManager` when a gate is set) governs
every request and is **allowlist-authoritative** (ADR 0006 update 2026-06-01:
literals blocked by deny-by-default rather than unconditionally, so localhost
apps stay testable). **174 TS + 45 Py green.** Committed to `main`; the
`@sackville-mcp/safety` extraction (77c7ff7) + Tier-1 are being pushed together as the
milestone.

**Slice 7 (Tier-2 DNS-pinning SSRF proxy): DONE.** `createSsrfProxy`
(`proxy.ts`) — a loopback forward proxy (HTTP absolute-form + HTTPS `CONNECT`)
passed as Chromium's `proxy.server`; calls `@sackville-mcp/safety` `resolveAndPin` per
request/CONNECT (resolve once → refuse blocked range → connect to the **pinned**
IP), closing allowlisted-hostname DNS-rebinding (the gap Tier-1 can't see). HTTP
rebind → 502; redirects re-checked (each hop is a fresh proxy request). The
safety classifier gained `classifyAddress` (`global`/`private`/`blocked`) + an
operator **`allowPrivate`** opt-in (permits loopback/RFC1918 for local-app
testing, **never** link-local/metadata). Direct HTTP-client-through-proxy tests +
a real Chromium-through-proxy test (hostnames, so no loopback-bypass). **181 TS +
45 Py green.** The **two-tier SSRF defense is now complete.** Committed to `main`;
pushing as the milestone.

**Slice 8a (dry-run redaction completeness): DONE.** `PageDriver`'s dry-run
preview now applies the `redact` hook to the would-be request **`url`** as well as
its `postData` (a secret in a GET query string previously leaked into the preview);
the option doc records that the server bin wires the real `@sackville-mcp/safety`
`Redactor` there. Test wires a real `Redactor` through the hook → both body and
`?token=` query scrubbed. (ef5cd81)

**Slice 8b (artifact-capture pipeline): DONE.** `RunRecorder` (`recorder.ts`) —
attaches to a page + its context tracer for a run's lifetime and captures three
channels, each returned **by handle** (`sackville://browser/run/<id>/<kind>`) with
a compact summary (never inlined): a Playwright **trace.zip**
(screenshots+snapshots+sources), the **console** stream (incl. uncaught
`pageerror`s, tallied `byType`), and the **network** log (method/url/status/
failure, tallied `byStatus` + `failed`). Text channels pass through the operator's
`redact` hook **before** write (so a registered secret never lands in an artifact
via a logged value or query string); trace is binary (deep trace-internal
redaction is the secret-boundary slice). Per-channel enable flags. Real-chromium
tested against a fixture that logs a secret, fetches a secret-bearing URL, and
throws. **184 TS + 45 Py green.** (9a0a810)

**Browser MCP surface — design locked by the `browser-mcp-design` fan-out**
(3 design proposals → 2 adversarial critics → synthesis; ~407k tokens). Decisions:
**MCP surface only this pass (no CLI)**; safety/operator-config-first spine (one
operator `BrowserGate` threaded into the manager AND every driver; namespaced
`SACKVILLE_BROWSER_*` env, no fallback to the api bin's vars); handle-resource
egress (one `sackville://browser/run/{runId}/{kind}` ResourceTemplate); explicit
session-lifecycle tools with distinct mutating verbs. Plan staged into 3
milestones:

**Milestone A — engine hardening: DONE (slices A1–A6, pushed).** A1 snapshot
redaction seam, A2 per-generation immutable handles, A3 bounded diff, A4 dry-run
popup-block + `crossOriginEgress`, A5 no-snapshot vs stale-ref error, A6
`BrowserManager.onReap` flush hook. (The critic's "dry-run aborts only the first
request" was a verified misread — the route aborts every request; only the capture
is first-only.)

**Milestone B — MCP surface: DONE (pushed).** `registerBrowserTools`/
`createBrowserServer` (`packages/mcp/src/browser.ts`): process-lifetime singletons
(one BrowserManager, one operator gate, one ArtifactStore, one Redactor) + a
`Map<sessionId, BrowserSession>` with a per-session async mutex; 15 tools
(`browser_open_session`/`list_sessions`/`navigate`/`snapshot`/`click`/`fill`/
`fill_form`/`select`/`press`/`wait_for`/`get_text`/`get_value`/`get_attribute`/
`audit_a11y`/`close_session`); server-minted UUID sessionId+runId (1:1, never agent
input); reads redacted at the surface; reaper reconciliation via `manager.onReap`
(flush recorder) + `hasSession` eviction; the two-variable resource template over
the shared store. **Tested with real headless chromium + `InMemoryTransport`** (the
repo's established offline/deterministic browser-test posture — chosen over the
fake-launch suggestion as far more faithful + already CI-provisioned). Engine fix
this milestone demanded: `PageDriver` resolves a ref's locator **eagerly** so a
no-snapshot/stale-ref error propagates instead of being swallowed by the dry-run
try/catch.

**Milestone C — server bin: DONE (pushed).** `bin-browser.ts`
(`buildBrowserServerFromEnv`, exported + unit-tested; executable tail guarded by an
`import.meta` main-module check): sole reader of `SACKVILLE_BROWSER_*` env + sole
constructor of the egress boundary; **mandatory** `createSsrfProxy` (no disable
env) + Chromium launch with `--proxy-bypass-list=<-loopback>` (loopback also
traverses the pinning proxy — closes the documented bypass); trace-off-by-default;
sandbox on by default (`--no-sandbox` opt-in); `startReaper`; SIGINT/SIGTERM
shutdown → `manager.shutdown()` then `proxy.close()`; `sackville-browser-mcp` bin +
package.json deps/build inputs. Built bin smoke-starts clean.

**Secret boundary (ADR 0006 §6): COMPLETE.** `{{secret:NAME}}` fill resolution
(`bffdf07`, fail-closed, bin-wired) + origin-scoped `httpCredentials` (`4841fb2`,
per-context via `BrowserManager`, password redacted/out-of-config) + `storageState`
by handle (`24e47ff`, operator-gated, counts+handle only, resource-refused) +
trace-internal redaction (`acc6536`, fflate unzip→scrub text entries→rezip) — on
top of console/network (8b), dry-run preview (8a), snapshot (A1), and surface-read
(Milestone B) redaction. Scheduled refinements (not blocking): HAR bodies;
`storageState`/userDataDir **import** for operator login-reuse.

**Hardening — `serviceWorkers:'block'` + WebRTC: DONE (`9207224`).** SWs blocked on
every context; WebRTC limited to proxied UDP via a launch arg. **Caps — session
wall-clock + max-pages: DONE (`f0fc419`).** `maxSessionMs` reaps active-but-old
sessions; `maxPages` closes excess pages per context; both operator-set, default
no cap.

**On-demand screenshot step tool: DONE.** `PageDriver.screenshot()` → PNG to the
`ArtifactStore` under an immutable `screenshot-s<n>` handle (summary only, never
inlined; does NOT re-snapshot so refs survive); MCP `browser_screenshot` gated
**off by default** (`allowScreenshots`) because a screenshot is unredactable pixels
(same posture as the trace.zip); the resource serves PNGs as a base64 blob;
bin-wired via `SACKVILLE_BROWSER_ALLOW_SCREENSHOTS` (default off).

**Dialog gating: DONE.** `PageDriver` installs `page.on('dialog')` →
dismiss-by-default (override of Playwright's auto-dismiss, so the page never hangs)
+ record `DialogEvent {type, message(redacted), accepted}` onto
`StepResult.dialogs`; `BrowserGate.allowDialogs` flips to accept; bin-wired via
`SACKVILLE_BROWSER_ALLOW_DIALOGS` (default off).

**Download gating: DONE.** `BrowserManager` contexts are `acceptDownloads:false` by
default (Playwright cancels — race-free deny); an operator quarantine dir
(`SACKVILLE_BROWSER_DOWNLOAD_DIR`) flips it on + sets `PageDriver.downloadDir`, where
a download is saved under a sanitized indexed name and recorded as a `DownloadEvent`.
Surfaced by the race-free `browser_downloads` read tool (metadata only — bytes never
served).

**Upload gating: DONE.** `PageDriver.uploadFiles` / MCP `browser_upload` —
deny-by-default (requires operator `SACKVILLE_BROWSER_UPLOAD_DIR`); every path must
resolve within that dir (no traversal/absolute escape) so an agent can't exfiltrate
arbitrary local files. **The downloads/uploads/dialog/auth gating bundle is COMPLETE.**

**Human `sackville browser` CLI: DONE.** `browser snapshot|audit|screenshot <url>`
over a gated manager + mandatory SSRF proxy; typed host auto-allowed; `audit` exits
1 on violations. (`packages/cli/src/browser.ts`, real-chromium tested.)

**Browser assertions: DONE.** Shared **`@sackville-mcp/assert`** (operator core extracted
from `@sackville-mcp/api`) + `@sackville-mcp/browser` `assertions.ts`/`PageDriver.assert` (page
+ element sources, auto-wait poll, redacted actual) + MCP `browser_assert`. One
assertion engine across pillars.

**`browser_trace_query`: DONE.** `queryTrace` parses a trace.zip's `.trace` JSONL
into an action timeline (before/after by callId) + console + errors; MCP
`browser_trace_query` reads the stored redacted trace by runId (no live session).
Direct parser, no GUI subprocess. (`trace.ts`, real-chromium tested.)

**`browser_perf_audit`: DONE.** `auditPerf` runs Lighthouse 13.3.0 (perf category)
via chrome-launcher with the operator's proxied/hardened flags; summary (score +
core web-vitals) inline, full LHR JSON+HTML by handle (redacted). MCP
`browser_perf_audit` is standalone + allowlist-gated; bin binds the audit closure.
(`perf.ts`, real-Lighthouse tested; assert shape not scores.)

**Network heavy mode — HAR capture + replay: DONE** (`a6ead53`/`c6a5303`/`ca88685`).
`har.ts` `finalizeHar` (redact-before-surface, store by handle, compact summary) +
`BrowserManager` `harDir`/`onClosed` (after-close finalize on close/reap/shutdown);
`PageDriver.replayFromHar` (`routeFromHAR` notFound:abort, offline determinism,
operator replay-dir confinement). MCP `browser_close_session` surfaces the HAR,
`browser_replay_har` arms replay. Bin: `SACKVILLE_BROWSER_HAR_DIR` /
`SACKVILLE_BROWSER_REPLAY_HAR_DIR`. Operator-gated, deny-by-default.

**Persisted `.bru` browser-step flows: DONE** (`227263a`/`d7ad2a4`/`e23427e`).
`flow.ts` (model + `loadFlow`/`loadFlowCollection` + `runFlow`); PageDriver
`clickAt`/`fillAt`/`selectAt`/`pressAt` semantic-locator methods; `sackville browser
run <flow.bru>`; `examples/browser/login/`. Steps key off semantic locators, not
refs.

**MCP `browser_run_flow` + `browser_list_flows`: DONE** (the deferred flow
follow-up). Agent surface for persisted flows: `browser_list_flows` lists the
operator's flows (name + step count); `browser_run_flow` replays one **by name**
(no caller path) on a session's gated driver behind the per-session mutex, with
caller `{{var}}`s + operator-resolved `{{secret:NAME}}` (fail-closed) + surface
error redaction. Deny-by-default via `SACKVILLE_BROWSER_FLOWS_DIR`. Agent surface
now at parity with `sackville browser run`.

**Next (later Phase 3):** nothing required remains — Phase 3 is **feature-complete**.
**Multi-engine** (item 34, ADR 0009) landed: firefox/webkit via `engine.ts`, bin
`SACKVILLE_BROWSER_ENGINE` + CLI `--engine`, proxy cross-engine, chromium-only
hardening args, perf stays chromium; verified end-to-end (firefox + webkit drive a
fixture). **Developer live-view was DROPPED** (ADR 0008 — headless-only, LLM-first:
trace/HAR/console/video answer "what happened" better than watching a render). Video
capture (30), vision/coordinate caps (31), container-hardening ADR (32, ADR 0007),
and visual regression (33) are done. Only the explicitly-aspirational bucket is left
(`@playwright/mcp` embed, autonomous self-healing, cross-pillar contract tie-in).
TDD red→green; `pnpm gate` 100% green before each commit.

---

Pillar 2 (`@sackville-mcp/api`) is **COMPLETE — engine + agent/human surfaces + the
full optional tail**. All five formerly-deferred tail items have landed (TDD,
all green):
1. ~~Keyring secret store into CLI/MCP~~ **DONE** (CLI `--keyring`, MCP
   `SACKVILLE_KEYRING`; `resolveSecretStore({keyring})` chains keyring → env).
2. ~~SSRF range-block + post-redirect re-check~~ **DONE** (`assertSsrfAllowed`
   on every request via `@sackville-mcp/safety`; opt-in `maxRedirects` with per-hop
   SSRF + allowlist re-check + cross-origin credential strip).
3. ~~Request **body types**: multipart-form, file, graphql~~ **DONE**.
4. ~~Import: Postman/Insomnia/OpenAPI/HAR → `.bru`~~ **DONE** (`import.ts`,
   native — converters unavailable offline — + CLI `api import`).
5. ~~Contract-validation reach (ADR 0005)~~ **DONE**: external local-file `$ref`
   deref, OpenAPI 3.0 `nullable` shim, `operationName`-scoped GraphQL. (Remote
   http `$ref` + non-schema `$ref` remain out of scope by design — SSRF.)

Next: Phase 3 is feature-complete (multi-engine done, ADR 0009; live-view dropped,
ADR 0008). Recommended — start **Phase 4** (cross-cutting verification) with a
design pass, or pick up the explicitly-aspirational browser bucket — see ROADMAP.

Deferred Pillar-1 polish — **all DONE**: non-Node version detection (Python/Ruby
in `detectInstalledVersion`, wired into MCP/CLI); ingestion TOC-bleed + richer
`symbol` (`split_sections` strips on-page TOC lists; `symbol_from_heading`);
**Dash docset adapter** (`dash.iter_fragments` + `build --docset`, searchIndex
schema). Remaining Pillar-1 nice-to-haves: Homebrew tap; Dash Core Data docsets.

## How to build an index / register the server today

```bash
cd py/sackville_ingest && uv run sackville-ingest build --slug react --library react \
  --out ../../data/react.sqlite        # ~1,279 fragments, bge-small embeddings
claude mcp add sackville -- sackville-mcp /abs/path/to/data/react.sqlite
```
See `py/sackville_ingest/README.md` and `packages/mcp/README.md`.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this file — the **top block** ("Current phase") is the live phase + next action.
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (why).
4. Skim project memories and `git log --oneline -15`.
5. Continue from the **top-block "Current phase"** (the lower "## Next action" section is
   Phase 3/4 historical context).

## Known open questions

- npm publishing: scope packages under `@sackville-mcp/*` (bare `sackville` is taken
  on npm). Name confirmed fine for repo + Homebrew tap.
- Captured/script-set values flow through `response.captured` unredacted (needed
  for chaining); the MCP/CLI surface layer must decide how to expose them.

## Resolved (was open)

- **Repo license: Apache-2.0** (ADR 0002; `LICENSE` + `NOTICE` committed).
- **Version-pin fallback** (nearest-same-major → refuse) validated on the real
  React index: `^18.2.0` → 18.3.1, `16.8.0` → flagged.
