# ADR 0006 — Pillar 3 (browser / UI testing) foundations

- **Status:** Accepted
- **Date:** 2026-05-31

## Context

Pillar 3 adds Playwright-class browser/UI testing, exposed agent-first over MCP
(plus the human CLI). It is all-TypeScript. Grounded by a 5-stream design-research
workflow with adversarial verification
(`docs/research/2026-05-31-pillar3-browser-testing.md`); the adversarial pass
refuted one claim and corrected two (folded in below).

The pillar must honor Strummer's prime directives unchanged: agent-first with
**token-efficient** structured output and **large artifacts by handle**;
**version-pinned, not latest**; **deny-by-default** safety that is **operator-set,
never agent-self-authorized**; secrets resolved only at the transport boundary
and **redacted from every artifact**; and a green gate that forbids
flaky/network-dependent tests.

## Decisions

### 1. New package `@strummer/browser`, thin on `playwright-core`

A pure-TS engine (browser/context/page lifecycle, ARIA-snapshot capture, step
tools, assertions, artifact capture, safety gate, audits) consumed by thin `mcp`
+ `cli` adapters — mirroring `@strummer/api`. Built directly on **stable
`playwright-core` 1.60.0**. We do **not** wrap or embed `@playwright/mcp` as a
runtime dependency: `@playwright/mcp@0.0.75` hard-pins an **alpha**
`playwright-core` (`1.61.0-alpha-…`), inlines large artifacts, and rides a churny
0.0.x line — all disqualifying. It is used as a **design reference** for the tool
taxonomy + ARIA-snapshot model, and its Apache-2.0 ARIA serializer may be
**copied with attribution** (playwright-core's `_snapshotForAI` is private). The
**safety gate lives in `@strummer/browser`**, so every surface enforces it
identically.

### 2. Driving model: ARIA-snapshot-first, imperative step tools over ref-ids

The agent perceives the page as Playwright's **accessibility (ARIA) tree**, not
raw DOM or pixels. Each interactive element is stamped with a short **ref-id**
per snapshot; step tools (`navigate`, `click`, `fill`, `fill_form` batch,
`select`, `press`, `wait_for`, `snapshot`, `query`, `get_text/attr`) act on
ref-ids, which resolve under the hood to semantic locators
(`getByRole`/`getByLabel`) with **auto-waiting**. Refs are **never persisted
across steps** (the DOM changes, refs invalidate); each step returns a
**token-capped scoped snapshot diff + a handle** to the full tree, never the
whole tree. **Vision/coordinate tools** ship behind an operator-gated `vision`
capability for canvas / non-AX-tree UI. Autonomous self-healing replay is
rejected for v1 (scheduled in ROADMAP). On disk, replayable flows are a
`.bru`-style steps file + sidecar using **semantic locators** (not refs).

> **Update (2026-06-01) — how refs are obtained (empirical revision of the
> open-fork default).** The research's open fork resolved to *copy
> `@playwright/mcp`'s Apache-2.0 ARIA serializer*, which consumes
> `page._snapshotForAI()` output. Probing the pinned **`playwright-core` 1.60.0**
> showed that API does **not exist** there (it's a 1.61-alpha feature — exactly
> why `@playwright/mcp` pins the alpha), and `locator.ariaSnapshot({ref:true})`
> emits **no ref-ids** in 1.60.0. So Strummer instead parses the **public, stable
> `locator.ariaSnapshot()` YAML** and **mints its own ref-ids**, each mapping to a
> semantic-locator descriptor (`{role, name, nth}`) resolved via
> `getByRole(role,{name}).nth(nth)`. This keeps us on a stable pinned API (a prime
> directive) and avoids a code-copy sync burden, at the cost of owning a small
> snapshot parser. Implemented in `packages/browser/src/snapshot.ts`
> (`buildSnapshot`/`captureSnapshot`/`diffSnapshots`).

### 3. All artifacts by handle; on-disk store; trace via the trace CLI

Capture trace.zip (`tracing.start{screenshots,snapshots,sources}`→`stop`),
optional video (webm), HAR, and our own console/network logs to a per-run temp
dir; register each as `strummer://browser/run/<id>/<kind>` in an **on-disk-backed
`ArtifactStore`** (`{path, contentType, byteSize, sha256}`) — the binary-artifact
extension of the API pillar's in-memory handle store. Tool results return only
structured summaries (counts, sizes, top errors, action list, pass/fail) +
handles. Trace is read by a `browser_trace_query` tool that **wraps the
agent-targeted `npx playwright trace` CLI** (subcommands `open`, `actions`,
`action`, `snapshot`, `close` — introduced 1.59, present in 1.60), with a direct
trace.zip JSON-lines parser as the offline/version fallback.

> **Correction folded in (adversarial):** there are **no** `network`/`console`/
> `errors` subcommands of `npx playwright trace`. Console/network/error data is
> surfaced *within* `actions`/`snapshot` output and via separate trace artifacts.
> Verify the exact subcommand surface against the installed Playwright version
> before wiring tools — the CLI is new and may evolve.

### 4. Safety: deny-by-default action gate with interception dry-run

Reads (snapshot, query, `get_text/attr`, screenshot of an already-loaded
allowlisted page, a11y audit) run freely. Navigation to a new origin, mutating
interactions, downloads, uploads, `dialog.accept()`/`beforeunload`, and HTTP auth
are gated behind run-scoped **operator** unlock + a host allowlist. Mutating
interactions support a **`dry_run`**: arm a one-shot route, observe the request
the action *would* fire (method/postData), abort it, return a redacted preview —
the browser analogue of the API pillar's mutation dry-run. Dialogs auto-dismiss
by default; `serviceWorkers:'block'` by default. **No MCP tool argument can flip
a safety flag** — unlocks come only from the server bin's env/config.

### 5. SSRF: two-tier (route allowlist + loopback DNS-pinning proxy)

`route()` sees the hostname/URL but **not the resolved IP**, so hostname
allowlisting alone is bypassable by DNS rebinding. Therefore: **Tier-1** a
`route('**/*')` deny-by-default handler aborts non-allowlisted hosts and
unconditionally aborts private/link-local/metadata literals (169.254.169.254,
169.254/16, 127/8, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7, fe80::/10,
0.0.0.0, metadata.google.internal); **Tier-2** launch Chromium through
Strummer's own loopback forward proxy (`proxy:{server}`) that re-resolves +
**pins** the resolved IP, rejects blocked ranges, and re-checks on each redirect
— reusing the shared range classifier. WebRTC/QUIC can bypass an HTTP proxy, so
the hardened profile disables WebRTC (scheduled).

> **Update (2026-06-01) — Tier-1 is allowlist-authoritative.** In implementation
> the Tier-1 `route('**/*')` handler blocks purely on the **operator allowlist**
> (`gate.isHostAllowed`), rather than *unconditionally* aborting private/metadata
> literals. Deny-by-default already blocks those literals (they're never
> allowlisted), and making the block unconditional would break the **primary
> localhost-testing use case** — an operator deliberately allowlisting
> `127.0.0.1` to test a local app. The IP-range classifier (`isBlockedIp`/
> `isBlockedHost`/`resolveAndPin` in `@strummer/safety`) therefore belongs to
> **Tier-2** (connection-time, where the resolved IP is visible and
> allowlisted-hostname DNS-rebinding is the real threat). The shared SSRF
> classifier + the `Redactor` now live in **`@strummer/safety`**, consumed by
> both pillars. Implemented: `packages/safety/src/ssrf.ts`,
> `packages/browser/src/routes.ts` (Tier-1); Tier-2 proxy is the next slice.

### 6. Secrets at the fill/auth boundary; redact before any write

`{{secret:NAME}}` form-fill placeholders resolve server-side immediately before
`locator.fill()` (cleartext lives only in the browser input, never in tool args
or the agent-visible model). HTTP Basic uses **origin-scoped** `httpCredentials`
from operator config. Every captured artifact (console, request/response
headers+bodies, HAR, trace network data, storageState) runs through the API
pillar's **redaction pass before any disk write** — Playwright itself does **no**
artifact redaction. `storageState` is **password-equivalent**: operator-path
only, by handle, scrubbed from traces.

### 7. Lifecycle, container posture, capture-cost gating

One browser per server; one **ephemeral isolated `BrowserContext` per MCP
session** (cookies/storage live for the session; persistent `userDataDir` is an
operator opt-in for login reuse). Operator caps: max contexts/pages, per-action +
per-navigation timeouts, session wall-clock + idle TTL with an idle-context
reaper, max downloaded bytes, artifact retention/GC. Downloads quarantine to a
fixed dir (saveAs escapes rejected); `setInputFiles` confined to an operator
upload-allowlist dir (airtight, unit-tested path validation). Container default:
**keep the Chromium sandbox** (seccomp + dropped caps + read-only FS + non-root);
`--no-sandbox` is an operator-gated fallback (residual renderer-RCE risk recorded
here, compensated by the SSRF proxy + FS confinement). Capture levels are
operator-set (`STRUMMER_BROWSER_ARTIFACTS=trace,console,network` default;
`+video`/`+fullpage`/`+har-bodies` must be unlocked); agents may request a level
but cannot self-authorize heavier/PII-risky capture.

### 8. Audits (a11y + perf) ride the same handle/summary split

`browser.audit.a11y` via `@axe-core/playwright` 4.11.3
(`AxeBuilder({page}).withTags([…]).analyze()`) — a free read action. `browser.
audit.perf` drives the **Lighthouse 13.3.0 node API directly over CDP** (not the
`playwright-lighthouse` wrapper, which writes files + drifts our pin). Both emit
a token-cheap summary (a11y: violationCount, counts by impact, top-N
`{id,impact,help,helpUrl,nodeCount}`; perf: category scores + LCP/CLS/TBT) with
the full axe Results / full LHR JSON+HTML behind handles. **Assert on
shape/thresholds, never exact perf scores** (run-to-run variable).

> **Correction folded in (adversarial):** the concern that Lighthouse's
> `@sentry/node` must be made "inert/offline" is **not** load-bearing — its
> telemetry is opt-in and off by default.

### Cross-pillar refactor

Lift the SSRF/private-IP range classifier (`ipaddr.js`) and the secret-resolution
+ redaction boundary out of `@strummer/api` into a shared **`@strummer/safety`**
module consumed by both pillars, so one allow/deny + redaction policy governs
`api` and `browser`.

## Stack picks (verified on npm 2026-05-31)

`playwright-core` **1.60.0** (Apache-2.0, node≥18; pins the Chromium binary) ·
`@modelcontextprotocol/sdk` 1.29.x · `npx playwright trace` CLI (ships with
`playwright` 1.60.0) · `@axe-core/playwright` 4.11.3 + `axe-core` 4.11.4
(MPL-2.0) · `lighthouse` 13.3.0 (Apache-2.0, node≥22.19) · `ipaddr.js` 2.x ·
`mcr.microsoft.com/playwright:v1.60.0-noble` (CI / visual baselines) · `odiff`
3.x (optional, large-corpus diff; default comparator is `toHaveScreenshot`
pixelmatch) · Biome / Vitest / tsdown (workspace-pinned). **Reference only, not a
dependency:** `@playwright/mcp` 0.0.75 (pins `playwright 1.61.0-alpha`). **Avoid:**
`@playwright/mcp` as a runtime dep, `playwright-lighthouse` wrapper, inline
artifacts, `--no-sandbox` by default, HAR `content:'embed'`.

## First red→green slice

The a11y-audit summarizer against an in-process `node:http` fixture (one `<img>`
missing `alt`): launch headless chromium → `AxeBuilder({page}).analyze()` →
assert `summarize()` returns `violationCount>=1` + the `image-alt` rule bucketed
by impact + the full Results addressable by a `strummer://browser/run/<id>/a11y`
handle. No pixels, no perf, no network — deterministic and offline. Exercises
every architectural seam (browser launch, fixture server, audit, token-efficient
summary, on-disk handle store) at minimum size. Visual baselines and Lighthouse
scores (the flaky parts) are deferred to later slices.

## Consequences

- Browser-binary revision is coupled to the `playwright-core` version: a core
  bump silently changes Chromium and can shift snapshot/AX-tree output and
  screenshots, so bumps are **milestone changes** with re-pinned binaries and
  refreshed golden artifacts. The CI Docker tag stays in lockstep with the
  lockfile version.
- Copying `@playwright/mcp`'s ARIA serializer adds a manual-sync burden (its
  output format can change across releases) — the trade for decoupling from its
  0.0.x churn.
- `--no-sandbox` as a container fallback leaves a residual renderer-RCE→host
  path, only partially compensated; documented here, revisited if the container
  trust boundary changes.
- A larger v1 surface than a declarative-only tool (live browser, vision
  capability, audits), per the aspirational-by-default directive — hard items are
  scheduled in `ROADMAP.md`, not cut.
- Visual-regression determinism depends on generating baselines **inside** the
  pinned Playwright Docker image; off-image baselines would flake the green gate,
  so visual assertions are kept out of the first slices.
