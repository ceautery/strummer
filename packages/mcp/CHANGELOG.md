# sackville-mcp

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

- Updated dependencies [d7738d0]
  - @sackville-mcp/mutate@0.0.1-alpha.5
  - @sackville-mcp/flake@0.0.1-alpha.5
  - @sackville-mcp/browser@0.0.1-alpha.5
  - @sackville-mcp/verdict@0.0.1-alpha.5
  - @sackville-mcp/verify@0.0.1-alpha.5
  - @sackville-mcp/api@0.0.1-alpha.5
  - @sackville-mcp/artifacts@0.0.1-alpha.5
  - @sackville-mcp/core@0.0.1-alpha.5
  - @sackville-mcp/coverage@0.0.1-alpha.5
  - @sackville-mcp/deps@0.0.1-alpha.5
  - @sackville-mcp/diff@0.0.1-alpha.5
  - @sackville-mcp/embed@0.0.1-alpha.5
  - @sackville-mcp/lsp@0.0.1-alpha.5
  - @sackville-mcp/safety@0.0.1-alpha.5

## 0.0.1-alpha.4

### Patch Changes

- Updated dependencies [e2f7eed]
  - @sackville-mcp/coverage@0.0.1-alpha.4
  - @sackville-mcp/mutate@0.0.1-alpha.4
  - @sackville-mcp/flake@0.0.1-alpha.4
  - @sackville-mcp/verdict@0.0.1-alpha.4
  - @sackville-mcp/verify@0.0.1-alpha.4
  - @sackville-mcp/api@0.0.1-alpha.4
  - @sackville-mcp/artifacts@0.0.1-alpha.4
  - @sackville-mcp/browser@0.0.1-alpha.4
  - @sackville-mcp/core@0.0.1-alpha.4
  - @sackville-mcp/deps@0.0.1-alpha.4
  - @sackville-mcp/diff@0.0.1-alpha.4
  - @sackville-mcp/embed@0.0.1-alpha.4
  - @sackville-mcp/lsp@0.0.1-alpha.4
  - @sackville-mcp/safety@0.0.1-alpha.4

## 0.0.1-alpha.3

### Patch Changes

- Updated dependencies [6dda0a3]
  - @sackville-mcp/coverage@0.0.1-alpha.3
  - @sackville-mcp/verdict@0.0.1-alpha.3
  - @sackville-mcp/verify@0.0.1-alpha.3
  - @sackville-mcp/api@0.0.1-alpha.3
  - @sackville-mcp/artifacts@0.0.1-alpha.3
  - @sackville-mcp/browser@0.0.1-alpha.3
  - @sackville-mcp/core@0.0.1-alpha.3
  - @sackville-mcp/deps@0.0.1-alpha.3
  - @sackville-mcp/diff@0.0.1-alpha.3
  - @sackville-mcp/embed@0.0.1-alpha.3
  - @sackville-mcp/flake@0.0.1-alpha.3
  - @sackville-mcp/lsp@0.0.1-alpha.3
  - @sackville-mcp/mutate@0.0.1-alpha.3
  - @sackville-mcp/safety@0.0.1-alpha.3

## 0.0.1-alpha.2

### Patch Changes

- 76478c8: canary: verify OIDC trusted publishing end-to-end across all 18 packages (no functional change).
- Updated dependencies [76478c8]
  - @sackville-mcp/api@0.0.1-alpha.2
  - @sackville-mcp/artifacts@0.0.1-alpha.2
  - @sackville-mcp/browser@0.0.1-alpha.2
  - @sackville-mcp/core@0.0.1-alpha.2
  - @sackville-mcp/coverage@0.0.1-alpha.2
  - @sackville-mcp/deps@0.0.1-alpha.2
  - @sackville-mcp/diff@0.0.1-alpha.2
  - @sackville-mcp/embed@0.0.1-alpha.2
  - @sackville-mcp/flake@0.0.1-alpha.2
  - @sackville-mcp/lsp@0.0.1-alpha.2
  - @sackville-mcp/mutate@0.0.1-alpha.2
  - @sackville-mcp/safety@0.0.1-alpha.2
  - @sackville-mcp/verdict@0.0.1-alpha.2
  - @sackville-mcp/verify@0.0.1-alpha.2
