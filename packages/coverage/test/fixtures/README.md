# `@strummer/coverage` test fixtures

No real test/coverage tool runs in `pnpm gate` — fixtures are captured once,
out-of-gate, and committed.

- **`coverage.json`** — a `coverage.py` JSON report (`coverage json` / `pytest --cov
  --cov-report=json`), consumed by `coveragePyToIstanbul` and by `runScopedPython`'s
  injected-runner tests. **Captured from coverage.py 7.14.1** over a 3-function `calc.py`
  whose `mul` branch is untested (executed lines `[1,2,5,6,9]`, missing `[10,11,12]`). The
  verbose per-file `classes`/`functions` blocks are trimmed — the adapter reads only
  `executed_lines`/`missing_lines`/`excluded_lines`. To re-capture: `uv pip install coverage
  pytest-cov`, then `pytest --cov=<pkg> --cov-report=json:coverage.json`.
