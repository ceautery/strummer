# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the **Current phase** block current after every milestone.
>
> This file is deliberately short. The full milestone-by-milestone history lives in
> `git log`, `ROADMAP.md`, `docs/decisions/` (ADRs), and the project memories — don't
> re-accumulate a changelog here (it grew to ~1900 lines once; trimmed 2026-06-07).

## Current phase

**SHIPPED & STABLE — all pillars complete, published to npm at `0.0.1-alpha.5`.**
Gate green **1703 TS + 48 Py**; `main` HEAD pushed + CI green; npm `latest` **and**
`alpha` both = `0.0.1-alpha.5` on all 19 packages (OIDC, SLSA provenance).

The product is feature-complete across **Phases 0–6**: docs search (version-pinned,
hybrid FTS+vector), API testing (`.bru` + contract validation + capture→contract
bridge), browser/UI testing (flows, a11y, HAR, visual), cross-cutting verification
(coverage / deps / flake / mutate / LSP), the cross-pillar `verify` verdict, and
packaging/distribution (19 packages, automated Changesets→OIDC release). Diff-scoping
is complete across every run-driving pillar (coverage / mutate / flake).

**Next session — REVISIT TUTORIAL 3** (Curtis, 2026-06-07): its bug (a contract
violation with *no observable side-effect* — `balance` string-vs-integer that the UI
coerces to `$100.00` fine) isn't severe enough; a dev wouldn't chase a no-consequence
type nit. Give the breach **teeth** — make the contract violation map to a real,
demonstrable downstream bug (e.g. a lexicographic sort / string-concat sum on the
mis-typed field, or a missing-required-field silent data loss), so contract validation
visibly catches a defect *before it ships*. Mechanics (server, committed HAR, guards,
README arc) stay; only the bug + its demonstrated consequence change. Full critique +
candidate directions: [[sackville-onboarding-docs]]. Otherwise see *Standing items*.

## Recently shipped (newest first)

- **`0.0.1-alpha.5` published** (2026-06-06/07): diff-scoping completion + the browser
  capture-runtime consolidation (below). `latest` repointed alpha.4→alpha.5 on all 19
  (manual `npm dist-tag` as `ceautery`; pre-mode never moves `latest`).
- **Browser capture-runtime — one shared builder**: `buildCaptureRuntime` +
  `browserSecretsFromEnv` in `@sackville-mcp/browser`; the browser CLI, the verify CLI
  `--flow` path, and the browser MCP server all adapt onto it (killed the drift below).
- **Level-3 tutorial** `examples/tutorial/storefront/` (api + browser + verify): a
  zero-dep API whose `GET /account` returns `balance` as a string vs an integer contract
  — caught by `api run --openapi`, `api validate-capture`, and `verify_change`. ADR 0020
  addendum 2. Surfaced + fixed a real `@sackville-mcp/cli` bug: `verify run --flow` wired
  no `--allow-unsafe` / secret resolver.
- **Diff-scoping tails**: flake `vitest related` (`flake run --related`); `verify_change`
  accepts `diffPath`; Stryker partial-scope reconciliation (`runMutation`).
- **`0.0.1-alpha.4`/`.3`**: mutate+flake & coverage runner-PATH fixes; `@sackville-mcp/spawn`
  extraction (the 19th package). See [[sackville-tutorial-runthrough-fixes]].
- **Onboarding spike**: README rewrite, the `.claude/skills/sackville/` skill, and three
  runnable resettable tutorials (todo/scheduler/storefront). ADR 0020 + [[sackville-onboarding-docs]].
- **Rename** Strummer→Sackville, npm scope `@sackville-mcp` (ADR 0001); **automated OIDC
  release pipeline** live (ADR 0019). See `RELEASING.md` + [[sackville-alpha-publish]].

## Standing items / candidate next directions

- **Branch protection on `main`** (OPERATOR — needs an Admin-scoped token; the working
  PAT lacks the *Administration* permission). Required checks: `gate` + `package-checks`.
  This is the last piece of the §18 "green gate before publish" guarantee.
- **CI Node-20 action deprecation** (cosmetic; GitHub forces Node 24 on `actions/checkout@v4`
  + `setup-node@v4` from 2026-06-16) — bump the action versions in `.github/workflows/`.
- **Deferred technical tails**: cosmic-ray `cr-filter-git` (line-precise mutation scope);
  mutmut `mutants/` cache reuse; src-layout `reconcileMutmutScope` precision; ecosystem-aware
  changelog heading regex; LSP recursive/dir delete + the full toolchain cross-version matrix;
  pytest related-scoping for flake (`supportsRelated`).
- **Aspirational browser bucket**: `@playwright/mcp` embed, autonomous self-healing.

## How to resume cold

1. Read `CLAUDE.md` (how we work).
2. Read this **Current phase** block (the live state + whether anything is in flight).
3. Read `ROADMAP.md` (the plan) and `docs/decisions/` (the why); skim the project memories
   ([[strummer-project]] is the comprehensive index) and `git log --oneline -15`.
4. **Use the Sackville MCP server aggressively** when wired ([[sackville-dogfooding-mcp]]):
   `lsp_*` over grep, `search_docs` over guessing, `run_scoped`/`mutate_run`/`verify_change`
   to verify a change.

## How to build an index / register the server

```bash
cd py/sackville_ingest && uv run sackville-ingest build --slug react --library react \
  --out ../../data/react.sqlite        # ~1,279 fragments, bge-small embeddings
claude mcp add sackville -- npx -y sackville-mcp /abs/path/to/data/react.sqlite
```

See `py/sackville_ingest/README.md`, `packages/mcp/README.md`, and `RELEASING.md`.

## Known open questions

- Captured / script-set values flow through `response.captured` **unredacted** (needed for
  request chaining); each surface layer decides how to expose them.
