# Strummer browser flows (example)

A **persisted, replayable browser flow** is a Bruno-openable `<name>.bru` (meta
only) paired with a colocated `<name>.strummer.yml` sidecar that holds the
ordered **steps**. This mirrors the API pillar's `.bru` + sidecar split
(ADR 0004); the browser-specific decision is that steps key off **semantic
locators** (`role` + accessible `name` + optional `nth`) rather than the
ephemeral per-snapshot refs — so a saved flow stays valid across runs.

## `login/` — a login + verification flow

- [`login.bru`](./login/login.bru) — the Bruno container (its `meta.name`).
- [`login.strummer.yml`](./login/login.strummer.yml) — the steps.

Step kinds: `navigate`, `click`, `fill`, `select`, `press`, `wait_for`, and
`assert` (a list of declarative assertions over the shared `@strummer/assert`
operators — page sources `url`/`title`/`ariaSnapshot`, element sources
`text`/`value`/`visible`/`count`).

## Running it

```bash
# {{var}} comes from --var; {{secret:NAME}} from STRUMMER_BROWSER_SECRET_<NAME>.
STRUMMER_BROWSER_SECRET_PASSWORD=hunter2 \
  strummer browser run examples/browser/login/login.bru \
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
