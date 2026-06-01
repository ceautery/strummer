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
> `packages/browser/src/routes.ts` (Tier-1).

> **Update (2026-06-01) — Tier-2 proxy + `allowPrivate`.** Tier-2 is
> `createSsrfProxy` (`packages/browser/src/proxy.ts`): a loopback forward proxy
> (HTTP absolute-form + HTTPS `CONNECT`) passed as Chromium's `proxy.server`. It
> calls `resolveAndPin` per request/CONNECT — resolving the host once, refusing
> blocked ranges, connecting to the **pinned** IP — so an allowlisted hostname
> that rebinds to a private/metadata address is refused (HTTP → `502`; HTTPS →
> tunnel refused). Every redirect hop is a fresh request to the proxy, so
> redirects are re-checked for free. To keep **local-app testing** possible, the
> classifier gained three classes — `global` / `private` (loopback/RFC1918/CGNAT/
> unique-local) / `blocked` (link-local incl. 169.254.169.254 metadata,
> multicast, …) — and an operator `allowPrivate` opt-in permitting `private`
> targets **but never `blocked` ones**. Default blocks both. _(Update 2026-06-01:
> the proxy is now wired into the bin's launch as mandatory; `serviceWorkers:
> 'block'` is a `BrowserManager` context default; WebRTC is neutralized via the
> launch arg `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. QUIC
> rides the same proxied path; a dedicated QUIC-disable flag is a future refinement.)_

> **Update (2026-06-01) — MCP surface + server bin (grounded by the
> `browser-mcp-design` fan-out: 3 designs → 2 adversarial critics → synthesis).**
> Shipped **MCP-only** (human CLI deferred): `registerBrowserTools`/
> `createBrowserServer` (`packages/mcp/src/browser.ts`) + the `strummer-browser-mcp`
> bin (`bin-browser.ts`). Load-bearing decisions and adversarial corrections:
> - **Loopback proxy-bypass gap (real).** Chromium bypasses `proxy.server` for
>   loopback literals (documented in `proxy.test.ts`), so an operator allowlisting
>   `127.0.0.1` could pivot to any loopback port unpinned. The bin now launches
>   with `--proxy-bypass-list=<-loopback>` so loopback ALSO traverses the pinning
>   proxy, and `allowPrivate` genuinely governs loopback reachability. The Tier-2
>   proxy is **mandatory — no disable env** (rebinding protection can't be turned
>   off from env).
> - **Redaction boundary made precise.** Anything **written to disk** is redacted
>   in the engine (the new `buildSnapshot` redact seam scrubs the snapshot text +
>   stored tree; `RunRecorder` redacts console/network before write); anything only
>   **returned** is redacted at the surface (free reads `get_text`/`get_value`/
>   `get_attribute`). A secret reflected in the DOM no longer leaks via a snapshot.
> - **Per-generation immutable artifact handles** (`snapshot-s<gen>` / `a11y-s<n>`)
>   so a handle returned in one step never resolves to a later generation's tree.
> - **Dry-run scope, honestly:** the dry-run route aborts **every** request (the
>   critic's "only the first" was a verified misread — only the *capture* is
>   first-only); the genuine gaps were **popups** (now closed via the context
>   `page` event) and a `crossOriginEgress` flag (the gate authorizes on the
>   document host, so a would-be request to a different host is surfaced).
> - **Session model:** a surface `Map<sessionId,BrowserSession>` with a
>   **per-session async mutex**; `sessionId`+`runId` are **server-minted UUIDs,
>   never agent input**; reaper reconciliation via a new `BrowserManager.onReap`
>   hook (flush the recorder before `context.close`) + `hasSession` eviction (a
>   reaped session is refused, never silently re-created).
> - **Namespaced `STRUMMER_BROWSER_*` operator env with NO fallback** to the api
>   pillar's unprefixed vars, so unlocking API writes never unlocks browser
>   mutations. Trace capture is **off by default** (unredacted binary); sandbox is
>   **on by default** (`--no-sandbox` is an explicit operator opt-in).
> - **Eager locator resolution:** `PageDriver` resolves a ref's locator before the
>   gate/dry-run branch, so a no-snapshot/stale-ref error propagates instead of
>   being swallowed by the dry-run try/catch.

### 6. Secrets at the fill/auth boundary; redact before any write

