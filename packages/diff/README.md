# @strummer/diff

The shared changed-set primitive: pure, zero-dependency unified-diff parsing.

Extracted out of `@strummer/coverage` (mirroring the `@strummer/safety` /
`@strummer/assert` / `@strummer/artifacts` extractions) the moment a second
consumer appeared — milestone 5d diff-scopes every verification pillar from one
diff, and `@strummer/verify` must runtime-import the parser to derive each
pillar's scope. Keeping it a dependency-free package is what lets `verify` import
it without dragging in a pillar's spawn-capable code (its zero-spawn invariant).

## API

- `parseUnifiedDiff(diff)` → `DiffFile[]` — per-file new-side **added line
  numbers** (feeds the coverage forgotten-assertion catch). Omits files that
  gained no lines.
- `changedFiles(diff)` → `string[]` — the **non-deleted paths** a change touched
  (the scope primitive: which tests to re-run, which files to mutate, which
  packages to audit). Includes removal-only modifications and new files; excludes
  deleted files.

Both are pure and offline — producing the diff (`git diff`) and reconciling paths
to coverage keys / package manifests are caller concerns.
