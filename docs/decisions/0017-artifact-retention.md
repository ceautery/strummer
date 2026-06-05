# ADR 0017 — Artifact store retention / GC

- **Status:** Accepted
- **Date:** 2026-06-04
- **Extends:** ADR 0010 (the shared `@sackville-mcp/artifacts` extraction) + ADR 0013 slice 1
  (the prefix-qualified on-disk layout + realpath confinement).

## Context

`@sackville-mcp/artifacts` `ArtifactStore` is disk-backed and **append-only**: `put()` writes
`<baseDir>/<prefix>/<id>/<kind>` + a `<kind>.meta.json` sidecar and never deletes. Every
pillar writes to it — browser (traces/screenshots/video/HAR, the heaviest), deps
(changelog/audit detail), lsp (large reference lists), verify (verdicts, produced HARs).
A long-running MCP server therefore grows its artifact dir **without bound** — a real
operational gap for a "top-tier" tool. (The api-pillar `ArtifactStore` in
`packages/api/src/artifacts.ts` is a SEPARATE in-memory store for response bodies; it dies
with the process and is out of scope.)

GC must be **disk-based**, not in-process-Map-based: the store rehydrates foreign-prefix
handles from disk, and a cold process's `artifacts` Map is empty — so a Map-only sweep
would miss everything written by a prior process.

## Decision

A `RetentionPolicy { maxAgeMs?, maxEntries?, maxBytes? }` on the store, applied by a
disk-based `sweep()`. **Opt-in and default-off:** with no policy, behaviour is
byte-identical to today (no deletion) — existing stores, tests, and the CLI temp-dir
stores are untouched.

- **Eviction unit = the `<id>` dir** (one run's whole artifact set + its sidecars). A run's
  artifacts are produced/consumed together, so a run is the atomic GC unit; deleting a
  half-run would orphan handles.
- **Scoped to the store's OWN `<baseDir>/<prefix>` subtree.** A store only GCs the prefix it
  owns — a `deps` store never evicts `browser` artifacts; the cross-pillar `verify` store
  reads foreign prefixes but never GCs them. Ownership is unambiguous and matches the
  per-pillar `*_ARTIFACT_DIR` operator model.
- **Eviction order:** oldest-first by directory mtime. Apply `maxAgeMs` (drop dirs older than
  the cut), then `maxEntries` (keep the newest N), then `maxBytes` (drop oldest until the
  subtree's total is under the cap). Oldest-first guarantees a just-written run (newest) is
  the last thing evicted — a live artifact about to be read by handle is safe.
- **Confinement:** each candidate dir is realpath-confined under `baseDir` before `rmSync`
  (the same posture as `get()`), so a symlinked `<id>` dir can't make a delete escape the
  store root.
- **Trigger:** `put()` runs a **throttled** sweep when a policy is set — at most once per
  `sweepIntervalMs` (injected `now`, default `Date.now`; mirrors the browser manager's idle
  reaper). So the store self-maintains as it grows, with no per-bin timer wiring, and even a
  single-shot process bounds itself. A public `sweep(now?)` is also exposed for an explicit
  startup sweep. The throttle keeps `put()` from triggering a full dir scan on every write.
- **Map coherence:** evicted handles are dropped from the in-process `artifacts` Map so a
  later `get()` correctly returns `undefined` (then misses → disk → also gone) rather than
  reading a deleted path.

## Wiring

Each long-running server bin parses opt-in retention env consistent with its existing
`*_ARTIFACT_DIR`: `SACKVILLE_<PILLAR>_ARTIFACT_MAX_AGE_MS` / `_MAX_ENTRIES` / `_MAX_BYTES`
(`bin-browser`, `bin-deps`, `bin-lsp`, `bin-verify`). Unset ⇒ no policy ⇒ no GC. CLI
single-shot stores use `mkdtemp` dirs the OS/test harness reclaims, so they wire nothing.

## Invariants held

- **Opt-in / no surprise deletion:** absent any cap, nothing is ever deleted.
- **Ownership:** a sweep only touches the store's own prefix subtree.
- **Confinement preserved:** realpath check before every `rmSync`.
- **Deterministic + no real sleeping in `pnpm gate`:** the clock is injected; tests drive
  `now` and assert eviction sets over a temp dir (no timers).

## Consequences

A server with retention configured stays bounded; nothing changes for callers that don't opt
in. A persistent/remote backend (foreshadowed in the store docs) can implement the same
`RetentionPolicy` contract later. Staged, not built: a global cross-prefix cap (each pillar
caps its own subtree today); LRU-by-access (we evict by write-age, not last-read).
