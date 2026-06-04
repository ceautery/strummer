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
# Validate a live exchange against an OpenAPI 3.1 spec in one shot — BOTH the
# response AND the sent request's body/params (the request check runs even on a
# withheld dry-run):
strummer api run mycollection get-user --env Public --openapi openapi.json

# Validate a live GraphQL run's query + variables against the SDL:
strummer api run mycollection gql-search --env Public --graphql schema.graphql

# Offline GraphQL drift check (no request sent): does a saved query still
# conform to the current schema? With --variables, also type-check the variables.
strummer api validate --graphql schema.graphql --query query.graphql --variables '{"id":5}'

# Preflight a REQUEST (body + params) against an OpenAPI 3.1 operation, no send:
# (scalar params + query `form` arrays explode=true; other serializations skip-not-fail)
strummer api validate-request --openapi openapi.json --method POST --path /widgets \
  --body new-widget.json --query limit=10

# Validate the traffic in a captured HAR against a contract (no request re-run):
strummer api validate-capture run.har.zip --openapi openapi.json
```

### Command reference

```
strummer api list  <dir>
strummer api get   <dir> <name>
strummer api run   <dir> <name> [--var k=v]… [--env <e>] [--unsafe] [--allow-host <h>]… [--openapi <spec.json>] [--graphql <schema>] [--json]
strummer api run-collection <dir> <name>… [--var k=v]… [--env <e>] [--unsafe] [--allow-host <h>]… [--stop-on-failure] [--json]
strummer api validate --graphql <schema> --query <query> [--variables <json|file>] [--json]
strummer api validate-request --openapi <spec.json> --method <M> --path </p> [--body <file>] [--query k=v]… [--header n:v]… [--json]
strummer api validate-capture <har.zip> [--openapi <spec.json>] [--graphql <schema>] [--graphql-endpoint </p>] [--json]
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

### Replaying a persisted flow

A **flow** is a Bruno-openable `<name>.bru` (meta) + a `<name>.strummer.yml`
sidecar holding ordered `steps` keyed by semantic locators (role + accessible
name), not ephemeral snapshot refs — so it replays stably. See
[`examples/browser/login`](../../examples/browser/login). The flow drives its own
navigations, so allowlist each target host with `--allow-host`; mutations
(`click`/`fill`/…) **dry-run** unless `--unsafe`. `{{var}}` comes from `--var`;
`{{secret:NAME}}` from `STRUMMER_BROWSER_SECRET_<NAME>` (redacted from output).
Exits non-zero on any step error or failed assertion (a CI gate).

```bash
$ STRUMMER_BROWSER_SECRET_PASSWORD=hunter2 \
    strummer browser run examples/browser/login/login.bru \
      --var baseUrl=https://app.example.com --var username=alice \
      --allow-host app.example.com --unsafe
```

### Command reference

```
strummer browser snapshot   <url> [--allow-host <h>]… [--allow-private] [--no-sandbox] [--headed] [--json]
strummer browser audit      <url> [same flags]                        # exit 1 on a11y violations
strummer browser screenshot <url> [--out <file>] [--full-page] [same flags]
strummer browser run        <flow.bru> [--var k=v]… [--unsafe] [--allow-host <h>]… [same flags]  # exit 1 on failure
```

---

## Verification (Phase-4 pillars)

Thin human wrappers over the cross-cutting verification engines. You are the
operator, so the run/write gates are straight-through flags (`--allow-run`,
`--allow-quarantine`) — a denied run never spawns. `audit`/`uncovered-in-diff`
exit non-zero on a finding, so they double as CI gates.

```bash
# Mutation testing — view a report, or run Stryker (gated):
strummer mutate summarize reports/mutation/mutation.json
strummer mutate summarize results.txt --format mutmut
strummer mutate run . --allow-run --file src/changed.ts --incremental

# Coverage — the forgotten-assertion catch (exit 1 when a new line is uncovered):
strummer coverage uncovered-in-diff --diff changes.diff --coverage coverage-final.json --project-root .
strummer coverage run-scoped . --changed-file src/changed.ts --diff changes.diff --allow-run

# Flaky-test detection over a run-history DB (--db / STRUMMER_FLAKE_DB):
strummer flake ingest report.json --db flake.db --format vitest
strummer flake status --db flake.db
strummer flake candidates --db flake.db
strummer flake run . --db flake.db --repeat 10 --allow-run
strummer flake quarantine 'src/x.test.ts > flaky case' --db flake.db \
    --reason 'intermittent timeout' --expires-at 2026-07-01T00:00:00Z \
    --allow-quarantine --max-expiry-ms 2592000000

# Dependency intelligence for the INSTALLED version (exit 1 on a finding):
strummer deps audit . lodash --osv-db /var/lib/strummer/osv
strummer deps audit-project . --osv-db /var/lib/strummer/osv
strummer deps changelog lodash --project . --to 4.17.21

# Semantic code navigation via a real Language Server (single-shot; gated).
# --servers (or STRUMMER_LSP_SERVERS) binds the operator language→server registry;
# navigation needs --allow-run, rename writes only with --allow-write (else dry-run):
export STRUMMER_LSP_SERVERS='{"typescript":{"command":"typescript-language-server","args":["--stdio"]}}'
strummer lsp languages
strummer lsp definition typescript src/app.ts 42 8 --project . --allow-run
strummer lsp references typescript src/app.ts 42 8 --project . --allow-run
strummer lsp symbols typescript src/app.ts --project . --allow-run
strummer lsp workspace-symbols typescript MyClass src/app.ts --project . --allow-run      # project-wide search; trailing file anchors the project (tsserver needs it)
strummer lsp diagnostics typescript src/app.ts --project . --allow-run                     # errors/warnings (push model; empty = clean; exit 2 = still indexing)
strummer lsp definition typescript packages/a/src/x.ts 4 14 --project packages/a --workspace-root packages/b --allow-run  # multi-root: bind both packages on one server
strummer lsp rename typescript src/app.ts 42 8 newName --project . --allow-run            # dry-run preview
strummer lsp rename typescript src/app.ts 42 8 newName --project . --allow-run --allow-write  # writes to disk
```

`lsp` exit codes: `0` the query ran, `1` denied/refused/error, `2` the server is
still indexing (retry). A result `status` is tri-state (`ok`/`not_ready`/`no_result`);
`rename` is dry-run unless `--allow-write`, and `applied` in the result says whether
the edit was written.

`audit`/`audit-project` report `osvSnapshotLoaded` — without an operator OSV
snapshot, "no known vulnerabilities" is unknown, not clean. The deps CLI fetches
package metadata behind the same DNS-pinning SSRF pre-flight the bins use (private
registries gated by `--allow-private`).

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
