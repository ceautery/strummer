# STATUS

> Single source of truth for **"what phase are we on"** and **"pick up where we
> left off."** Keep the **Current phase** block current after every milestone.
>
> This file is deliberately short. The full milestone-by-milestone history lives in
> `git log`, `ROADMAP.md`, `docs/decisions/` (ADRs), and the project memories — don't
> re-accumulate a changelog here (it grew to ~1900 lines once; trimmed 2026-06-07).

## Current phase

**SHIPPED & STABLE — all pillars complete, published to npm at `0.0.1-alpha.5`.**
Gate green **1725 TS + 48 Py**; npm `latest` **and** `alpha` both = `0.0.1-alpha.5` on all
**20** published packages (the 19 fleet have OIDC/SLSA provenance; `@sackville-mcp/pyscope`
was first-published 2026-06-07 via the token bootstrap — no provenance on this one publish,
OIDC takes over at the next release). **`main` has local commits ahead of `origin`** (the
pyscope extraction + flake pytest related-scoping) — held unpushed at the user's request;
note pyscope's CODE is on npm but not yet on `origin`. They ride up with the next push.

The product is feature-complete across **Phases 0–6**: docs search (version-pinned,
hybrid FTS+vector), API testing (`.bru` + contract validation + capture→contract
bridge), browser/UI testing (flows, a11y, HAR, visual), cross-cutting verification
(coverage / deps / flake / mutate / LSP), the cross-pillar `verify` verdict, and
packaging/distribution (automated Changesets→OIDC release). **20 workspace packages**, all
published (the 20th, `@sackville-mcp/pyscope`, first-published 2026-06-07 via token bootstrap;
OIDC handles its future releases). Diff-scoping is complete across every
run-driving pillar (coverage / mutate / flake — **incl. pytest** now, both frameworks).

**Tutorial 3 now has teeth (DONE 2026-06-07, e40131c).** The old storefront bug
(`balance` string-vs-integer, UI-coerced to `$100.00`) had no observable consequence.
Replaced with a **missing-required-field** breach: `GET /account` silently drops the
required `currency`; the account is EUR, so a USD-defaulting dashboard still renders
and the login flow still passes, but the `GET /ledger` USD export defaults to USD too
and silently under-reports every euro balance ($100.00 vs ~$108.00) — caught by
`api run --openapi` / `validate-capture` / `verify run` before it ships. Finding stays
`response-schema` (missing property), guard churn minimal. See [[sackville-onboarding-docs]].
No open tutorial-3 work; see *Standing items* for what's next.

## Recently shipped (newest first)

- **Ecosystem-aware changelog heading detection** (2026-06-07, local/unpushed): deps
  `changelog_diff` now detects PyPI (PEP 440 two-segment `1.0` / letter-prerelease `1.0rc1`) and
  RubyGems (N-segment `1.2.3.4` / `.pre` segments) version headings, not just semver-shaped ones.
  Done by adding an optional `versionTokens(headingText)` extractor to `VersionComparator`
  (pep440 + gem implement it; the slicer falls back to the strict 3-part semver token, so **npm is
  unchanged**); `isValid` stays the final authority and both extractors require ≥2 numeric segments
  so dates aren't mistaken for versions. Gate 1725→1732 TS.
- **flake pytest related-scoping + `@sackville-mcp/pyscope` (20th package)** (2026-06-07,
  local/unpushed): `flake run --related` now diff-scopes pytest too (was vitest-only). The
  pure "mirrored-test" scope heuristic (`selectPytestScope`) was extracted from `coverage`
  into a new zero-dep leaf `@sackville-mcp/pyscope` (the diff/severity/spawn discipline — 2nd
  consumer ⇒ extract); coverage re-exports it (surface unchanged). pytest maps changed
  sources→mirrored tests via the leaf; empty mapping ⇒ no-op (NEVER the whole suite),
  `widen` opt-in; unmatched sources surfaced as a gap. Wired through `flake_run` (drops the
  "vitest only" note, adds `scopeMode`) + CLI `flake run --scope-mode`. Gate 1704→1725 TS.
  **pyscope first-published to npm 2026-06-07** (`0.0.1-alpha.5`, both tags; token bootstrap,
  no provenance on this publish — OIDC takes over next release). Its CODE is unpushed to `origin`.
- **CI Node-20 deprecations cleared** (2026-06-07): `actions/checkout`+`setup-node` v4→v5,
  `astral-sh/setup-uv` v6→v7 (no moving v8 tag), and the tsdown `external`→`deps.neverBundle`
  build warning in `verdict`/`verify`. CI green, zero deprecation annotations.
- **Tutorial 3 revamp — the breach got teeth** (2026-06-07, e40131c): storefront bug
  changed from a no-consequence type nit to a dropped-required-`currency` field whose
  loss silently corrupts a downstream USD ledger export (EUR under-reported by the FX
  spread). Mechanics unchanged; finding stays `response-schema`. README/curl outputs
  re-verified live. Gate 1703→1704 TS.
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
- **Deferred technical tails**: cosmic-ray `cr-filter-git` (line-precise mutation scope);
  mutmut `mutants/` cache reuse; src-layout `reconcileMutmutScope` precision;
  LSP recursive/dir delete + the full toolchain cross-version matrix.
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
