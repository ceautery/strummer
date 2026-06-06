---
"@sackville-mcp/spawn": patch
"@sackville-mcp/coverage": patch
"@sackville-mcp/mutate": patch
"@sackville-mcp/flake": patch
---

Fix `mutate run` (Stryker/mutmut/cosmic-ray) and `flake run` (vitest/pytest)
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
