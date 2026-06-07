# @sackville-mcp/pyscope

Pure, zero-dependency pytest test-selection from a changed-file set — the shared
"mirrored-test" scope heuristic used by Sackville's `coverage` and `flake` pillars
to map changed source files to the pytest tests that exercise them.

`selectPytestScope(changedFiles, mode, testExists)` returns the pytest selectors,
the `unmatched` changed sources (no confident mirrored test), and whether the
no-test fallback `widen`ed to the whole suite. All filesystem access is via the
injected `testExists` predicate, so it is pure and unit-tests with no disk.

This is an internal leaf of the [Sackville](https://github.com/ceautery/sackville)
toolkit, extracted (per the `diff`/`severity`/`spawn` discipline) so a consumer can
reuse the heuristic without importing a sibling pillar's run/spawn machinery.
