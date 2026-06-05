# sackville

The Sackville MCP server — exposes Sackville's pillars to an LLM agent as MCP tools
and resources. **`sackville-mcp` is the AGGREGATE server**: one stdio process that
serves every *enabled* pillar (docs, api, browser, coverage, deps, flake, lsp,
mutate, verify). Narrow single-pillar bins also ship for minimal deployments
(`sackville-docs-mcp`, `sackville-api-mcp`, `sackville-browser-mcp`, …).

## Quickstart — the aggregate server

Add one block to your MCP client config (see [`examples/mcp/.mcp.json`](../../examples/mcp/.mcp.json)):

```jsonc
{
  "mcpServers": {
    "sackville": {
      "command": "npx",
      "args": ["-y", "sackville"],
      "env": {
        // Pick which pillars to expose (unset ⇒ the curated default docs+api+deps+verify).
        "SACKVILLE_TOOLSETS": "api,deps,verify",
        // Each pillar reads its OWN operator gate; run/write tools appear only when set.
        "SACKVILLE_API_ALLOWED_HOSTS": "api.example.com"
      }
    }
  }
}
```

- **Selecting pillars** — `SACKVILLE_TOOLSETS` is a comma list of pillar names; unset
  enables the curated read-heavy default. It only *selects* — it never grants a
  capability (each pillar still reads its own `SACKVILLE_<PILLAR>_*` gate).
- **Install isolation** — a bare `npm i sackville` is **native-free**. The heavy
  engines (`@sackville/browser` → playwright, `@sackville/core`/`@sackville/embed` → the
  docs index, `@sackville/flake` → SQLite) are **optional peers**: install the ones whose
  pillars you enable. A pillar whose engine isn't installed (or, for docs, whose
  `SACKVILLE_INDEX` is unset) is *loud-disabled* at startup — the server still starts.
- **Compose, never widen** — in the aggregate the api + verify pillars read the prefixed
  `SACKVILLE_API_*` / `SACKVILLE_API_SECRET_*` namespace, so no bare flag unlocks two
  pillars at once. Safety config is always operator-set, never an agent input.

## Docs tools

- **`search_docs`** — **hybrid** search: FTS5/bm25 fused with vector KNN via
  reciprocal rank fusion. Inputs: `query`, optional `library`/`version`/`type`/
  `limit` (default 8, max 25). Returns **compact** results (`id`, `title`,
  `symbol`, `type`, `library`, `version`, `score`, `snippet`, `resourceUri`) as
  `structuredContent` — never full bodies. The query is embedded in-process with
  transformers.js (`Xenova/bge-small-en-v1.5`), matching the indexed vectors
  (ADR 0003); the model (~130 MB) downloads once on first query.
- **`get_doc`** — inputs: `id`. Returns the full fragment (the one place bodies
  are returned). Errors if the id is unknown.

## Docs resource

- **`sackville://doc/{id}`** — the same full fragment as `get_doc`, so agents can
  follow a search hit's `resourceUri` without a tool call.

## API tools (`sackville-api-mcp`)

Over a Bruno `.bru` collection directory (passed as the `dir` tool argument, so
one server serves many collections):

- **`list_requests`** — `{ dir }` → each request's `name`/`method`/`url`.
- **`get_request`** — `{ dir, name }` → method/url/headers, counts, and
  **`requiredSecrets`** — the secret **names** referenced as `{{secret:NAME}}`,
  never values.
- **`run_request`** — `{ dir, name, vars?, env? }` → the redacted run result
  (status, assertions, scriptTests, captured, `bodyHandle`).
- **`run_collection`** — `{ dir, names[], vars?, env?, stopOnFailure? }` → a
  compact per-step summary + threaded `captured`.
