# Sackville tutorial 3 — when the UI works but the API is lying

The [first tutorial](../todo/) found a bug a green test suite hid (an *uncovered*
branch). The [second](../scheduler/) found one that line coverage *couldn't* see
(a covered line whose behaviour no test pinned). This one finds a bug that no
amount of testing the **app** will catch, because the app works perfectly: the
page renders, the buttons click, the end-to-end flow is green — and the API
underneath is quietly violating its own contract.

This is where the **api**, **browser**, and **verify** pillars earn their keep.

You will:

1. **Install** the API's docs into a Sackville index — fully offline — and learn
   what a field is *supposed* to be.
2. **Catch a contract violation live**, against the running server, even though
   every assertion passes (`api run --openapi`).
3. **Catch the same violation in captured browser traffic** — a recording of a
   *passing* user flow — with the capture→contract bridge (`api validate-capture`).
4. **Fold it into one verdict** (`verify run`), fix it, and watch the verdict flip.
5. Do it again through the **MCP** server from Claude Code.

The app is intentionally broken in one place: a single field with the wrong
*type*. `./reset.sh` puts it back when you're done.

> **Time:** ~25 minutes. No API keys. Stands alone, but builds on tutorials 1–2.

---

## Prerequisites — check these first

| Need | Why | Check / install |
| --- | --- | --- |
| **Node — an *even-numbered* LTS line (22 or 24)** | Runs the sample server (zero dependencies) and `npm i -g @sackville-mcp/cli` (which pulls `better-sqlite3`, prebuilt for LTS Node only). | `node --version` → `v22.x`/`v24.x`. Manage with `nvm use --lts`. |
| **`uv`** (Python package manager) | Builds the offline docs index in step 1. | `uv --version`; install with `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh`. |
| **The Sackville CLI** | Every step below uses `sackville-cli`. | `npm i -g @sackville-mcp/cli` |
| **A browser engine** — *optional* | Only for the **bonus** “produce the capture yourself” step. The main path uses a **committed** capture, so you can skip this. | `npx playwright install chromium` |

There is **no `npm install`** for the app itself — it is plain Node.

---

## 0. Setup — meet the storefront

From this directory (`examples/tutorial/storefront/`), start the app:

```bash
npm start          # == node server.js ; serves http://localhost:8137
```

Open <http://localhost:8137/login>, sign in with any username/password, and you
land on the dashboard:

```
Dashboard
Account balance: $100.00
```

Looks perfect. The login flow works, the balance renders. Ship it?

Leave the server running in this terminal; use a second terminal for the rest.

---

## 1. Install the API's docs into a Sackville index

The dashboard is built against a small JSON API documented as `storefront-core`.
Its docs ship with this tutorial as a local DevDocs pair
(`docs/storefront-core/index.json` + `db.json`). Build a searchable index —
**fully offline**; `--embedder fake` keeps it instant:

```bash
( cd ../../../py/sackville_ingest && uv sync )   # one-time — needs `uv`

uv run --project ../../../py/sackville_ingest sackville-ingest build \
  --index docs/storefront-core/index.json \
  --db    docs/storefront-core/db.json \
  --library storefront-core --version 1.0.0 \
  --home https://example.com/storefront-core/ \
  --embedder fake \
  --out storefront-core.sqlite
```

---

## 2. What is the balance *supposed* to be?

`$100.00` on the screen — but is the underlying data right? Don't guess; ask the
API's own documentation what the `balance` field is:

```bash
export SACKVILLE_INDEX=$PWD/storefront-core.sqlite
sackville-cli search "is the balance a number or a string" --library storefront-core
```

> **First run may pause** to download a ~130 MB embedding model once, then
> caches. It falls back to full-text search if offline (this index was built with
> `--embedder fake`, so FTS alone finds the hit). Don't Ctrl-C.

The **Money and types** page is unambiguous:

```
Money and types
    Every monetary amount in this API is an integer in minor units (cents): a
    balance of one hundred dollars is the number 10000 , not the string "10000" …
```

So `balance` must be an **integer** (cents). The screen showing `$100.00` tells
you nothing about the type — the browser happily divides a string by 100. Time to
look at what the API actually sends.

---

## 3. Catch it live — a green request that still breaks the contract

Run the `get-account` request against the live server, and this time hand it the
**contract** (`openapi.json`) to check the response against:

```bash
sackville-cli api run api get-account --env Local --openapi openapi.json
```

```
GET  http://localhost:8137/account
sent
status 200  5.7ms
PASS  status equals
PASS  jsonpath exists $.balance
body: sackville://run/…/body
request contract: valid
response contract: INVALID
  ERROR response-schema: /balance must be integer (/balance)
```

Look closely. **Every assertion passes** — the status is 200, `balance` exists.
A normal smoke test is green. But the **response contract is INVALID**: the server
sent `balance` as the string `"10000"` where the spec says `integer`. The command
exits non-zero (`1`) on the contract breach, so CI would catch it — *if* the smoke
test had checked the contract instead of just status-and-presence.

