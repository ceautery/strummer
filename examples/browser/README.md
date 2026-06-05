# Sackville browser flows (example)

A **persisted, replayable browser flow** is a Bruno-openable `<name>.bru` (meta
only) paired with a colocated `<name>.sackville.yml` sidecar that holds the
ordered **steps**. This mirrors the API pillar's `.bru` + sidecar split
(ADR 0004); the browser-specific decision is that steps key off **semantic
locators** (`role` + accessible `name` + optional `nth`) rather than the
ephemeral per-snapshot refs — so a saved flow stays valid across runs.

## `login/` — a login + verification flow

- [`login.bru`](./login/login.bru) — the Bruno container (its `meta.name`).
- [`login.sackville.yml`](./login/login.sackville.yml) — the steps.

Step kinds: `navigate`, `click`, `fill`, `select`, `press`, `wait_for`, and
`assert` (a list of declarative assertions over the shared `@sackville-mcp/assert`
operators — page sources `url`/`title`/`ariaSnapshot`, element sources
`text`/`value`/`visible`/`count`).

## Running it

```bash
# {{var}} comes from --var; {{secret:NAME}} from SACKVILLE_BROWSER_SECRET_<NAME>.
SACKVILLE_BROWSER_SECRET_PASSWORD=hunter2 \
  sackville browser run examples/browser/login/login.bru \
    --var baseUrl=https://app.example.com \
    --var username=alice \
    --allow-host app.example.com \
    --unsafe
```

`navigate` is gated by `--allow-host`; mutations (`click`/`fill`/…) **dry-run**
unless you pass `--unsafe` (and the current host is allowlisted). The command
exits non-zero if any step errors or any assertion fails — usable as a CI gate.
Add `--json` for the full structured `FlowResult` (per-step, with redacted
assertion values).

## Running it over MCP (the agent surface)

The same flow replays from the **`sackville-browser-mcp`** server via the
`browser_run_flow` tool — parity with the CLI above. The operator points the
server at a flows directory; the agent then runs a flow **by name** (never a
path), so there is no traversal surface.

```bash
# Operator: enable flow replay + register the secret + allow the host. As with the
# CLI, the agent never sees these values — only the NAMES are exposed.
SACKVILLE_BROWSER_FLOWS_DIR=examples/browser/login \
SACKVILLE_BROWSER_SECRET_PASSWORD=hunter2 \
SACKVILLE_BROWSER_ALLOWED_HOSTS=app.example.com \
SACKVILLE_BROWSER_ALLOW_UNSAFE=1 \
  sackville-browser-mcp
```

The agent discovers and replays the flow on a session:

1. `browser_list_flows` → `{ flows: [{ name: "Login", steps: 6 }] }`
2. `browser_open_session` → a server-minted `sessionId`
3. `browser_run_flow` with `{ sessionId, flow: "Login", vars: { baseUrl:
   "https://app.example.com", username: "alice" } }` → the structured `FlowResult`
   (`{ name, passed, steps[] }`), assertion values redacted.

`{{var}}` values come from the `vars` argument; `{{secret:NAME}}` resolves
server-side from `SACKVILLE_BROWSER_SECRET_<NAME>` (fail-closed on an unknown name)
and is never echoed back. Steps replay through the **same** operator gate as live
tool calls — so mutations dry-run unless the operator set `SACKVILLE_BROWSER_ALLOW_
UNSAFE` and allowlisted the host. Both flow tools are **disabled** (report "not
enabled") unless `SACKVILLE_BROWSER_FLOWS_DIR` is set.

### Recording the run as video

To capture a `.webm` recording of the session (handy for debugging a flow that
fails in CI), the operator points the server at a video directory:

```bash
SACKVILLE_BROWSER_FLOWS_DIR=examples/browser/login \
SACKVILLE_BROWSER_VIDEO_DIR=/var/sackville/video \
SACKVILLE_BROWSER_VIDEO_WIDTH=1280 SACKVILLE_BROWSER_VIDEO_HEIGHT=720 \
  sackville-browser-mcp
```

Every session then records video; `browser_close_session` finalizes it and returns
a handle alongside the other artifacts:

```jsonc
// browser_close_session →
{ "closed": true, "runId": "…",
  "artifacts": { "video": { "handle": "sackville://browser/run/…/video",
                            "byteSize": 51234, "contentType": "video/webm" } } }
```

Read the bytes via the `sackville://browser/run/{runId}/video` resource (a base64
`video/webm` blob). Video is **operator-gated off by default** — it is unredactable
pixels (a secret rendered on the page is visible in the frames), so it is treated
like the trace/screenshots. `VIDEO_WIDTH`/`VIDEO_HEIGHT` cap the frame size; the
session wall-clock cap (`SACKVILLE_BROWSER_SESSION_MS`) bounds duration.
