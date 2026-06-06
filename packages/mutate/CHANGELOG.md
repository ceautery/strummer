# @sackville-mcp/mutate

## 0.0.1-alpha.5

### Patch Changes

- d7738d0: Diff-scoping completed across every run-driving pillar, plus a browser-capture consolidation.

  - **mutate (Stryker partial-scope reconciliation):** a changed source file Stryker silently
    never mutated (excluded by config / no glob match) no longer reads as a clean pass
    (absence-as-a-pass) — `runMutation` now selects + post-spawn reconciles like the
    cosmic-ray/mutmut runners (a selected-but-absent file ⇒ inconclusive).
  - **flake (diff-scoping):** `flake run --related` builds `vitest related <files>` so changed
    source files scope to their dependent tests; `verify` drives flake with `related` so the
    composite's flake dimension actually exercises the change (previously changed source files
    were fed as positional `run` filters and matched nothing — a silent no-signal).
  - **verify (MCP) — `verify_change` accepts `diffPath`:** parity with `run_scoped`; reusing a
    diff _path_ no longer silently yields a no-signal coverage verdict.
  - **verify (CLI) — `verify run --flow` is usable:** it now threads `--allow-unsafe` and
    resolves `{{secret:NAME}}` from `SACKVILLE_BROWSER_SECRET_*`, so a real login flow can be
    driven (previously every `fill`/`click` dry-ran and any flow failed the completeness guard).
  - **browser — one shared capture-runtime builder:** `buildCaptureRuntime` +
    `browserSecretsFromEnv` (`@sackville-mcp/browser`), with the browser CLI, the verify CLI, and
    the browser MCP server adapting onto it — killing the drift that caused the verify-CLI gap above.
  - @sackville-mcp/spawn@0.0.1-alpha.5

## 0.0.1-alpha.4

### Patch Changes

- e2f7eed: Fix `mutate run` (Stryker/mutmut/cosmic-ray) and `flake run` (vitest/pytest)
  failing opaquely when invoked from a **global** `sackville-cli`: the spawned tool
  now resolves the target project's own `node_modules/.bin` (a `runnerEnv` that
  prepends it to the child's PATH). Without it, a bare `stryker`/`vitest` was
  resolved only from the invoking shell's PATH, so a global CLI died with an opaque
  "did not produce a report".

  `runnerEnv` (and the identical `spawnRunner` wrapper it backs) now live in a new
  shared, zero-dependency **`@sackville-mcp/spawn`** package, consumed by
  `@sackville-mcp/coverage`, `@sackville-mcp/mutate`, and `@sackville-mcp/flake` —
  one source of truth instead of three copies. The pillars keep their public
  `TestRunner` / `MutationRunner` type names as aliases of the shared
  `SpawnedRunner`, so this is internal-only (no API change). The spawn seam stays
  out of the green gate (ADR 0010: injected runner; no real spawn).

- Updated dependencies [e2f7eed]
  - @sackville-mcp/spawn@0.0.1-alpha.4

## 0.0.1-alpha.3

## 0.0.1-alpha.2

### Patch Changes

- 76478c8: canary: verify OIDC trusted publishing end-to-end across all 18 packages (no functional change).
