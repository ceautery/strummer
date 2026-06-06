# @sackville-mcp/coverage

## 0.0.1-alpha.5

### Patch Changes

- @sackville-mcp/diff@0.0.1-alpha.5
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
  - @sackville-mcp/diff@0.0.1-alpha.4

## 0.0.1-alpha.3

### Patch Changes

- 6dda0a3: Fix `coverage run-scoped` failing opaquely when invoked from a **global**
  `sackville-cli`: the spawned `vitest`/`pytest` now resolves the target project's
  own `node_modules/.bin` (a new pure, unit-tested `runnerEnv` prepends it to the
  runner's PATH). When no coverage report is produced, the error now surfaces the
  runner's **exit code and output tail** (instead of an opaque "did not produce a
  coverage report"), so the real cause — usually a missing/unresolvable runner — is
  visible. The spawn seam stays out of the green gate (ADR 0010).
  - @sackville-mcp/diff@0.0.1-alpha.3

## 0.0.1-alpha.2

### Patch Changes

- 76478c8: canary: verify OIDC trusted publishing end-to-end across all 18 packages (no functional change).
- Updated dependencies [76478c8]
  - @sackville-mcp/diff@0.0.1-alpha.2
