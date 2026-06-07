# Sackville tutorial 3 — when the UI works but the API is lying

The [first tutorial](../todo/) found a bug a green test suite hid (an *uncovered*
branch). The [second](../scheduler/) found one that line coverage *couldn't* see
(a covered line whose behaviour no test pinned). This one finds a bug that no
amount of testing the **app** will catch, because the app works perfectly: the
page renders, the buttons click, the end-to-end flow is green — and the API
underneath is quietly violating its own contract.

And this contract breach is not cosmetic. It silently corrupts money in a
*different* part of the system — a place your login test never looks — and it
does it without a single error or a single red test. This is where the **api**,
**browser**, and **verify** pillars earn their keep.

You will:

1. Watch a contract breach that has **already shipped a money bug** — a financial
   export that is silently wrong, with nothing on screen to show for it.
2. **Install** the API's docs into a Sackville index — fully offline — and learn
   what a response is *supposed* to contain.
3. **Catch the violation live**, against the running server, even though every
   assertion passes (`api run --openapi`).
4. **Catch the same violation in captured browser traffic** — a recording of a
   *passing* user flow — with the capture→contract bridge (`api validate-capture`).
5. **Fold it into one verdict** (`verify run`), fix it, and watch both the verdict
   and the money bug flip back to correct.
6. Do it again through the **MCP** server from Claude Code.

The app is intentionally broken in one place: `GET /account` silently **drops a
required field**. `./reset.sh` puts it back when you're done.

> **Time:** ~25 minutes. No API keys. Stands alone, but builds on tutorials 1–2.

---

## Prerequisites — check these first

| Need | Why | Check / install |
| --- | --- | --- |
| **Node — an *even-numbered* LTS line (22 or 24)** | Runs the sample server (zero dependencies) and `npm i -g @sackville-mcp/cli` (which pulls `better-sqlite3`, prebuilt for LTS Node only). | `node --version` → `v22.x`/`v24.x`. Manage with `nvm use --lts`. |
| **`uv`** (Python package manager) | Builds the offline docs index in step 2. | `uv --version`; install with `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh`. |
| **The Sackville CLI** | Every step below uses `sackville-cli`. | `npm i -g @sackville-mcp/cli` |
| **A browser engine** — *optional* | Only for the **bonus** “produce the capture yourself” step. The main path uses a **committed** capture, so you can skip this. | `npx playwright install chromium` |

There is **no `npm install`** for the app itself — it is plain Node.

---

## 0. Setup — meet the storefront, and the money bug it already shipped

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

Here is the catch. **This customer's account is held in euros.** A second feature
— the USD ledger export that finance built on the same `/account` API — is
supposed to convert it (at the demo rate, €100.00 ≈ $108.00). Ask it:

```bash
curl -s localhost:8137/ledger
```

```json
{"account":"acct-42","currency":"USD","usd":100}
```

It reports **`$100.00`**, not `$108.00`. The euro balance was exported at face
value, as if it were dollars — silently under-reported by ~8% on a financial
document. And notice: nothing errored, no test went red, and *the number it
printed is perfectly plausible*. You cannot see this bug by looking at it. The
dashboard's `$100.00` and the ledger's `$100.00` are both clean, tidy, and wrong.

Something in the contract between `/account` and its consumers is broken. Let's
find it with a tool that actually knows the contract.

Leave the server running in this terminal; use a second terminal for the rest.

---

## 1. Install the API's docs into a Sackville index

The dashboard and the ledger are both built against a small JSON API documented
as `storefront-core`. Its docs ship with this tutorial as a local DevDocs pair
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

## 2. What is `GET /account` *supposed* to return?

The ledger assumed the balance was in dollars. Should the API have told it
otherwise? Don't guess; ask the API's own documentation about the `currency`
field:

```bash
export SACKVILLE_INDEX=$PWD/storefront-core.sqlite
sackville-cli search "is currency a required field on the account" --library storefront-core
```

> **First run may pause** to download a ~130 MB embedding model once, then
> caches. It falls back to full-text search if offline (this index was built with
> `--embedder fake`, so FTS alone finds the hit). Don't Ctrl-C.

The **Currency** page is unambiguous:

```
Currency
    Every account carries a currency (an ISO 4217 code such as EUR or USD), and
    it is a required field on GET /account. … When currency is missing,
    downstream consumers do not error — they quietly assume USD …
```

So `currency` is a **required** field, and a consumer that doesn't get it falls
back to USD — exactly the ledger's silent mistake. The screen told you nothing,
because the dashboard does the same fallback. Time to look at what the API
actually sends.

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
  ERROR response-schema: (root) must have required property 'currency': 'currency'
