# CLAUDE.md — how we build Strummer

This file is the contract for how work is done in this repo. Read it fully at
the start of every session. If you are resuming cold, also read `STATUS.md`,
`ROADMAP.md`, and the project memories before touching anything.

## What Strummer is

An LLM-agent-first developer testing & verification toolkit, delivered as a
headless **MCP server** + a human **CLI**. Three pillars (docs, API testing,
browser testing) plus cross-cutting verification tools. See `README.md` for the
vision and `ARCHITECTURE.md` for the technical design.

## Prime directives (non-negotiable)

1. **TDD always: red → green → commit.** Write a failing test first. Make it
   pass with the smallest change. Only then commit. No production code without a
   test that demanded it.
2. **Nothing is committed or pushed unless linters and test suites are 100%
   green.** This is a hard gate. "Green" means every package, both languages.
3. **Brainstorm before building; develop with subagents.** Non-trivial work
   starts with a short design pass and makes **liberal use of Dynamic Workflows
   ("fan out")** — parallel research, parallel implementation of independent
   units, adversarial verification of findings.
4. **Aspirational by default.** "Not needed for v1" is an anti-pattern here.
   Design for the top-tier tool; stage the work in `ROADMAP.md`, don't amputate
   it.
5. **Commit directly to `main`. Push to GitHub at milestones** (not every
   commit). Remote: `https://github.com/ceautery/strummer`.
6. **Update notes after every milestone**: memories, `ROADMAP.md`, `STATUS.md`.
   A milestone is not done until the notes reflect reality.

## The two questions that must always have a fresh, correct answer

- **"What phase are we on?"** → the top of `STATUS.md`. Keep it current.
- **"Pick up from where we left off."** → `STATUS.md` (current phase + next
  action) → `ROADMAP.md` (the plan) → project memories → recent git log. These
  must be enough to resume from a fresh session with zero in-memory context. If
  they aren't, that's a bug in the notes — fix it.

## Architecture rules

- **Agent-first.** Every capability is an MCP tool/resource with a structured,
  token-efficient output. Large artifacts (doc bodies, traces, screenshots,
  request logs) are returned by **handle/resource link**, not inlined.
- **Polyglot boundary is a file.** Python (ingestion/indexing) and TypeScript
  (serving) communicate through a **SQLite database on disk** (FTS5 + optional
  `sqlite-vec`), never a live RPC. Each side's green gate is independent.
- **Version-pinned, not "latest".** The docs pillar must answer for the version
  of a dependency that is *actually installed* in the target project.

## Toolchain & commands

> Exact versions and the definitive list live in `ARCHITECTURE.md`. This section
> is the muscle-memory cheat sheet; keep it in sync when the scaffold changes.

- **TypeScript:** Node 22, pnpm workspaces. Lint/format: **Biome**. Test:
  **Vitest** (the TDD loop). 
- **Python:** docs-ingestion package. Lint/format: **Ruff**. Test: **pytest**.
- **The green gate (run before every commit):**
  ```
  pnpm gate
  ```
  Runs Biome (lint+format) → tsc typecheck (all TS packages) → Vitest, then
  Ruff (lint+format) → pytest. Defined in `scripts/gate.sh`. Nothing commits or
  pushes unless this is 100% green.

## Working with Dynamic Workflows

- Use fan-out for: broad research before a design decision, implementing several
  independent units in parallel, and adversarially verifying findings/claims
  before trusting them.
- Prefer `pipeline()` (no barrier) unless a stage genuinely needs all prior
  results at once.
- Keep the human in the loop between phases: read results, decide, then fan out
  the next phase.

## Definition of done for a milestone

- [ ] Feature has tests written test-first; suite is 100% green.
- [ ] Both linters pass (Biome, Ruff) with zero warnings.
- [ ] `STATUS.md` updated (phase, what's done, next action).
- [ ] `ROADMAP.md` reflects any scope/sequence changes.
- [ ] Memories updated for anything non-obvious worth carrying forward.
- [ ] Committed to `main`; pushed to GitHub if this is a milestone boundary.

## Repo map

- `README.md` — vision & overview.
- `CLAUDE.md` — this file; how we work.
- `ARCHITECTURE.md` — technical design, exact stack, the SQLite contract. *(authored after design research; see STATUS.md)*
- `ROADMAP.md` — phased plan.
- `STATUS.md` — current phase + how to resume. **Always current.**
- `docs/decisions/` — Architecture Decision Records (ADRs).
- `packages/` — TS workspace: `core` (docs domain + SQLite), `embed` (query
  embedding), `api` (API-testing engine: `.bru`, runner, assertions, secrets,
  safety, scripts), `browser` (browser/UI engine: lifecycle, ARIA-snapshot +
  step tools, action gate, two-tier SSRF, a11y audit, HAR capture/replay,
  video capture, persisted `.bru` flows — on `playwright-core`),
  `safety` (shared SSRF range classifier + secret redaction, used by `api` +
  `browser`), `assert` (shared declarative-assertion operator core — `AssertionOp`
  + `applyOp` — used by `api` + `browser`), `mcp` (server), `cli` (terminal).
- `py/strummer_ingest/` — Python ingester (uv).
- `schema/` — the SQLite contract (`*.sql` + `*.json`).
- `examples/` — runnable sample collections (e.g. `examples/api/jsonplaceholder`,
  used by the `@strummer/cli` API quickstart).
- `.github/workflows/ci.yml` — CI mirroring `pnpm gate` on push/PR.
- The Linux dev-container harness (`docker/`, `docker-compose.yml`) that hosts
  Claude Code is **untracked** (gitignored) — local tooling for creating the
  container, not part of Strummer.
