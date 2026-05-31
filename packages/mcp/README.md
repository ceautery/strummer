# @strummer/mcp

The Strummer MCP server — exposes the docs index to an LLM agent as MCP tools and
resources. A thin adapter over [`@strummer/core`](../core); it opens an index
file (built by `strummer-ingest`) read-only and serves queries.

## Tools

- **`search_docs`** — **hybrid** search: FTS5/bm25 fused with vector KNN via
  reciprocal rank fusion. Inputs: `query`, optional `library`/`version`/`type`/
  `limit` (default 8, max 25). Returns **compact** results (`id`, `title`,
  `symbol`, `type`, `library`, `version`, `score`, `snippet`, `resourceUri`) as
  `structuredContent` — never full bodies. The query is embedded in-process with
  transformers.js (`Xenova/bge-small-en-v1.5`), matching the indexed vectors
  (ADR 0003); the model (~130 MB) downloads once on first query.
- **`get_doc`** — inputs: `id`. Returns the full fragment (the one place bodies
  are returned). Errors if the id is unknown.

## Resource

- **`strummer://doc/{id}`** — the same full fragment as `get_doc`, so agents can
  follow a search hit's `resourceUri` without a tool call.

## Run

```bash
strummer-mcp <index.sqlite>          # or: STRUMMER_INDEX=… strummer-mcp
```

Speaks MCP over stdio.

### Register with Claude Code

```bash
claude mcp add strummer -- strummer-mcp /path/to/index.sqlite
```

## Token economy

Search returns summaries + resource links, not bodies; the agent fetches full
text only when it follows a link. This keeps results well under Claude Code's
~10k-token warning threshold. See `ARCHITECTURE.md` §4.
