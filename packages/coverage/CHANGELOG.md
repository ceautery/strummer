# @sackville-mcp/coverage

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
