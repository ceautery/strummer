# @strummer/mcp

The Strummer MCP server(s) — expose Strummer's pillars to an LLM agent as MCP
tools and resources. Two servers ship from this package:

- **`strummer-mcp`** — the **docs** server over [`@strummer/core`](../core)
  (Tools / Resource below).
- **`strummer-api-mcp`** — the **API-testing** server over [`@strummer/api`](../api)
  (API tools below).
- **`strummer-browser-mcp`** — the **browser/UI-testing** server over
  [`@strummer/browser`](../browser) (browser tools below).

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

- **`strummer://doc/{id}`** — the same full fragment as `get_doc`, so agents can
  follow a search hit's `resourceUri` without a tool call.

## API tools (`strummer-api-mcp`)

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
  `body`) **or** GraphQL (`graphqlSchema`,`query`,`body`) → contract findings.
- Resource **`strummer://run/{runId}/body`** — fetch a stored response body by
  its handle (bodies are never inlined).

**Safety:** `allowUnsafe` / `allowedHosts` are **operator-controlled** — set on
the bin via env, never exposed as tool inputs (an agent can't authorize its own
mutating requests). Mutations dry-run unless both are set (ADR 0004).

## Browser tools (`strummer-browser-mcp`)

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
- **`browser_audit_a11y`** — axe-core audit; compact summary + report by handle.
- **`browser_screenshot`** — operator-gated (off by default; pixels can't be
  redacted, like the trace.zip); captures a PNG to a `screenshot-s<n>` handle
  (summary only, never inlined) and does not invalidate refs.
- **`browser_upload`** — set file(s) on a file-input ref. Deny-by-default: requires
  an operator upload-allowlist dir and confines every path within it (no traversal/
  absolute escape), so an agent can't upload arbitrary local files.
- **`browser_downloads`** — collect file downloads since the last call (a free read).
  Downloads are denied by default (cancelled); with an operator quarantine dir set
  they're saved there under a sanitized name and reported as filename/path/size —
  the bytes are never served. `waitMs` waits briefly for a download a click just started.
- **`browser_save_storage_state`** — operator-gated; writes the password-equivalent
  storageState to an operator-path artifact (handle + counts only, never inlined).
- Resource **`strummer://browser/run/{runId}/{kind}`** — fetch a stored artifact
  (`snapshot-s<gen>` / `a11y-s<n>` / `screenshot-s<n>` / `trace` / `console` /
  `network`) by handle; binary kinds (trace.zip, screenshot PNG) come back as a
  base64 blob. The password-equivalent `storage-state` kind is **refused**
  (operator-path only).

**Safety (all operator-set via `STRUMMER_BROWSER_*` env, never tool inputs):**
navigation/mutation deny-by-default (`ALLOW_UNSAFE`, `ALLOWED_HOSTS`); a **mandatory**
DNS-pinning SSRF proxy (loopback forced through it; `ALLOW_PRIVATE` opt-in);
service-workers blocked + WebRTC egress neutralized; JS dialogs dismissed by
default (`ALLOW_DIALOGS` to accept; each recorded, redacted, on the step result);
downloads cancelled unless an operator quarantine dir (`DOWNLOAD_DIR`) is set;
uploads confined to an operator allowlist dir (`UPLOAD_DIR`, denied when unset);
secret redaction across every artifact + the trace.zip; `{{secret:NAME}}` fill +
origin-scoped `httpCredentials` (`HTTP_USERNAME/PASSWORD/ORIGIN`); caps
`MAX_SESSIONS`/`SESSION_MS`/`MAX_PAGES`/
`IDLE_TTL_MS`; trace capture + `storageState` capture (`ALLOW_STORAGE_STATE`) +
screenshot capture (`ALLOW_SCREENSHOTS`) all off unless explicitly enabled.

## Run

```bash
strummer-mcp <index.sqlite>          # docs; or: STRUMMER_INDEX=… strummer-mcp

# API testing — mutations dry-run unless explicitly unlocked:
strummer-api-mcp
STRUMMER_ALLOW_UNSAFE=1 STRUMMER_ALLOWED_HOSTS=api.example.com strummer-api-mcp

# Browser testing — deny-by-default; unlock + allowlist per operator policy:
STRUMMER_BROWSER_ALLOWED_HOSTS=app.test,127.0.0.1 strummer-browser-mcp
```

All three speak MCP over stdio.

### Register with Claude Code

```bash
claude mcp add strummer         -- strummer-mcp /path/to/index.sqlite
claude mcp add strummer-api     -- strummer-api-mcp
claude mcp add strummer-browser -- strummer-browser-mcp
```

## Token economy

Search returns summaries + resource links, not bodies; the agent fetches full
text only when it follows a link. This keeps results well under Claude Code's
~10k-token warning threshold. See `ARCHITECTURE.md` §4.
