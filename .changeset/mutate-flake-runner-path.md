---
"@sackville-mcp/mutate": patch
"@sackville-mcp/flake": patch
---

Fix `mutate run` (Stryker/mutmut/cosmic-ray) and `flake run` (vitest/pytest)
failing opaquely when invoked from a **global** `sackville-cli`: the spawned tool
now resolves the target project's own `node_modules/.bin` (a pure, unit-tested
`runnerEnv` prepends it to the child's PATH, mirroring the fix already shipped in
`@sackville-mcp/coverage`). Without it, a bare `stryker`/`vitest` was resolved
only from the invoking shell's PATH, so a global CLI died with an opaque "did not
produce a JSON report". The spawn seam stays out of the green gate (ADR 0010).
