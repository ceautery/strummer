# ADR 0008 — Headless-only; drop developer live-view (LLM-first observability)

- **Status:** Accepted
- **Date:** 2026-06-01

## Context

The Phase-3 ROADMAP carried a "developer live-view" item: let a human *watch* a
live browser session render, via either headless + `--remote-debugging-port`
(attach DevTools / `chrome://inspect`) or an operator-gated headed profile
(Xvfb → x11vnc → noVNC). The framing was "observability, not the agent path".

Two things changed the calculus:

1. **Sackville is LLM-first.** The primary user is an agent, and the human's
   highest-value interaction is *asking questions about a run* — e.g. "navigate
   to the personnel page and tell me what AJAX requests happen" — not physically
   watching pixels paint. The CLI is a thin wrapper that lets a new dev see how
   the engine behaves; it is not the product.
2. **We already have better observability than a live render.** The pillar ships
   `browser_trace_query` (a structured action + console + network timeline from
   the Playwright trace), HAR capture, the console/network artifact channels, and
   webm video — all deterministic, CI-friendly, queryable after the fact, and
   *answerable in natural language by the agent*. A human staring at a headed
   window gets less, and gets it non-reproducibly.

The live-view paths also carry real cost: the headed profile needs Xvfb/VNC infra
that fights the container-hardening posture (ADR 0007), and the headless
`--remote-debugging-port` path is finicky alongside `playwright-core`'s own CDP
channel. Neither is buildable in the dev container; both would only exist for the
deprioritized "watch it render" use case.

## Decision

**Commit to headless only. Drop developer live-view from the plan — explicitly
cut, not deferred.** Spend no effort on the Xvfb → x11vnc → noVNC headed profile
or on `--remote-debugging-port` DevTools attach.

For *reviewing* a run, the deterministic, LLM-queryable artifacts are the path:
the trace timeline, HAR, console/network channels, video, and screenshots — each
returned by handle and summarizable by the agent.

The CLI's single-shot `--headed` launch flag stays as a trivial escape hatch for
environments that happen to have a display; it is **not** a live-view feature and
gets no further investment (no VNC, no remote-debugging wiring).

## Consequences

- This is a deliberate exception to the repo's "aspirational by default, schedule
  don't amputate" stance (CLAUDE.md): live-view is cut on a *product-direction*
  judgment (LLM-first), not because it is v1-hard. Recording it here so it is not
  silently re-added later.
- The remaining Phase-3 tail is **multi-engine (firefox/webkit)** only, still
  blocked on the CI/Docker image (chromium-only in the dev container).
- No code changes: live-view was never built. ROADMAP/STATUS/README updated to
  reflect the cut. Relates to ADR 0006 (browser-pillar design) and ADR 0007
  (container hardening, which the headed profile would have fought).
