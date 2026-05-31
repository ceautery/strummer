# ADR 0003 — Query embedding in the Node server (transformers.js)

- **Status:** Accepted
- **Date:** 2026-05-31

## Context

Hybrid search needs the **query** embedded at serve time, in the same vector
space as the indexed document embeddings (built by Python `fastembed`,
bge-small-en-v1.5, 384-d). ADR 0001 deferred query-time embedding and said we'd
add "a thin Python index-service" if it became necessary. It now has.

Options weighed:
1. **Node `fastembed`** — same model family, but its Rust tokenizer
   (`@anush008/tokenizers`) ships no `linux-arm64-gnu` prebuilt, so it won't run
   in the dev container. Rejected.
2. **Python query-embedding sidecar** — guaranteed identical model, but couples
   the server runtime to Python and either spawns per query (slow model load) or
   becomes the long-running RPC service we explicitly avoided.
3. **transformers.js (`@huggingface/transformers`, `Xenova/bge-small-en-v1.5`)**
   — pure-JS tokenizer + onnxruntime-node, cross-platform.

## Decision

Embed queries **in the Node MCP server with transformers.js**, CLS pooling +
L2 normalize, using the bge query-instruction prefix. The server stays a single
self-contained Node process — **no Python in the request path**.

This was gated on an empirical check: embedding stored documents' own text with
transformers.js reproduced the Python-`fastembed` vectors at **cosine = 1.00000**
across samples. The two exports of bge-small-en-v1.5 are interchangeable, so
query (transformers.js) and document (fastembed) embeddings share one space.

## Consequences

- `@strummer/mcp` gains `@huggingface/transformers` (+ onnxruntime-node). The
  bge model (~130 MB) downloads once on first query and is cached.
- `core.searchDocs` stays embedder-agnostic: it takes an optional `queryVector`
  and does the FTS + vec KNN + RRF fusion. The server owns the embedder and
  injects it; omitting it yields FTS-only (used in fast, offline tests).
- The ingester and server now embed with **different libraries** that must stay
  vector-compatible. If either bumps the model, re-verify the cosine match.
- ADR 0001's "Python index-service" escape hatch remains unused.
