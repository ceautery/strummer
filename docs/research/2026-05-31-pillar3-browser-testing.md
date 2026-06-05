# Pillar 3 design research — 2026-05-31

Raw output of the 5-stream browser/UI-testing research workflow → lead-architect
synthesis → adversarial verification. Distilled into **ADR 0006** and
**ARCHITECTURE.md §10**. When those disagree with this archive, they win.

The workflow ran 14 agents (~428k subagent tokens): 5 parallel web-research
streams, one synthesis, and 8 adversarial verifiers each told to *refute* a
load-bearing claim. The adversarial pass refuted one claim and corrected two
(see **§ Adversarial verification** below) — those corrections are already
folded into the synthesis recorded here.

---

## Synthesis (the recommended design)

Phase 3 adds Sackville's browser/UI testing pillar as a **new pure-TypeScript
package, `@sackville/browser`, built thin on stable `playwright-core` 1.60.0** —
NOT a wrap of `@playwright/mcp`. The pillar reimplements the API pillar's house
pattern (a pure engine that owns the safety gate + artifact plumbing, consumed
by thin `mcp` + `cli` adapters) for a browser: a long-lived headless Chromium
drives pages via the **accessibility/ARIA-snapshot model** (token-efficient,
deterministic) with vision/coordinate tools as an operator-gated capability.
Every large artifact (trace.zip, screenshots, video, HAR, console/network logs,
storageState, axe/Lighthouse reports) is returned only by a
`sackville://browser/run/<id>/<kind>` handle with a token-cheap structured
summary; nothing is inlined.