```

Look closely. **Every assertion passes** — the status is 200, `balance` exists.
A normal smoke test is green. But the **response contract is INVALID**: the
response is missing the required `currency` field. *That* is the dropped field
the ledger never received, so it defaulted to USD. The command exits non-zero
(`1`) on the contract breach, so CI would catch it — *if* the smoke test had
checked the contract instead of just status-and-presence.

> The `get-account.sackville.yml` sidecar asserts only `status == 200` and that
> `balance` exists — deliberately. That is the trap a real smoke test falls into:
> it checks the fields it remembered, and never notices a *required* one is gone.
> `--openapi` is what closes the gap.

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
  first failing: GET /account — response-schema: (root) must have required property 'currency': 'currency'
  exercised: GET /account
```

This is the headline: **a passing browser flow does not prove the contract
holds.** The capture is clean to the eye and to the UI, but the traffic inside it
is missing a required field. "Absence is never a pass" — an unverifiable or
invalid entry can never make a capture clean.

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
  deps: missing — no input supplied
  flake: missing — no input supplied
  mutate: missing — no input supplied
```

The composite is **FAIL** (exit `1`) because the contract pillar found a hard
error. The other pillars read `missing` — you didn't ask for them — and that's the
verify rule in action: a pillar you didn't run is never counted as a pass.

> `--request` drives a live request, so it needs `--allow-run` and a host the
> request may reach (`--allow-host localhost --allow-private`). It loads the
> request by **name** from `--collection-dir`; supply `{{baseUrl}}` with `--var`.

---

## 6. Fix it, and watch the verdict — and the ledger — flip

Open `account.js` and put the dropped field back into the response:

```diff
 export function getAccount() {
-  return { id: RECORD.id, owner: RECORD.owner, balance: RECORD.balance }
+  return { id: RECORD.id, owner: RECORD.owner, balance: RECORD.balance, currency: RECORD.currency }
 }
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
  deps: missing — no input supplied
  flake: missing — no input supplied
  mutate: missing — no input supplied
```

`contract: pass` is your proof — the response now carries every required field.
And the money bug heals at the same time, because the ledger finally sees the
currency:

```bash
curl -s localhost:8137/ledger
# {"account":"acct-42","currency":"EUR","usd":108}   # was $100.00 — now correctly converted
```

The **overall** verdict is `INCONCLUSIVE` (exit `2`), and that is *correct*, not a
failure: you only ran one pillar, so verify treats the four you didn't run as
unchecked. The composite goes green only when every dimension relevant to the
change has been affirmatively checked. (Exit codes: `0` pass, `1` fail, `2`
inconclusive — a CI gate on the composite would supply every pillar that matters.)

---

## 7. Bonus — produce the capture yourself, with a real browser

> **Run this against the buggy app.** If you already applied the fix in step 6,
> run `./reset.sh` first — the point here is to watch a *passing* browser flow
> still produce a `FAIL` verdict, which only happens while the bug is present.

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
`FAIL`: the same dropped field, now caught end-to-end through a real browser.

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
> but the USD ledger export at `/ledger` looks wrong for this account. Use the
> Sackville tools to confirm what `GET /account` is required to return, check the
> live response and the captured traffic against the contract, and give me one
> verdict."*

With the bundled `sackville` skill (`.claude/skills/sackville/`), Claude reaches
for Sackville's tools instead of `curl` + eyeballing:

| Step | Tool the agent uses |
| --- | --- |
| Confirm `currency` is a required field | **`search_docs`** → **`get_doc`** |
| Check the live response against the contract | **`run_request`** + **`validate_response`** |
| Check captured traffic against the contract | **`validate_capture`** (on `storefront.har.zip`) |
| Fold it into one verdict | **`verify_change`** |

> **Why this app and not tutorials 1–2 for the agent demo.** The bug here is
> invisible to the running app *and* to a green flow — it lives in the gap between
> what the API sends and what it promised, and it quietly corrupts a downstream
> total. Only a tool that knows the contract (`validate_response` /
> `validate_capture`) can see it. That's when these pillars earn their keep.

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
| **docs** (`search_docs` / `sackville-cli search`) | what a response is *required* to contain, from the API's own docs, offline |
| **api** (`api run --openapi`) | a live response that passed every assertion yet broke its contract |
| **api** (`api validate-capture`) | the same breach found in a recording of a *passing* browser flow |
| **browser** (`verify run --flow`, bonus) | drove a real login flow and captured the traffic to validate |
| **verify** (`verify run` / `verify_change`) | one composed verdict; absence is never a pass |

This is the third Sackville tutorial. Tutorials [1](../todo/) and [2](../scheduler/)
cover `coverage`, `lsp`, and `mutate` on smaller apps. The same shape reaches
GraphQL contracts, dependency/CVE audits, and flaky-test detection — see the repo
[`README.md`](../../../README.md).
