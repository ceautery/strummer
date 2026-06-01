# @strummer/cli

The Strummer command-line tool — a human entry point over the same engines the
MCP servers expose. Two surfaces:

- **docs search** (`search`/`get`/`versions`/`detect`) over [`@strummer/core`](../core).
- **API testing** (`api …`) over [`@strummer/api`](../api).

## Install / invoke

There's no published npm package yet, so run it from the built workspace:

```bash
pnpm -r build                          # once (or: pnpm -F @strummer/cli build)
node packages/cli/dist/bin.mjs --help
```

The examples below use `strummer` as shorthand for `node packages/cli/dist/bin.mjs`.

---

## API testing quickstart

Strummer runs **Bruno `.bru`** requests from a **collection directory**. Its
richer assertions and captures live in a sidecar `<request>.strummer.yml` next
to each `.bru`, so the `.bru` stays 100% Bruno-GUI compatible (ADR 0004).

```
mycollection/
  bruno.json                 # optional Bruno collection marker
  get-user.bru               # the request
  get-user.strummer.yml      # optional: assertions + captures
  environments/Public.bru    # optional: {{baseUrl}} and other vars
```

A ready-to-run sample lives at [`examples/api/jsonplaceholder`](../../examples/api/jsonplaceholder)
(hits the free, no-auth [JSONPlaceholder](https://jsonplaceholder.typicode.com) API).

**1. See what's in a collection:**

```console
$ strummer api list examples/api/jsonplaceholder
POST  create-post  {{baseUrl}}/posts
GET  get-user  {{baseUrl}}/users/1
GET  list-posts  {{baseUrl}}/posts?userId=1
```

**2. Inspect one request** (reports the secret *names* a request needs, never values):

```console
$ strummer api get examples/api/jsonplaceholder get-user
GET  {{baseUrl}}/users/1
  Accept: application/json
required secrets: (none)
```

**3. Run it.** `{{baseUrl}}` comes from the `Public` environment, so no flags
are needed beyond `--env` (or pass `--var baseUrl=https://…` instead):

```console
$ strummer api run examples/api/jsonplaceholder get-user --env Public
GET  https://jsonplaceholder.typicode.com/users/1
sent
status 200  176ms
PASS  status equals
PASS  header contains
PASS  jsonpath exists $.name
body: strummer://run/<id>/body
```

Exit code is **0** only when the request was sent *and* every assertion passed
(and, with `--openapi`, the contract validated) — so it drops straight into CI.

**4. Get structured output** for scripts/agents with `--json`:

```console
$ strummer api run examples/api/jsonplaceholder get-user --env Public --json
{ "request": {…}, "sent": true, "dryRun": false,
  "response": { "status": 200, "assertions": [...], "captured": { "userName": "Leanne Graham" }, … } }
```

**5. Chain requests** — captures thread forward into later requests' scope:

```console
$ strummer api run-collection examples/api/jsonplaceholder get-user list-posts --env Public
get-user  200  PASS
list-posts  200  PASS
captured: userName
```

### Mutation safety (deny-by-default)

`GET`/`HEAD`/`OPTIONS` run freely. Mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`)
**dry-run** by default — Strummer resolves and shows what *would* be sent, but
does not fire — and require an explicit unlock: `--unsafe` **plus** a host
allowlist.

```console
$ strummer api run examples/api/jsonplaceholder create-post --env Public
POST  https://jsonplaceholder.typicode.com/posts
dry-run (not sent): POST is a mutating method; dry-run only (pass allowUnsafe to send)
# exit 1 — nothing was verified

$ strummer api run examples/api/jsonplaceholder create-post --env Public \
    --unsafe --allow-host jsonplaceholder.typicode.com
POST  https://jsonplaceholder.typicode.com/posts
sent
status 201  …
PASS  status equals
PASS  jsonpath exists $.id
```

### Secrets

Reference secrets in a `.bru` as `{{secret:NAME}}` (never inline the value).
Today they resolve from the environment as `STRUMMER_SECRET_<NAME>`; a missing
secret **fails closed**, and resolved values are redacted from every result
(request, headers, body) — including base64/url encodings. (Keyring-backed
storage is a scheduled opt-in.)

```bash
STRUMMER_SECRET_API_TOKEN=… strummer api run mycollection authed-request --env Public
```

### Contract validation

```bash
# Validate a live response against an OpenAPI 3.1 spec in one shot:
strummer api run mycollection get-user --env Public --openapi openapi.json

# Offline GraphQL drift check (no request sent): does a saved query still
# conform to the current schema?
strummer api validate --graphql schema.graphql --query query.graphql
```

### Command reference

```
strummer api list  <dir>
strummer api get   <dir> <name>
strummer api run   <dir> <name> [--var k=v]… [--env <e>] [--unsafe] [--allow-host <h>]… [--openapi <spec.json>] [--json]
strummer api run-collection <dir> <name>… [--var k=v]… [--env <e>] [--unsafe] [--allow-host <h>]… [--stop-on-failure] [--json]
strummer api validate --graphql <schema> --query <query> [--json]
```

`<name>` is the `.bru` file stem (e.g. `get-user` for `get-user.bru`).

---

## Browser testing

Single-shot page inspection over a real headless Chromium. Each command navigates
once and reads, then tears the browser down — so it's a quick human probe, not the
stateful agent surface (that's `strummer-browser-mcp`). Every request is fronted by
a **mandatory DNS-pinning SSRF proxy**; navigation is allowed only to the host you
typed (auto-allowed as explicit operator intent) plus any `--allow-host`.

```bash
# The ARIA snapshot (with [ref=…] ids) of a page:
$ strummer browser snapshot https://example.com

# Accessibility audit — prints a summary + the full report path; exits 1 if any
# violations (usable as a CI gate):
$ strummer browser audit https://example.com

# Save a PNG screenshot:
$ strummer browser screenshot https://example.com --out shot.png

# Inspecting a local dev server (loopback) needs --allow-private; sandboxed
# environments may need --no-sandbox:
$ strummer browser snapshot http://127.0.0.1:3000 --allow-private --no-sandbox
```

### Command reference

```
strummer browser snapshot   <url> [--allow-host <h>]… [--allow-private] [--no-sandbox] [--headed] [--json]
strummer browser audit      <url> [same flags]                        # exit 1 on a11y violations
strummer browser screenshot <url> [--out <file>] [--full-page] [same flags]
```

---

## Docs search

```bash
strummer search <query…> [-l <lib>] [--version <v>] [--installed <v>] [-p <dir>] [--ecosystem <e>] [--type <t>] [--limit <n>] [--json]
strummer get <id> [--json]
strummer versions <library>
strummer detect <project> <library> [--ecosystem <node|python|ruby>]

# Global: -i/--index <file> (or set STRUMMER_INDEX) — the SQLite index to query.
```

See [`packages/mcp`](../mcp) for building an index and the agent-facing MCP servers.
