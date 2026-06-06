---
"@sackville-mcp/mutate": patch
"@sackville-mcp/flake": patch
"@sackville-mcp/browser": patch
"@sackville-mcp/cli": patch
"sackville-mcp": patch
---

Diff-scoping completed across every run-driving pillar, plus a browser-capture consolidation.

- **mutate (Stryker partial-scope reconciliation):** a changed source file Stryker silently
  never mutated (excluded by config / no glob match) no longer reads as a clean pass
  (absence-as-a-pass) — `runMutation` now selects + post-spawn reconciles like the
  cosmic-ray/mutmut runners (a selected-but-absent file ⇒ inconclusive).
- **flake (diff-scoping):** `flake run --related` builds `vitest related <files>` so changed
  source files scope to their dependent tests; `verify` drives flake with `related` so the
  composite's flake dimension actually exercises the change (previously changed source files
  were fed as positional `run` filters and matched nothing — a silent no-signal).
- **verify (MCP) — `verify_change` accepts `diffPath`:** parity with `run_scoped`; reusing a
  diff *path* no longer silently yields a no-signal coverage verdict.
- **verify (CLI) — `verify run --flow` is usable:** it now threads `--allow-unsafe` and
  resolves `{{secret:NAME}}` from `SACKVILLE_BROWSER_SECRET_*`, so a real login flow can be
  driven (previously every `fill`/`click` dry-ran and any flow failed the completeness guard).
- **browser — one shared capture-runtime builder:** `buildCaptureRuntime` +
  `browserSecretsFromEnv` (`@sackville-mcp/browser`), with the browser CLI, the verify CLI, and
  the browser MCP server adapting onto it — killing the drift that caused the verify-CLI gap above.
