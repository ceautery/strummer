# strummer-ingest

The Python half of Strummer: it ingests documentation and writes the SQLite
index (the on-disk contract) that `@strummer/mcp` serves. See `ARCHITECTURE.md`.

## Pipeline

`source adapter → HTML section chunking → type normalization → embeddings → SQLite`

- **`fetch`** — download a DevDocs set (`index.json` + `db.json`) and its
  manifest metadata (release, attribution).
- **`devdocs`** — adapter: pages → `Fragment`s, chunked at heading boundaries,
  with the matching entry's name/type attached.
- **`dash`** — adapter: a Dash `.docset` bundle (`searchIndex` + `Documents/*.html`)
  → `Fragment`s, mirroring the DevDocs adapter. (Core Data docsets: not yet.)
- **`extract`** — `split_sections(html)` via selectolax (code blocks preserved;
  on-page table-of-contents lists stripped); `symbol_from_heading` recovers a
  symbol from signature headings.
- **`types_map`** — DevDocs (`normalize_type`) and Dash (`normalize_dash_type`)
  type strings → Strummer taxonomy
  (`hook`/`component`/`directive`/`api`/`guide`/`lint`/`legacy`/`function`/
  `method`/`class`/`reference`).
- **`embed`** — `FastEmbedEmbedder` (bge-small-en-v1.5, 384-d) for real builds;
  `FakeEmbedder` (deterministic) for tests/offline.
- **`build`** — applies the schema, inserts docs (FTS auto-syncs via triggers),
  embeds bodies, writes vectors, checkpoints + VACUUMs to a single clean file.

## Build the React 19 index

```bash
uv run strummer-ingest build --slug react --library react --out ../../data/react.sqlite
# offline embeddings (no model download): add  --embedder fake
# from local files instead of fetching:   --index index.json --db db.json --version 19.2
```

`--slug` auto-fills version/attribution/home from the DevDocs manifest. The
output (multi-MB) is a reproducible artifact under `data/` (gitignored).

```bash
# From a Dash docset bundle instead (version is required; --home optional):
uv run strummer-ingest build --docset path/to/Widget.docset \
  --library widget --version 1.0 --home https://widget.dev/ --out ../../data/widget.sqlite
```

Then serve it: `strummer-mcp ../../data/react.sqlite` (see `packages/mcp`).

## Known rough edges (tracked for refinement)

- Ranking is FTS-only today; hybrid vector + RRF reranking is the next step
  (embeddings are already stored in `docs_vec`).
- Dash Core Data docsets (`ZTOKEN` schema) aren't read yet — only `searchIndex`.

## Develop

```bash
uv sync
uv run pytest          # uses FakeEmbedder; real embedding tests are skipped
uv run ruff check . && uv run ruff format --check .
```
