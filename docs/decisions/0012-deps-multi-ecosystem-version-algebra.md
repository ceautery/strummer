# ADR 0012 — `@sackville-mcp/deps`: multi-ecosystem version algebra (PyPI / RubyGems)

- **Status:** Accepted (design; first slice is the `VersionComparator` seam)
- **Date:** 2026-06-01
- **Relates to:** ADR 0010 (Phase-4 sequencing + cross-cutting decisions: explicit
  pins / no transitive imports; TS-first, Python staged), the shipped `@sackville-mcp/deps`
  pillar (slices 1–5 + `changelog_diff`), `core.detectInstalledVersion` (already
  ecosystem-dispatching node/python/ruby), ARCHITECTURE §"version-pinned, not latest".

## Context

`@sackville-mcp/deps` answers deprecation / vulnerability / freshness **for the installed
version** of a dependency. It ships complete for **npm** but is npm-only: `audit_project`
hard-rejects other ecosystems, and — more dangerously — the version algebra is hardcoded
to **`semver`**. A fan-out research pass (two external streams: PEP 440 / Gem comparison
libraries + OSV/registry semantics; one repo-internal stream: the exact call sites + a
minimal seam) surfaced the core trap:

> **OSV ships PyPI and RubyGems advisory ranges as `type: "ECOSYSTEM"` with
> `introduced`/`fixed`/`last_affected` version strings the schema calls "arbitrary,
> uninterpreted strings specific to the package ecosystem."** Matching = sort those
> events with **the ecosystem's own comparator**, then scan (`fixed` exclusive,
> `last_affected` inclusive). PyPI uses **PEP 440** ordering; RubyGems uses
> **`Gem::Version`** ordering. Neither is SemVer.

Today `osv.ts` runs every `ECOSYSTEM` range through `semver.compare` (after a lenient
`semver.coerce`). For npm that is correct (npm ECOSYSTEM == SemVer); for PyPI/RubyGems it
**silently mis-coerces** — e.g. `semver.coerce` mangles `1.0.0rc1`, epochs (`1!2.0`), and
post-releases (`1.0.post1`), so a vulnerable installed version can be judged safe. This is
exactly the "silent-wrong" class the project guards against, and it is worst here: deciding
whether an installed version sits inside a CVE range.

`semver` is load-bearing in **~11 functions** across `audit.ts` (`stableVersions`,
`maxVersion`, `computeBehindBy`, `computeFreshness`, `lowestSafeVersion`, `auditDependency`)
and `osv.ts` (`clean`, `compareVersions`, `versionInRange`→`fixedVersions`→
`matchVulnerabilities`), plus `changelog.ts`.

## Decision

### 1. A pluggable `VersionComparator` seam

Introduce one minimal interface, injected into the audit/OSV core (mirroring how every
code-running surface takes an injected runner). Only methods an existing call site needs:

```ts
export interface VersionComparator {
  isValid(version: string): boolean            // replaces semver.valid(...) !== null
  clean(version: string): string | null        // replaces the coerce()+valid() chain; ecosystem-defined leniency
  compare(a: string, b: string): -1 | 0 | 1     // total order; powers sort + range scan
  gt(a: string, b: string): boolean
  lt(a: string, b: string): boolean
  lte(a: string, b: string): boolean
  isPrerelease(version: string): boolean        // replaces semver.prerelease(...) === null
  /**
   * Release components as a numeric tuple, or null if unparseable. [0]=major, [1]=minor,
   * [2]=patch. semver → [major,minor,patch]; PEP 440 → release tuple padded to ≥3; Gem →
   * leading numeric segments. Powers behindBy / latestSameMajor / latestSamePatchLine; when
   * null, those degrade to `undefined` (we never fabricate a major.minor.patch we can't read).
   */
  releaseComponents(version: string): number[] | null
}
```

`behindBy` / `latestSameMajor` / `recommendedTarget` stay meaningful but **degrade
gracefully**: they are defined in terms of `releaseComponents()` indices, and a comparator
that returns `null` (or a tuple shorter than 3) yields `behindBy: undefined` rather than a
fabricated triple. "Same major" = same `releaseComponents()[0]`.

### 2. Build vs. buy — **pin, don't hand-roll** (the ADR-0010 explicit-pin posture)

