# `@strummer/mutate` test fixtures

Golden reports the pure summarizer/parsers are tested against. No real mutation tool
runs in `pnpm gate` — these are captured once, out-of-gate, and committed.

- **`mutation-report.json`** — a Stryker `mutation-testing-elements` report
  (`schemaVersion`, `files[path].mutants[].status`), consumed by `summarizeMutation`.

- **`mutmut-results.txt`** — `mutmut results --all true` output captured from **mutmut
  3.5.0**, consumed by `parseMutmutResults`. One line per mutant
  (`<module>.x_<fn>__mutmut_<n>: <status>`).

- **`cosmic-ray-dump.jsonl`** — `cosmic-ray dump <session.sqlite>` JSON-lines consumed by
  `parseCosmicRayDump`. Each line is `[work_item, work_result | null]`. The **structure was
  captured from a real `cosmic-ray` 8.4.6 run** (`init`/`exec`/`dump` over a 3-function
  `calc.py` with tests covering only two of them): note `module_path`/`operator_name`/
  `start_pos: [line, col]` live nested under `work_item.mutations[]`, and a `work_result`
  carries `worker_outcome` + (when `normal`) `test_outcome`. The verbose `output`/`diff`
  fields (full pytest text + absolute paths) are pruned — the parser never reads them. The
  first two records (`killed`, `survived`) are real, pruned; the remaining records are
  hand-authored using the same authentic structure to exercise the rarer `worker_outcome`/
  `test_outcome` enum values (`no_test` → NoCoverage, `incompetent` → RuntimeError,
  `exception` → RuntimeError, `skipped` → Ignored, a `null` result → Pending, and an
  unrecognized outcome → Pending) which a small clean run won't naturally produce. To
  re-capture the real shape: `uv pip install cosmic-ray pytest`, then `cosmic-ray init
  cr.toml session.sqlite && cosmic-ray exec cr.toml session.sqlite && cosmic-ray dump
  session.sqlite`.
