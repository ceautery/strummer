---
"@sackville-mcp/coverage": patch
---

Fix `coverage run-scoped` failing opaquely when invoked from a **global**
`sackville-cli`: the spawned `vitest`/`pytest` now resolves the target project's
own `node_modules/.bin` (a new pure, unit-tested `runnerEnv` prepends it to the
runner's PATH). When no coverage report is produced, the error now surfaces the
runner's **exit code and output tail** (instead of an opaque "did not produce a
coverage report"), so the real cause — usually a missing/unresolvable runner — is
visible. The spawn seam stays out of the green gate (ADR 0010).