`{{secret:NAME}}` form-fill placeholders resolve server-side immediately before
`locator.fill()` (cleartext lives only in the browser input, never in tool args
or the agent-visible model). HTTP Basic uses **origin-scoped** `httpCredentials`
from operator config. Every captured artifact (console, request/response
headers+bodies, HAR, trace network data, storageState) runs through the API
pillar's **redaction pass before any disk write** — Playwright itself does **no**
artifact redaction. `storageState` is **password-equivalent**: operator-path
only, by handle, scrubbed from traces.

> **Update (2026-06-01) — secret boundary implemented.** All of §6 now ships:
> - **`{{secret:NAME}}` fill resolution** at the surface (`browser_fill`/
>   `browser_fill_form`), just before `locator.fill()`; **fail-closed** on an
>   unknown name; bin-wired from `STRUMMER_BROWSER_SECRET_*` (same map as the
>   redactor). Cleartext is typed into the input and scrubbed from every output.
> - **Origin-scoped `httpCredentials`** applied per context by `BrowserManager`
>   (`browser.newContext({ httpCredentials })`), bin-parsed from
>   `STRUMMER_BROWSER_HTTP_USERNAME/PASSWORD/ORIGIN` (built only when both
>   username+password are set); the password is registered with the redactor and
>   kept out of the returned config.
> - **`storageState` by handle**: operator-gated `browser_save_storage_state`
>   (`STRUMMER_BROWSER_ALLOW_STORAGE_STATE`, default off) writes the
>   password-equivalent state to an operator-path artifact and returns a **handle +
>   cookie/origin counts only** — never inlined; the run-artifact resource
>   **refuses** to serve the `storage-state` kind to the agent.
> - **Redact before any write** is realized across console/network logs, the
>   dry-run preview (url+postData), the ARIA-snapshot text+stored tree, surface
>   reads, and the **trace.zip**: `RunRecorder` unzips the trace (fflate), scrubs
>   its text entries (JSONL `trace`/`network`/`stacks` + text resource snapshots
>   `.html`/`.txt`/css/js), and re-zips; binary resources pass through (resource
>   files are content-addressed but referenced by filename, so redaction is safe).
> Same redaction applies to the **HAR** "network heavy mode" archive (update
> 2026-06-01): `finalizeHar` reads the HAR `.zip` Playwright writes on context
> close and scrubs every text entry (the `.har` JSON + persisted text bodies,
> fflate) before it is stored by handle / surfaced. HAR carries full
> headers/query/bodies (only *registered* secrets are redacted), so capture stays
> operator-gated **off** by default (`STRUMMER_BROWSER_HAR_DIR`), like the trace.
> HAR **replay** (`page.routeFromHAR`, notFound:'abort') gives deterministic
> offline runs with zero egress, gated behind an operator replay dir
> (`STRUMMER_BROWSER_REPLAY_HAR_DIR`). Mechanically, finalize hangs off a new
> `BrowserManager.onClosed` hook (fires after `context.close()` — the mirror of
> `onReap`, since the HAR only exists post-close), so the explicit close, the
> idle reaper, and shutdown all finalize, never leaving an unredacted HAR on disk.
> Scheduled, not blocking: `storageState`/`userDataDir` **import** for operator
> login-reuse.

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

### 9. Persisted browser flows: literal `.bru` + sidecar, semantic-locator steps (update 2026-06-01)

Replayable flows mirror ADR 0004's API-pillar split: a Bruno-openable `<name>.bru`
(its `meta.name`) + a colocated `<name>.strummer.yml` sidecar holding the ordered
`steps`. Bruno's `.bru` grammar is HTTP-request-shaped and can't represent a
click/fill sequence, so the `.bru` stays a minimal (inert-to-Bruno) container and
the sidecar carries the real content — a deliberate "honor the format + sidecar
pattern literally" choice over inventing a new flow file. The load-bearing
decision: steps key off **semantic locators** (`{role, name?, nth?}`, driven via
`getByRole(...).nth()`), **not** the ephemeral per-snapshot ref-ids — refs are a
discovery affordance for the agent and don't persist, whereas a saved flow must be
stable across runs and snapshot-cap-independent. `runFlow` reuses the live engine
wholesale: the same mutation gate (dry-run vs execute), the same redactor, and
`{{var}}`/`{{secret:NAME}}` resolution as the API pillar (assert *expected* values
get `{{var}}` only — never secrets — so a cleartext expected can't leak). Primary
surface is the human/CI `strummer browser run`; an MCP `browser_run_flow` tool is a
scheduled follow-up.

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
