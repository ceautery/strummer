# ADR 0009 — Multi-engine (Firefox + WebKit) support

- **Status:** Accepted
- **Date:** 2026-06-01

## Context

The browser pillar shipped chromium-only. The ROADMAP carried "multi-engine
(firefox/webkit)" as the last Phase-3 tail item, long annotated as "blocked in
the dev container". That annotation was **wrong** (corrected 2026-06-01):
`playwright-core` 1.60.0 ships a working `install` / `install-deps` CLI, the
Playwright CDN is reachable, and once `install-deps` provides the system libs
(GTK/etc. for Firefox; WebKitGTK deps for WebKit) **both engines launch and drive
headless** — verified end-to-end through the full Sackville stack
(`engineLauncher` → `BrowserManager` → `PageDriver`: navigate → ARIA snapshot →
ref click → re-snapshot) against an in-process fixture. So this was never an infra
blocker; it was an unbuilt feature.

A probe also confirmed the driving primitives are engine-portable:
`serviceWorkers:'block'`, `httpCredentials`, `acceptDownloads`, `context.route`,
and `locator.ariaSnapshot()` all behave identically on Firefox and WebKit (the
snapshot serializer produced byte-identical `- button "Go"` output). So
`BrowserManager` and `PageDriver` needed **no changes**.

## Decision

Add engine **selection** at the launch seam, leaving the engine-agnostic core
(`BrowserManager` takes an injected `launch()` thunk) untouched. New
`@sackville-mcp/browser` `engine.ts`:

- `BrowserEngine = 'chromium' | 'firefox' | 'webkit'`; `resolveEngine(name)`
  (default chromium, **throws** on an unknown value so an operator typo fails loud
  rather than silently falling back); `browserTypeFor`; `engineLauncher`.
- `engineLaunchOptions(engine, spec)` is the security-sensitive part. The Tier-2
  **SSRF proxy** (`proxy.server`) is applied to **every** engine. The chromium
  **hardening args** — `--proxy-bypass-list=<-loopback>` (force loopback through
  the pinning proxy, which Chromium otherwise bypasses), `--force-webrtc-ip-
  handling-policy=disable_non_proxied_udp`, and `--no-sandbox` — are **Chromium
  CLI flags** that Firefox/WebKit reject or ignore, so they are emitted **only for
  chromium**.

Surfaces:
- **Bin**: `SACKVILLE_BROWSER_ENGINE` (resolved early, before the proxy is
  allocated); `config.engine` + per-engine `launchArgs` surfaced. **One engine per
  server instance** (per-session engine selection — which would require launching
  multiple browsers — is out of scope).
- **CLI**: `sackville browser … --engine chromium|firefox|webkit`; an unknown
  value is a clean exit-1.
- **CI / dev image**: `playwright-core install --with-deps chromium firefox
  webkit` (the dev `docker/Dockerfile`, gitignored, provisions all three). The
  cross-engine tests `skipIf` the binary is absent, so a chromium-only env still
  goes 100% green.

## Consequences

- **Chromium remains the recommended hardened engine.** For Firefox/WebKit the
  always-on **Tier-1 `context.route` allowlist** + the SSRF proxy are the egress
  controls; the extra chromium loopback-bypass / WebRTC-neutralize args have no
  cross-engine equivalent here. This is a documented posture difference, not a
  regression — the Tier-1 layer (which governs every request) is engine-agnostic.
- **Perf audit stays Chromium.** Lighthouse is Chrome-only and runs its own Chrome
  via `chrome-launcher`, so `browser_perf_audit` always uses chromium regardless
  of the session engine.
- Relates to ADR 0006 (browser-pillar design) and ADR 0008 (headless-only). With
  this, the Phase-3 browser pillar is feature-complete; the only remaining ROADMAP
  items are the explicitly-aspirational bucket (`@playwright/mcp` embed, autonomous
  self-healing, cross-pillar contract tie-in).
