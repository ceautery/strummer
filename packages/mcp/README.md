# @strummer/mcp

The Strummer MCP server(s) — expose Strummer's pillars to an LLM agent as MCP
tools and resources. Two servers ship from this package:

- **`strummer-mcp`** — the **docs** server over [`@strummer/core`](../core)
  (Tools / Resource below).
- **`strummer-api-mcp`** — the **API-testing** server over [`@strummer/api`](../api)
  (API tools below).

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

## Run

```bash
strummer-mcp <index.sqlite>          # docs; or: STRUMMER_INDEX=… strummer-mcp

# API testing — mutations dry-run unless explicitly unlocked:
strummer-api-mcp
STRUMMER_ALLOW_UNSAFE=1 STRUMMER_ALLOWED_HOSTS=api.example.com strummer-api-mcp
```

Both speak MCP over stdio.

### Register with Claude Code

```bash
claude mcp add strummer     -- strummer-mcp /path/to/index.sqlite
claude mcp add strummer-api -- strummer-api-mcp
```

## Token economy

Search returns summaries + resource links, not bodies; the agent fetches full
text only when it follows a link. This keeps results well under Claude Code's
~10k-token warning threshold. See `ARCHITECTURE.md` §4.
