---
name: Sackville tools
description: >-
  Use the Sackville MCP server's tools instead of ad-hoc shell commands when
  working in a repo where it is connected. Prefer semantic LSP navigation over
  grep/find, version-pinned docs search over guessing APIs, and the verification
  pillars (coverage, deps, flake, mutate, verify) over eyeballing a change.
when_to_use: >-
  Searching for where a symbol is defined/used, resolving a type, renaming,
  looking up a library's current API, checking a dependency for CVEs, validating
  an API response/request against a contract, or confirming a change is tested
  and safe — whenever the `sackville` MCP server is available.
---

# Using Sackville's tools

When the **`sackville` MCP server is connected to this session**, prefer its
tools over reinventing them with shell commands. They are more precise (semantic,
not textual), token-cheaper (structured output, large bodies by handle), and
safer (deny-by-default, secret-redacting). If a tool below is **not present**, the
operator hasn't enabled that pillar — fall back to the conventional approach and,
where useful, tell the user which `SACKVILLE_*` env var would unlock it.

## Reach for the Sackville tool first

| Instead of… | Use… |
| --- | --- |
| `grep -rn name .` / `find . -name … \| xargs grep` to find a symbol's definition | **`lsp_find_definition`** (exact, follows imports/re-exports) |
| grepping to find everywhere a function is called | **`lsp_find_references`** / **`lsp_call_hierarchy`** |
| reading a file to figure out a variable's type or a signature | **`lsp_hover`**, **`lsp_type_definition`** |
| scanning a file top-to-bottom for its structure | **`lsp_document_symbols`** (one file) / **`lsp_workspace_symbols`** (whole project) |
| a sed/script-based rename across files | **`lsp_rename`** (dry-run by default; applies only when the operator set `_ALLOW_WRITE`) |
| `tsc`/`ruff`-by-hand to find errors in one file | **`lsp_diagnostics`** |
| guessing a library's API from memory | **`search_docs`** then **`get_doc`** — version-pinned to what's installed |
| `npm audit` / reading changelogs by hand | **`audit_dependency`**, **`audit_project`**, **`changelog_diff`** |
| eyeballing whether new code is tested | **`uncovered_in_diff`**, **`run_scoped`** / **`py_run_scoped`** |
| assuming a test is "just flaky" | **`flake_status`**, **`flake_candidates`** |
| trusting green tests blindly | **`mutate_summarize`** / **`mutate_run`** (do the tests actually catch bugs?) |
| manually checking an API matches its spec | **`validate_response`**, **`validate_request`**, **`validate_capture`** |
| judging a change by feel | **`verify_change`** — folds coverage/deps/flake/mutate/contract into one verdict |

## How to use them well

**LSP navigation (the big win).** Positions are **1-based** line and column.
Pass the `language` (e.g. `typescript`, `python`, `rust`), the file, and the
position. Results carry a tri-state `status`:

- `ok` — trust the result.
- `not_ready` — the language server is still indexing. Wait a moment and retry
  the *same* call; do **not** fall back to grep on the first `not_ready`.
- `no_result` — there genuinely is no definition/reference there.

Use `lsp_languages` (always available, no spawn) to see which languages the
operator has bound and whether a server is live. LSP tools require the operator
to have set `SACKVILLE_LSP_ALLOW_RUN` + `SACKVILLE_LSP_PROJECT_ROOTS`; if they're
absent, that's why — fall back to text search and mention it.

**Docs search beats recalling APIs.** For any "how do I use X in library Y"
question, call `search_docs` (optionally with `--library`/`installed` so it pins
to the version in the project), then `get_doc` on the best hit. This is the cure
for hallucinated or outdated API usage. Requires `SACKVILLE_INDEX` to point at a
built docs index.

**Large results come back by handle.** Reference lists, symbol trees, rename
previews, audit details, and doc bodies may be capped inline with a
`sackville://…` resource handle for the full set. Read the handle when you need
everything; the inline head is usually enough to decide.

**Verification, not vibes.** After a non-trivial change, prefer `verify_change`
(or the individual pillars). Its load-bearing rule is **absence is never a pass**:
a missing or no-signal pillar yields `inconclusive`, never `pass`. Treat
`inconclusive` as "not verified," not "fine."

**Respect the safety model.** Tools that send requests, run tests, spawn servers,
or write files are deny-by-default and gated by operator-set `SACKVILLE_*` env
vars — you cannot enable them from a tool argument. A mutating API request is a
dry-run unless the operator allowed it. Don't try to work around a gate; surface
what the operator would need to set.

## When Sackville isn't connected

If none of these tools appear in this session, Sackville isn't wired up. The
conventional tools (Grep, Glob, Read, Bash) are correct. If the work would clearly
benefit (large codebase navigation, dependency auditing, change verification),
suggest adding it: `claude mcp add sackville -- npx -y sackville-mcp`.