> The `get-account.sackville.yml` sidecar asserts only `status == 200` and that
> `balance` exists — deliberately. That is the trap a real smoke test falls into:
> it never checks the field's *type*. `--openapi` is what closes the gap.

---

## 4. Catch it in captured browser traffic — the capture→contract bridge

Step 3 re-ran the request itself. But what about the traffic a **real user flow**
produced? `storefront.har.zip` is a captured recording of the dashboard's network
traffic — `GET /dashboard` and the `GET /account` behind it — from a browser
session that **succeeded** (the page rendered `$100.00`). Validate that recording
against the contract, no server required:

```bash
sackville-cli api validate-capture storefront.har.zip --openapi openapi.json
```

```
capture: NOT CLEAN (1 entries)
  1× response-schema
  first failing: GET /account — response-schema: /balance must be integer
  exercised: GET /account
```

This is the headline: **a passing browser flow does not prove the contract
holds.** The capture is clean to the eye and to the UI, but the traffic inside it
violates the API contract. "Absence is never a pass" — an unverifiable or invalid
entry can never make a capture clean.

---

## 5. One verdict

`verify run` drives the pillars you ask for and folds them into a single verdict.
Ask it to **produce** a capture by driving the `get-account` request, then validate
it against the contract:

```bash
sackville-cli verify run "$PWD" \
  --request get-account --collection-dir "$PWD/api" \
  --var baseUrl=http://localhost:8137 \
  --openapi openapi.json \
  --allow-host localhost --allow-private --allow-run
```

```
verdict: FAIL (worst severity high)
  contract: fail [high] — 1 contract error(s) across 1 response(s)
  coverage: missing — no input supplied
  deps:     missing — no input supplied
  flake:    missing — no input supplied
  mutate:   missing — no input supplied
```

The composite is **FAIL** (exit `1`) because the contract pillar found a hard
error. The other pillars read `missing` — you didn't ask for them — and that's the
verify rule in action: a pillar you didn't run is never counted as a pass.

> `--request` drives a live request, so it needs `--allow-run` and a host the
> request may reach (`--allow-host localhost --allow-private`). It loads the
> request by **name** from `--collection-dir`; supply `{{baseUrl}}` with `--var`.

---

## 6. Fix it, and watch the verdict flip

Open `account.js` and fix the one field — make `balance` a **number**:

```diff
-    balance: '10000',
+    balance: 10000,
```

Restart the server (`Ctrl-C`, then `npm start` again — Node caches the module), and
re-run the checks:

```bash
sackville-cli api run api get-account --env Local --openapi openapi.json   # response contract: valid
sackville-cli verify run "$PWD" --request get-account --collection-dir "$PWD/api" \
  --var baseUrl=http://localhost:8137 --openapi openapi.json \
  --allow-host localhost --allow-private --allow-run
```

```
verdict: INCONCLUSIVE (worst severity none)
  contract: pass — 1 response(s) match the contract
  coverage: missing — no input supplied
  deps:     missing — no input supplied
  flake:    missing — no input supplied
  mutate:   missing — no input supplied
```

`contract: pass` is your proof — the response now matches its declared shape. The
**overall** verdict is `INCONCLUSIVE` (exit `2`), and that is *correct*, not a
failure: you only ran one pillar, so verify treats the four you didn't run as
unchecked. The composite goes green only when every dimension relevant to the
change has been affirmatively checked. (Exit codes: `0` pass, `1` fail, `2`
inconclusive — a CI gate on the composite would supply every pillar that matters.)

---

## 7. Bonus — produce the capture yourself, with a real browser

Step 4 used a committed recording so you didn't need a browser. To make your own,
install a browser engine and drive the persisted login flow live. `verify run
--flow` will sign in, capture the dashboard's traffic, and validate it — the
**browser** pillar producing the HAR that the **api** pillar checks:

```bash
npx playwright install chromium     # one-time

SACKVILLE_BROWSER_SECRET_PASSWORD=hunter2 \
sackville-cli verify run "$PWD" \
  --flow login --flows-dir "$PWD/flows" \
  --var baseUrl=http://localhost:8137 --var username=ada \
  --openapi openapi.json \
  --allow-host localhost --allow-private --allow-unsafe --allow-run
```

```
verdict: FAIL (worst severity high)
  contract: fail [high] — 1 contract error(s) across 1 response(s)
  …
```

The flow (`flows/login.sackville.yml`) keys off **semantic locators**
(`{role: textbox, name: Username}`), not brittle CSS, and `{{secret:PASSWORD}}`
resolves from `SACKVILLE_BROWSER_SECRET_PASSWORD` and is redacted from every
result. `--allow-unsafe` lets the flow's `fill`/`click` steps actually execute (a
flow is a mutation, like `sackville browser run --unsafe`). With the bug present
the flow itself **passes** — the dashboard renders `$100.00` — but the verdict is
`FAIL`: the same lie, now caught end-to-end through a real browser.

