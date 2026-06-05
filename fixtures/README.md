# Test fixtures

## `golden.sqlite`

A committed Sackville index containing a single hand-crafted `react/19.0/useState`
fragment. It is the artifact behind the **polyglot boundary test**: the Python
ingester writes it, and `@sackville/core` (TypeScript) reads it back, proving the
SQLite schema contract holds across both languages.

It is committed (rather than built at test time) so `pnpm test` runs without the
Python toolchain. It is **byte-stable** — the builder uses a fixed `built_at`.

### Regenerate (after a schema change)

```bash
cd py/sackville_ingest
uv run sackville-ingest build-fixture ../../fixtures/golden.sqlite
```

Then re-run the gate (`pnpm gate`) and commit the updated fixture alongside the
schema change.
