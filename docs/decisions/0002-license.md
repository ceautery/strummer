# ADR 0002 — License: Apache-2.0

- **Status:** Accepted (set in stone)
- **Date:** 2026-05-31

## Context

Strummer is a developer-tooling project (MCP server + CLI + Python ingester)
intended for wide adoption, including as an agent capability embedded in
commercial workflows. It also ingests third-party documentation and records
upstream attribution.

## Decision

License the Strummer software under the **Apache License 2.0**. Copyright
**Curtis Autery, 2026**. A `NOTICE` file accompanies the `LICENSE`.

## Rationale

- **Permissive** — no adoption friction for commercial/embedded use (copyleft
  would deter it).
- **Explicit patent grant + retaliation clause** — MIT is silent on patents.
  Strummer implements non-trivial techniques (hybrid FTS + vector ranking,
  agent-facing protocols) and targets dev-infrastructure use, where a real
  patent license matters. This also aligns with the MCP SDKs' licensing.
- **NOTICE mechanism** — a conventional home for attribution, apt for a tool
  that records upstream-doc attribution.
- The third-party-docs concern is a **runtime/data** matter (each indexed
  source keeps its own license; we record per-document attribution) and is
  orthogonal to the code license — so it does not push toward copyleft.

## Consequences

- All published packages carry `Apache-2.0`: `package.json` (`@strummer/*`),
  `pyproject.toml`.
- Distributions must retain `LICENSE` + `NOTICE`; downstreams must propagate the
  NOTICE attributions per §4(d).
- Source-file license headers are optional for now; the repo-level LICENSE +
  package metadata are authoritative.