PEP 440 and `Gem::Version` ordering each have enough sharp edges (PEP 440: epoch dominance,
dev-sorts-before-pre, local-version placement, post-of-pre, zero-pad equivalence, multi-spelling
normalization; Gem: scan-into-digit/letter segments, "a string segment sorts below a numeric
one," trailing-zero canonicalization, arbitrary segment count) that a hand-roll is a recurring
correctness liability for the one safety-critical job. Both have a maintained, **zero-runtime-
dependency**, TS-typed, ESM, Renovate-grade pin:

| Ecosystem | Comparator | Pin | License | Notes |
|---|---|---|---|---|
| npm | `SemverComparator` | existing `semver ^7.8.1` | ISC | behavior-preserving wrap |
| PyPI | `Pep440Comparator` | **`@renovatebot/pep440` 5.x** | Apache-2.0 | zero deps, ESM-only, ships `.d.ts`; `parse`/`compare`/`valid`/`gt`/`lt`/`lte`/`major`/`minor`/`patch` |
| RubyGems | `GemComparator` | **`@renovatebot/ruby-semver` 5.x** | MIT | zero deps, ESM-only, ships `.d.ts`; exact `Gem::Version#<=>` |

Both pins declare `engines: node ^22.11.0 || >=24.10.0` — our Node is **22.22.3**, satisfied.
We write our own **conformance fixtures regardless** (the PEP 440 canonical ordering sequence;
the Gem `<=>` example pairs) so correctness is gated by our tests, not the dep's.

**Risk + fallback:** the `@renovatebot/*` 5.x line is reported to use Node-native TS internals;
if either fails to load/bundle under our toolchain (tsc / tsdown / Vitest external-CJS path), we
fall back to a **hand-rolled comparator** for that ecosystem (the research captured both
algorithms precisely — Gem's especially is small). The seam makes this a localized swap: the
core depends only on `VersionComparator`. We validate the load **in the slice that pins it**,
not in this ADR.

### 3. Scope — what's in, what stays deferred

- **In:** the seam + `SemverComparator` (behavior-preserving), then PyPI end-to-end
  (Pep440Comparator + PyPI freshness fetcher + lifting `audit_dependency`/`audit_project`'s
  `ecosystem !== 'npm'` rejection for PyPI), then RubyGems.
- **Deferred (not amputated):** `changelog_diff` stays **npm/semver-only** for now. Changelogs
  are GitHub-fetched and npm-centric, and the heading parser is a SemVer-shaped regex; PyPI/Gem
  changelog heading recognition is a separate, lower-value feature. `osv.ts`/`audit.ts` get the
  comparator; `changelog.ts` keeps its internal `semver` use with a TODO. Also deferred: pip
  specifier (`~=`/`===`) and Gem requirement (`~>`) *satisfies* semantics — OSV range matching
  needs only **ordering** (`compare`), not specifier-operator evaluation.

### 4. Registry freshness fetchers (per ecosystem, injected)

Freshness needs "all published versions + latest", fetched by an **injected** seam (offline/
deterministic in tests; the bin builds the SSRF-pinned live fetcher, network off by default —
unchanged posture). Latest is **computed from the version list with the ecosystem comparator +
prerelease/yanked filters**, never taken blindly from a registry's "latest" field, so freshness
and vuln-matching share one comparator.

- **PyPI:** `GET https://pypi.org/pypi/<project>/json` → `releases` keys = all versions (sort
  ourselves); per-file `yanked` flag. Map to the internal `Packument` shape (`versions` map +
  a synthesized `dist-tags.latest`). Package **name normalized to PEP 503** (lowercase, runs of
  `_`/`.`/`-` → `-`) before OSV matching — OSV stores the normalized name.
- **RubyGems:** `GET https://rubygems.org/api/v1/versions/<name>.json` → array of `{number,
  prerelease, ...}`; yanked versions are **omitted** from the array (no `yanked` field — verify
  empirically in the Gem slice). Gem names are used as-is (no normalization).

## Slice plan (TDD, each green before commit)

1. **`VersionComparator` + `SemverComparator` + thread `cmp` through `audit.ts` + `osv.ts`.**
   Pure refactor; npm behavior identical — the **existing deps suite is the regression guard**.
   `changelog.ts` untouched. (No new pin; `SemverComparator` wraps the existing `semver`.)
2. **`Pep440Comparator`** (pin `@renovatebot/pep440`; validate it loads under tsc/tsdown/Vitest)
   + PEP 440 conformance fixtures + OSV-PyPI range-scan tests over committed advisory fixtures.
3. **PyPI freshness + surface wiring.** PyPI JSON-API packument fetcher (injected; map to
   `Packument`, PEP 503 name normalization); a per-ecosystem `COMPARATORS` map in
   `deps.ts`/`bin-deps.ts`; lift the `ecosystem !== 'npm'` rejection for PyPI in
   `audit_dependency` + `audit_project`; the bin's PyPI fetcher behind the same network gate.
   End-to-end: temp PyPI project + injected fetcher + OSV PyPI snapshot.
4. **RubyGems.** `GemComparator` (pin `@renovatebot/ruby-semver`, with the hand-roll fallback if
   it won't load) + Gem fixtures + RubyGems API fetcher + wire RubyGems through the surface.

## Consequences

- The audit/OSV core stops assuming SemVer; the silent mis-coercion of PyPI/Gem ranges is
  closed. npm is behavior-preserving (proven by the unchanged suite after slice 1).
- Two new explicit, zero-dep pins (PEP 440, Gem), each gated by our own conformance fixtures and
  validated-to-load in its slice, with a documented hand-roll fallback — consistent with ADR
  0010's "explicit pins, no transitive imports."
- `changelog_diff` remains npm-only by design; PyPI/Gem changelog support is scheduled, not cut.