Safety is operator-set and deny-by-default, layered: a Tier-1
`browserContext.route` allowlist for legible per-request decisions plus a Tier-2
loopback DNS-pinning proxy (reusing the API pillar's SSRF range-block logic)
that closes the DNS-rebinding hole `route()` structurally cannot see. Reads
(snapshot/query/screenshot of an already-loaded allowlisted page, a11y audit)
are free; navigation, mutating interactions, downloads, uploads, dialog-accept,
and HTTP auth are gated behind operator unlock + allowlist, with an
interception-based dry-run that previews the request a click *would* fire. Audit
tools (a11y via `@axe-core/playwright`, perf via the Lighthouse node API over
CDP) ride the same handle/summary split. Tests are hermetic and offline: an
in-process `node:http` fixture server on an ephemeral 127.0.0.1 port (the exact
pattern already in `packages/api/src/runner.test.ts`), one headless Chromium per
file, version-pinned browser binaries.

### Numbered decisions (→ ADR 0006)

1. **New package `@sackville/browser`, thin on `playwright-core`; engine owns the
   safety gate.** Do not wrap/embed `@playwright/mcp` as a runtime dependency.
   *Alt rejected:* wrap as primary (alpha core pin, inline artifacts, churny
   0.0.x line); embed as optional backend via `createConnection()` (deferred to
   ROADMAP — a single code path keeps control of pin/safety/handles).
2. **ARIA-snapshot-first driving model with ref-id step tools; vision opt-in.**
   Imperative step tools over per-snapshot element ref-ids + semantic locators;
   refs stamped per snapshot, never persisted. Vision/coordinate behind an
   operator-gated `vision` capability. Autonomous self-healing replay rejected
   for v1. *Alt rejected:* persist refs (they invalidate); pixels as default
   (token cost + nondeterminism).
3. **All artifacts by handle; on-disk store; trace via the 1.60 trace CLI.**
   Capture trace.zip (`tracing.start{screenshots,snapshots,sources}`→`stop`),
   optional video (webm), HAR, and own console/network logs to a per-run temp
   dir; register each as `sackville://browser/run/<id>/<kind>`. Tool results
   return only structured summaries + handles. Expose trace via a
   `browser_trace_query` tool that wraps the agent-targeted `npx playwright
   trace` subcommands, with a direct trace.zip JSON-lines parser as the
   offline/version fallback. *(See adversarial correction #1 on the exact
   subcommand surface.)*
4. **Deny-by-default action gate.** Reads free; navigation to a new origin,
   mutating interactions, downloads, uploads, `dialog.accept()`/`beforeunload`,
   and HTTP auth gated behind run-scoped operator unlock + host allowlist.
   Mutating interactions support a `dry_run` that arms a one-shot route,
   observes the request the action *would* fire (method/postData), aborts it,
   and returns a redacted preview — the browser analogue of the API mutation
   dry-run. Dialogs auto-dismiss by default; `serviceWorkers:'block'` default.
5. **Two-tier SSRF defense: route allowlist + loopback DNS-pinning proxy.**
   Tier-1 `route('**/*')` deny-by-default handler aborts any host not on the
   allowlist and unconditionally aborts private/link-local/metadata literals
   (169.254.169.254, 169.254/16, 127/8, 10/8, 172.16/12, 192.168/16, ::1,
   fc00::/7, fe80::/10, 0.0.0.0, metadata.google.internal). Tier-2: launch
   Chromium through Sackville's own loopback forward proxy (`proxy:{server}`)
   that re-resolves + pins the resolved IP, rejects blocked ranges, re-checks on
   each redirect — reusing the shared range classifier. *Alt rejected:* route
   only (DNS-rebinding hole); proxy only (loses legible per-request decisions).
   WebRTC/QUIC can bypass an HTTP proxy → disable WebRTC in the hardened profile
   (scheduled).
6. **Secrets injected at the fill/auth boundary; everything redacted before any
   artifact is written.** `{{secret:NAME}}` form-fill placeholder resolved
   immediately before `locator.fill()`; HTTP Basic via origin-scoped
   `httpCredentials` from operator config. Every captured artifact (console,
   request/response headers+bodies, HAR, trace network data, storageState) runs
   through the API pillar's redaction pass before any write. storageState is
   password-equivalent: operator-path only, by handle, scrubbed from traces.
7. **Long-lived server lifecycle, container sandbox posture, capture-cost
   gating.** One browser/server; one ephemeral isolated context per MCP session
   (persistent `userDataDir` operator opt-in). Operator caps: max contexts/pages,
   per-action + per-navigation timeouts, session wall-clock + idle TTL with a
   reaper, max downloaded bytes, artifact retention/GC. Downloads quarantine to
   a fixed dir (saveAs escapes validated); `setInputFiles` confined to an
   operator upload-allowlist dir. Container default: keep the Chromium sandbox
   (seccomp + dropped caps + read-only FS + non-root); `--no-sandbox` is an
   operator-gated fallback recorded in the ADR. Capture levels operator-set
   (`SACKVILLE_BROWSER_ARTIFACTS=trace,console,network` default; `+video`,
   `+fullpage`, `+har-bodies` must be unlocked).
8. **Audit tools (a11y + perf) ride the same handle/summary split.**
   `browser.audit.a11y` via `@axe-core/playwright` 4.11.3
   (`AxeBuilder({page}).analyze()`) — a free read action.
   `browser.audit.perf` drives the Lighthouse 13.3.0 node API directly over CDP
   (not the `playwright-lighthouse` wrapper, which writes files + drifts our
   pin). Both emit a token-cheap summary (a11y: violationCount, counts by
   impact, top-N; perf: category scores + LCP/CLS/TBT) with full reports behind
   handles. Assert on shape/thresholds, never exact perf scores.

### Cross-pillar refactor

Lift the SSRF/private-IP range classifier (`ipaddr.js`-based) and the
secret-resolution + redaction boundary out of `@sackville/api` into a small
shared **`@sackville/safety`** module consumed by both `api` and `browser`, so one
allow/deny + redaction policy governs both pillars. The artifact handle store is
*extended, not reused verbatim*: today's `packages/api/src/artifacts.ts` is an
in-memory `Map` of strings; browser artifacts are large/binary, so
`@sackville/browser` gets an **on-disk-backed** `ArtifactStore` keyed
`sackville://browser/run/<id>/<kind>[/<sub>]` storing
`{path, contentType, byteSize, sha256}`.

### Stack picks (versions verified against the npm registry on 2026-05-31)

| Package | Version | Purpose |
| --- | --- | --- |
| `playwright-core` | **1.60.0** | Sole engine (lifecycle, ARIA snapshot, tracing+HAR, recordVideo, route, proxy, downloads/uploads, dialogs, httpCredentials, storageState, screenshots). Pinned stable (Apache-2.0, node≥18); pins the Chromium binary revision. |
| `@modelcontextprotocol/sdk` | 1.29.x | MCP surface (matches the rest of Sackville). |
| `npx playwright trace` (ships with `playwright` 1.60.0) | 1.60.0 | Agent-targeted headless trace reader wrapped by `browser_trace_query`. Introduced 1.59. |
| `@axe-core/playwright` | 4.11.3 | a11y audit (MPL-2.0; peer `playwright-core>=1.0.0`). |
| `axe-core` | 4.11.4 | Underlying a11y engine (transitive, MPL-2.0). |
| `lighthouse` | 13.3.0 | Perf audit over CDP (Apache-2.0; node≥22.19 — fits Node 22). |
| `ipaddr.js` | 2.x | CIDR membership for the shared SSRF classifier. |
| `mcr.microsoft.com/playwright:v1.60.0-noble` | matched | Reproducible headless Chromium + deterministic fonts for CI / visual baselines. |
| `odiff` (`odiff-bin`) | 3.x | *Optional* SIMD image-diff for large corpora; default comparator is Playwright's pixelmatch-backed `toHaveScreenshot`. Deferred past slice 1. |
| `@playwright/mcp` | 0.0.75 (**reference only**) | Design reference for tool taxonomy + ARIA serializer (Apache-2.0, copy with attribution). NOT a runtime dep — pins `playwright 1.61.0-alpha`. |

### Open forks (defaults chosen)

- **Per-session context isolation** → ephemeral isolated `BrowserContext` per
  session; persistent `userDataDir` operator opt-in.
- **ARIA serializer** → copy `@playwright/mcp`'s Apache-2.0 serializer with
  attribution (playwright-core's `_snapshotForAI` is private/unstable), adapt
  for handle-based/token-capped/diff output. Manual-sync burden noted.
- **Default network capture** → our own `page.on('request'|'response'|…)`
  redacted JSON log, bodies-by-handle; `recordHar content:'attach' .zip` (or
  `tracing.startHar`) as the operator-gated heavy mode. Never `content:'embed'`.
- **Container sandbox** → keep the Chromium sandbox (seccomp + dropped caps +
  read-only FS + non-root); `--no-sandbox` only as a documented operator-gated
  fallback compensated by the SSRF proxy + FS confinement.
- **Trace consumption** → hybrid: wrap the trace CLI primarily, direct
  JSON-lines parser as the offline/version fallback.
- **`createConnection()` embed of `@playwright/mcp`** → no for v1; scheduled
  behind a feature flag for parity testing.

### First red→green slice

The **a11y-audit summarizer** against an in-process fixture — no pixels, no
perf, no CDP, no network. A failing Vitest test: (1) `node:http` `createServer`
returns a tiny HTML page with one known violation (`<img>` with no `alt`),
`listen(0,'127.0.0.1')`, reads `address().port`; (2) launch headless chromium
once via `playwright-core` 1.60.0, navigate to `http://127.0.0.1:{port}`; (3)
`AxeBuilder({page}).analyze()`; (4) assert `summarize(results)` returns
`violationCount>=1`, includes the `image-alt` rule id bucketed by impact, and
that the full Results are addressable by a `sackville://browser/run/<id>/a11y`
handle. Make it pass with the smallest `summarize()` + an on-disk-backed
`ArtifactStore.put/get`. Exercises every architectural seam at minimum size,
fully deterministic and offline (`image-alt` is a rock-stable axe finding), and
defers visual baselines + Lighthouse scores (the flaky parts) to later slices.

---

## Adversarial verification (8 verifiers, each told to refute)

- ✅ **SUPPORTED** — `playwright-core`/`playwright` latest stable is **1.60.0**
  (Apache-2.0, node≥18) as of 2026-05-31, confirmed via the npm registry.
- ✅ **SUPPORTED** — `@playwright/mcp@0.0.75` (latest dist-tag) hard-pins
  `playwright`/`playwright-core` to **`1.61.0-alpha-1778188671000`** (a
  timestamped prerelease, not the `latest` stable). This is the disqualifier for
  using it as a runtime dep. *Nuance:* point-in-time; a later 0.0.x may re-pin
  to a stable Playwright once 1.61 GAs.
- ❌ **REFUTED (corrected)** — the `npx playwright trace` subcommands are **not**
  `actions/snapshot/network/console/errors`. The actual 1.59 subcommands are
  **`open`, `actions`, `action`, `snapshot`, `close`** — there are no
  `network`/`console`/`errors` subcommands. The agent-targeted trace CLI and
  "CLI debugger for agents" (`--debug=cli`) do exist in 1.59 and persist in
  1.60; 1.60 additionally adds HAR-on-tracing. **Design impact:** treat
  console/network/error data as content surfaced *within* `actions`/`snapshot`
  output and via separate trace artifacts, not as dedicated `trace` subcommands;
  verify the exact subcommand surface against the installed Playwright version
  before wiring tools. Source of truth:
  `https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/release-notes-js.md`.
- ✅ **SUPPORTED** — Playwright 1.60 adds HAR recording on the tracing API
  (`tracing.startHar`/`stopHar`, same content/mode/urlFilter options as
  `recordHar`). HAR-on-tracing does **not** exempt the resulting `.har`/`.zip`
  from the artifact-by-handle rule.
- ✅ **SUPPORTED** — `@axe-core/playwright` 4.11.3 is MPL-2.0, peer
  `playwright-core >= 1.0.0`, depends on `axe-core ~4.11.4`.
- ⚠️ **UNCERTAIN → corrected** — Lighthouse 13.3.0 registry facts confirmed, but
  the synthesis's worry that `@sentry/node` must be made "inert/offline" is
  **not load-bearing**: Sentry telemetry in Lighthouse is opt-in and off by
  default. **Design impact:** drop the "ensure @sentry/node inert" caveat.
- ✅ **SUPPORTED** — Playwright `route()`/`page.route()` expose
  URL/method/resourceType/isNavigationRequest/postData/redirect chain but **not
  the resolved socket IP** — confirming the need for a Tier-2 connection-time
  proxy to close DNS rebinding. *Refinement:* the resolved IP *is* available
  post-connection via `Response.serverAddr()` (can be null), just not at
  intercept time. Conclusion unchanged.
- ✅ **SUPPORTED** — Playwright performs **no** secret redaction in captured
  console/network/HAR/trace artifacts (maintainers explicitly punt it to the
  user; the one shipped redaction is the `Authorization` header in an APIContext
  request-timeout *call log* only). Confirms Sackville must run its own redaction
  pass before any artifact write.

---

## Per-stream notes, risks, and sources

### Stream A — Playwright + MCP integration landscape (wrap vs build)

Decisive mismatches push to **build-thin on stable `playwright-core` 1.60.0**,
reusing `@playwright/mcp`'s ARIA-snapshot *driving model* as a reference (and
optionally its Apache-2.0 serializer with attribution) but owning the tool
schemas, artifact handles, safety gate, and version pin.

Risks: `@playwright/mcp` 0.0.x churn (documented regressions, a corrupted
inline-screenshot bug causing API 400s); its alpha-core pin; serializer-copy
sync burden; long-lived-server leaks (orphaned Chromium / unbounded contexts /
large artifacts → need a reaper + GC); container `--no-sandbox` only acceptable
because the container is the trust boundary; browser-binary revision coupled to
core version (bumps = milestone changes, refresh golden artifacts); secrets in
HAR/network unless redacted at write; green-gate determinism (real-browser tests
must be offline against fixtures).

Sources: github.com/microsoft/playwright-mcp · npmjs.com/package/@playwright/mcp
· playwright.dev/mcp/capabilities · playwright.dev/mcp/vision-mode ·
npmjs.com/package/playwright-core · playwright.dev/docs/release-notes ·
playwright.dev/docs/api/class-tracing · playwright.dev/docs/api/class-browsercontext
· playwright.dev/docs/mock · playwright.dev/docs/docker · playwright.dev/docs/ci
· github.com/microsoft/playwright-mcp/issues (#1140/#1359/#1211) ·
testdino.com/blog/playwright-mcp-troubleshooting.

### Stream B — Agent driving / authoring model

Hybrid imperative step tools over ARIA-snapshot ref-ids; reuse the
`@sackville/api` assertion engine (add `text`/`element-visible`/`value`/`url`/
`ariaSnapshot` sources, auto-waiting); `.bru`-style steps file + sidecar using
semantic locators (refs invalidate). Reject autonomous record/replay for v1.

Risks: context bloat after ~10–12 steps (scoped-diff + handle cap); ref
staleness (stamp per snapshot, never persist); determinism (auto-waiting,
offline fixtures); vision cost (operator-gate, by handle); ARIA brittleness
(subset match); format drift (keep the sidecar).

Sources: playwright.dev/mcp/snapshots · playwright.dev/docs/aria-snapshots ·
playwright.dev/docs/test-assertions · playwright.dev/docs/trace-viewer ·
github.com/microsoft/playwright-mcp · bug0.com/blog/stagehand-passmark.

### Stream C — Artifacts & observability

Record to a per-run temp dir, register each as
`sackville://browser/run/<id>/<kind>`; tool results return only summaries +
handles. Trace consumed via the 1.59+ agent-targeted CLI (hybrid with a
JSON-lines parser fallback). Visual comparator: `toHaveScreenshot` (pixelmatch)
default, `odiff` opt-in for large corpora; baselines generated **in the pinned
Docker image**, keyed by (name, browser, platform).

Risks: cross-OS font/subpixel rendering is the dominant visual-flake source
(generate baselines in-container only, `animations:'disabled'`+`caret:'hide'`);
Playwright doesn't redact secrets in artifacts (redact before persist, incl.
trace network data); trace/video size blowup (on-disk store, handles, caps,
capture-level gating); CLI text-format coupling (parser fallback + version pin);
HAR `content:'embed'` / uncapped video (operator-gate, default `attach`+.zip);
determinism-vs-realism of masking; the hosted trace viewer is GUI-only (agent
path is CLI/parse).

Sources: playwright.dev/docs/api/class-tracing · playwright.dev/docs/trace-viewer
· trace.playwright.dev · github.com/iloveitaly/playwright-trace-analyzer ·
testdino.com/blog/playwright-release-guide · playwright.dev/docs/test-snapshots ·
testdino.com/blog/playwright-visual-testing ·
houseful.blog/posts/2023/fix-flaky-playwright-visual-regression-tests ·
github.com/dmtrKovalenko/odiff · vizzly.dev/blog/honeydiff-vs-odiff-pixelmatch-benchmarks
· playwright.dev/docs/network · playwright.dev/docs/screenshots ·
playwright.dev/docs/videos · github.com/microsoft/playwright/issues/31717 ·
github.com/microsoft/playwright/issues/23654.

### Stream D — Safety & sandboxing

Reimplement the API pillar's deny-by-default model for a browser, with the
structural caveat that `route()` sees the hostname/URL but not the resolved IP →
true SSRF protection needs a connection-time (proxy) layer with DNS pinning +
redirect re-check. Interception-based mutation dry-run; `serviceWorkers:'block'`;
download quarantine + upload-allowlist dir with airtight path validation;
keep-the-sandbox container posture; secrets at the fill boundary, redacted
everywhere; all unlocks operator-set (no MCP arg can flip a safety flag).

Risks: DNS rebinding bypasses hostname allowlisting (must back with the proxy);
Service Workers bypass `route()` unless blocked; WebSocket/WebRTC/QUIC may evade
an HTTP proxy (disable WebRTC in the hardened profile); trace/HAR/storageState
capture secrets verbatim (redact before exposing); `--no-sandbox` + renderer RCE
= host-compromise path (document residual risk in an ADR); `setInputFiles`
relative-path / `download.saveAs()` arbitrary-path footguns (validate, unit-test);
offline green-gate (local fake metadata endpoint + controllable DNS/proxy
harness, never hit 169.254.169.254 for real).

Sources: playwright.dev/docs/network · playwright.dev/docs/api/class-route ·
playwright.dev/docs/api/class-request · playwright.dev/docs/downloads ·
playwright.dev/docs/api/class-filechooser · playwright.dev/docs/dialogs ·
playwright.dev/docs/auth · playwright.dev/docs/api/class-browsercontext ·
npmjs.com/package/playwright · craftcms GHSA-gp2f-7wcm-5fhx (DNS-rebinding SSRF
bypass) · behradtaher.dev/DNS-Rebinding-Attacks-Against-SSRF-Protections ·
wiz.io/academy/.../server-side-request-forgery ·
medium.com/code-and-coffee/running-chromium-in-docker-without-selling-your-soul ·
puppeteer.guide/posts/sandbox · browserstack.com/guide/playwright-block-request.

### Stream E — a11y/perf audits + deterministic TDD/CI

a11y: `@axe-core/playwright` 4.11.3 (MPL-2.0) wrapping `axe-core` 4.11.4; peer is
only `playwright-core>=1.0.0`. Perf: drive the `lighthouse` 13.3.0 node API
directly over CDP (not `playwright-lighthouse`, which writes `./lighthouse` files
and pins old peers). Summaries cheap, full reports by handle. TDD: in-process
`node:http` fixture server on an ephemeral 127.0.0.1 port (the
`packages/api/src/runner.test.ts` pattern), one headless Chromium per file,
binaries from the pinned `mcr.microsoft.com/playwright:v1.60.0-noble` image.
Slice 1 has no pixels; chromium-only for v1 (Lighthouse needs Chromium/CDP).

Risks: Lighthouse's large transitive tree + Apache-2.0 vs MPL-2.0 axe stack (vet
licenses); `playwright-lighthouse` disk side effects + peer drift (call
Lighthouse directly); perf scores are run-to-run variable (assert
shape/thresholds, never exact); CI image tag must stay in lockstep with the
lockfile Playwright version; visual flake (baselines in-container, out of slice
1); axe injection fails under strict CSP (fixtures must allow it, surface a clear
error); Lighthouse HTML/traces need the handle store (never inline).

Sources: npmjs.com/package/@axe-core/playwright ·
github.com/dequelabs/axe-core-npm/.../playwright/README.md ·
npmjs.com/package/axe-core · github.com/abhinaba-ghosh/playwright-lighthouse ·
github.com/GoogleChrome/lighthouse/.../understanding-results.md ·
playwright.dev/docs/ci · playwright.dev/docs/browsers ·
playwright.dev/docs/test-snapshots · registry.npmjs.org/lighthouse/latest.