---

## 8. Now do it through the MCP, from Claude Code

Everything above maps to MCP tools an agent drives directly. Point Claude Code at
the aggregate server with this project's docs index and the pillars wired in:

```bash
claude mcp add sackville \
  --env SACKVILLE_INDEX=$PWD/storefront-core.sqlite \
  --env SACKVILLE_TOOLSETS=docs,api,verify \
  --env SACKVILLE_ARTIFACTS_ROOT=$PWD/.sackville \
  --env SACKVILLE_VERIFY_ALLOW_CAPTURE=1 \
  --env SACKVILLE_VERIFY_ENABLE_RUN=1 \
  --env SACKVILLE_API_COLLECTIONS_DIR=$PWD/api \
  --env SACKVILLE_API_ALLOWED_HOSTS=localhost \
  -- npx -y sackville-mcp
```

Then (with the server still running) ask Claude Code, in this directory:

> *"The storefront dashboard shows a balance of $100.00 and the login flow passes,
> but I'm not sure the `/account` API matches its OpenAPI contract. Use the
> Sackville tools to confirm what `balance` should be, check the live response and
> the captured traffic against the contract, and give me one verdict."*

With the bundled `sackville` skill (`.claude/skills/sackville/`), Claude reaches
for Sackville's tools instead of `curl` + eyeballing:

| Step | Tool the agent uses |
| --- | --- |
| Confirm `balance` is an integer (cents) | **`search_docs`** → **`get_doc`** |
| Check the live response against the contract | **`run_request`** + **`validate_response`** |
| Check captured traffic against the contract | **`validate_capture`** (on `storefront.har.zip`) |
| Fold it into one verdict | **`verify_change`** |

> **Why this app and not tutorials 1–2 for the agent demo.** The bug here is
> invisible to the running app *and* to a green flow — it lives in the gap between
> what the API sends and what it promised. Only a tool that knows the contract
> (`validate_response` / `validate_capture`) can see it. That's when these pillars
> earn their keep.

---

## Reset

```bash
./reset.sh        # restores the pristine (intentionally buggy) account.js
rm -f storefront-core.sqlite   # the index you built in step 1 (regenerate any time)
```

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `npm i -g @sackville-mcp/cli` dies compiling `better-sqlite3` | Odd-numbered Node with no prebuilt binary. Switch to an **LTS Node** (`nvm use --lts`) and reinstall. |
| `verify run` says `contract: no-signal (errored) … invalid request URL: {{baseUrl}}/account` | You didn't pass `--var baseUrl=…`. The `--request` path doesn't load the `.bru` environment file; supply the variable on the command line. |
| `verify run` / `api run` `refused: … private address` | Add `--allow-private` (the server is on `localhost`) and `--allow-host localhost`. |
| The fix didn't take — contract still INVALID | Node caches modules; **restart the server** after editing `account.js`. |
| `verify run --flow` says `flow … did not complete (step "fill" failed)` | Add `--allow-unsafe` — a flow's `fill`/`click` are mutations and dry-run without it. Make sure `SACKVILLE_BROWSER_SECRET_PASSWORD` is exported so `{{secret:PASSWORD}}` resolves. |
| `search` seems to hang on first use | It's downloading the ~130 MB query-embedding model once; it caches. FTS works without it. |
| Step 7 errors spawning a browser | Run `npx playwright install chromium`. The main path (steps 1–6) needs no browser. |

---

## Appendix: the docs format

The search in step 2 worked because we indexed `storefront-core`'s docs. You can
do the **same for any library your project depends on** — see the
[tutorial 1 appendix](../todo/README.md#appendix-the-docs-format-and-indexing-your-own-app)
for the `index.json` / `db.json` schema, or pull a published library straight from
DevDocs by slug (`sackville-ingest build --slug react …`).

---

## What you just used

| Pillar / tool | What it did here |
| --- | --- |
| **docs** (`search_docs` / `sackville-cli search`) | the *intended* type of a field, from the API's own docs, offline |
| **api** (`api run --openapi`) | a live response that passed every assertion yet broke its contract |
| **api** (`api validate-capture`) | the same breach found in a recording of a *passing* browser flow |
| **browser** (`verify run --flow`, bonus) | drove a real login flow and captured the traffic to validate |
| **verify** (`verify run` / `verify_change`) | one composed verdict; absence is never a pass |

This is the third Sackville tutorial. Tutorials [1](../todo/) and [2](../scheduler/)
cover `coverage`, `lsp`, and `mutate` on smaller apps. The same shape reaches
GraphQL contracts, dependency/CVE audits, and flaky-test detection — see the repo
[`README.md`](../../../README.md).