- **`validate_response`** — OpenAPI 3.1 (`openapiSpec`,`method`,`path`,`status`,
  `body`) **or** GraphQL (`graphqlSchema`,`query`,`body`, + optional `variables` to
  type-check the request variables against the operation's declared types) → contract findings.
- **`validate_request`** — validate a request's **body + path/query/header params**
  against an OpenAPI 3.1 operation (`openapiSpec`,`method`,`path`,`body?`,`query?`,
  `headers?`) → contract findings (message + path redacted). Scalar params, array params
  (query form/space/pipe-delimited + path/header `simple`, non-string-scalar items), and
  object params (query `deepObject` + `form/explode=false`); ambiguous serializations
  (e.g. `form/explode=true` objects, string-item delimited arrays, fractional `multipleOf`
  numbers) are skipped as uncheckable, never a false finding (ADR 0016). A GraphQL envelope
  is refused, not schema-failed.
- Resource **`sackville://run/{runId}/body`** — fetch a stored response body by
  its handle (bodies are never inlined).

**Safety:** `allowUnsafe` / `allowedHosts` are **operator-controlled** — set on
the bin via env, never exposed as tool inputs (an agent can't authorize its own
mutating requests). Mutations dry-run unless both are set (ADR 0004).

## Browser tools (`sackville-browser-mcp`)

Stateful, session-oriented (open → drive → close); all large artifacts by handle:

- **`browser_open_session`** / **`browser_list_sessions`** / **`browser_close_session`**
  — lifecycle. Open mints a server-side `sessionId` + `runId` (never agent inputs)
  and reports `capturing` + `sessionCount`/`maxContexts`; close flushes and returns
  the run artifact handles.
- **`browser_navigate`** / **`browser_snapshot`** — drive + (re)capture a
  token-capped ARIA snapshot whose elements carry `[ref=…]` ids.
- **`browser_click`/`fill`/`fill_form`/`select`/`press`** — interact by ref;
  mutations **dry-run** (redacted would-be-request preview) unless the operator
  unlocked execution. `fill` resolves `{{secret:NAME}}` server-side (fail-closed).
- **`browser_wait_for`** / **`browser_get_text`/`get_value`/`get_attribute`** —
  read-like; reads are redacted and don't invalidate refs.
- **`browser_assert`** — evaluate declarative assertions against the live page
  (a free read). Page sources `url`/`title`/`ariaSnapshot`; element sources
  `text`/`value`/`visible`/`count` (by ref or role+name); the shared `@sackville/assert`
  operator set (`equals`/`contains`/`matches`/`gt`/…). Each **auto-waits** to its
  timeout; observed values are redacted. Returns `{pass, results}`.
- **`browser_audit_a11y`** — axe-core audit; compact summary + report by handle.
- **`browser_perf_audit`** — Lighthouse performance audit of a URL (allowlist-gated;
  spawns a fresh proxied Chrome, independent of any session). Score + core web-vitals
  inline; full LHR JSON + HTML by handle. Assert shape/thresholds, never exact scores.
- **`browser_trace_query`** — parse a captured trace.zip (by `runId`; needs trace
  capture on) into an action timeline (API calls + timing + errors), console, and an
  errors list. No live session needed — query after the session closed; the trace is
  already redacted. `apiFilter`/`errorsOnly`/`limit`/`includeParams` narrow it.
- **`browser_screenshot`** — operator-gated (off by default; pixels can't be
  redacted, like the trace.zip); captures a PNG to a `screenshot-s<n>` handle
  (summary only, never inlined) and does not invalidate refs.
- **`browser_vision_click`** / **`browser_vision_move`** — drive the pointer at a
  viewport coordinate (CSS pixels, e.g. from a screenshot) for canvas / non-AX-tree
  UI the snapshot can't address. Operator-gated **off by default** (`ALLOW_VISION`) —
  a blind click on a *point* sidesteps the accessible-tree safety story; the click
  still goes through the mutation gate. Prefer ref-based `browser_click` whenever the
  element is in the snapshot.
- **`browser_visual_compare`** — visual regression: capture the current page
  (animations frozen, caret hidden) and pixel-diff it against a stored baseline (by
  name) via pixelmatch. Returns pass + diff pixel count/ratio; the diff PNG is stored
  by `visual-diff-s<n>` handle on a mismatch. `maxDiffPixelRatio`/`maxDiffPixels` set
  the budget, `mask[]` ignores dynamic regions. Operator-gated (`BASELINE_DIR`);
  `update:true` records the baseline only when `ALLOW_BASELINE_UPDATE` is set (an
  agent can't rewrite the golden). Assert on a diff budget, not exact pixels.
- **`browser_upload`** — set file(s) on a file-input ref. Deny-by-default: requires
  an operator upload-allowlist dir and confines every path within it (no traversal/
  absolute escape), so an agent can't upload arbitrary local files.
- **`browser_downloads`** — collect file downloads since the last call (a free read).
  Downloads are denied by default (cancelled); with an operator quarantine dir set
  they're saved there under a sanitized name and reported as filename/path/size —
  the bytes are never served. `waitMs` waits briefly for a download a click just started.
- **`browser_save_storage_state`** — operator-gated; writes the password-equivalent
  storageState to an operator-path artifact (handle + counts only, never inlined).
- **`browser_replay_har`** — "network heavy mode" replay: serve the session from a
  recorded HAR instead of the network (`routeFromHAR`, unmatched requests aborted —
  deterministic, zero egress). Call before navigating. Operator-gated + deny-by-default
  (requires a replay dir; the HAR must resolve within it). **HAR capture** is the flip
  side: with an operator `HAR_DIR` set, each session records a full HAR (bodies
  attached) that `browser_close_session` finalizes — redacted, by `har` handle, with a
  compact summary.
- **`browser_list_flows`** / **`browser_run_flow`** — list the persisted `.bru`
  flows the operator made available (by name + step count) and replay one (by name)
  on a session. Steps drive through the SAME gate (navigation allowlist + dry-run-vs-
  execute) and redactor as the live step tools; `{{var}}` values are caller-supplied
  (non-secret), `{{secret:NAME}}` resolves server-side (fail-closed, never echoed).
  Operator-gated + deny-by-default (requires a `FLOWS_DIR`; the flow is named, never a
  caller-supplied path). The human-CLI counterpart is `sackville browser run`.
- **Video capture** — with an operator `VIDEO_DIR` set, each session records a
  `.webm`; `browser_close_session` finalizes it (written on context close) and
  surfaces it by `video` handle. Operator-gated off by default — video is
  unredactable pixels (same posture as the trace/screenshots); an optional size cap
  (`VIDEO_WIDTH`/`VIDEO_HEIGHT`) bounds the frame size, the session wall-clock cap
  bounds duration.
- Resource **`sackville://browser/run/{runId}/{kind}`** — fetch a stored artifact
  (`snapshot-s<gen>` / `a11y-s<n>` / `screenshot-s<n>` / `trace` / `console` /
  `network` / `har` / `video`) by handle; binary kinds (trace.zip, screenshot PNG,
  HAR .zip, video webm) come back as a base64 blob. The password-equivalent
  `storage-state` kind is **refused** (operator-path only).

**Safety (all operator-set via `SACKVILLE_BROWSER_*` env, never tool inputs):**
navigation/mutation deny-by-default (`ALLOW_UNSAFE`, `ALLOWED_HOSTS`); a **mandatory**
DNS-pinning SSRF proxy (loopback forced through it; `ALLOW_PRIVATE` opt-in);
service-workers blocked + WebRTC egress neutralized; JS dialogs dismissed by
default (`ALLOW_DIALOGS` to accept; each recorded, redacted, on the step result);
downloads cancelled unless an operator quarantine dir (`DOWNLOAD_DIR`) is set;
uploads confined to an operator allowlist dir (`UPLOAD_DIR`, denied when unset);
HAR capture off unless an operator output dir (`HAR_DIR`) is set + HAR replay off
unless a replay dir (`REPLAY_HAR_DIR`) is set, both deny-by-default; persisted-flow
replay off unless a flows dir (`FLOWS_DIR`) is set; video capture off unless a video
dir (`VIDEO_DIR`) is set; visual-regression compare off unless a baseline dir
(`BASELINE_DIR`) is set + baseline writes gated behind `ALLOW_BASELINE_UPDATE`; secret
redaction across every artifact + the trace.zip + the HAR; `{{secret:NAME}}` fill +
origin-scoped `httpCredentials` (`HTTP_USERNAME/PASSWORD/ORIGIN`); caps
`MAX_SESSIONS`/`SESSION_MS`/`MAX_PAGES`/
`IDLE_TTL_MS`; trace capture + `storageState` capture (`ALLOW_STORAGE_STATE`) +
screenshot capture (`ALLOW_SCREENSHOTS`) + vision/coordinate input (`ALLOW_VISION`)
all off unless explicitly enabled.

## Run

```bash
sackville-mcp <index.sqlite>          # docs; or: SACKVILLE_INDEX=… sackville-mcp

# API testing — mutations dry-run unless explicitly unlocked:
sackville-api-mcp
SACKVILLE_ALLOW_UNSAFE=1 SACKVILLE_ALLOWED_HOSTS=api.example.com sackville-api-mcp

# Browser testing — deny-by-default; unlock + allowlist per operator policy:
SACKVILLE_BROWSER_ALLOWED_HOSTS=app.test,127.0.0.1 sackville-browser-mcp
```

All three speak MCP over stdio.

### Register with Claude Code

```bash
claude mcp add sackville         -- sackville-mcp /path/to/index.sqlite
claude mcp add sackville-api     -- sackville-api-mcp
claude mcp add sackville-browser -- sackville-browser-mcp
```

## Token economy

Search returns summaries + resource links, not bodies; the agent fetches full
text only when it follows a link. This keeps results well under Claude Code's
~10k-token warning threshold. See `ARCHITECTURE.md` §4.
