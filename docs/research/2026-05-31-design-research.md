# Design research — 2026-05-31

Raw output of the 6-stream design-research workflow + synthesis. Distilled into ARCHITECTURE.md; kept here for provenance.

## Synthesis

This is a synthesis/architecture task, not a code task. No tools needed — I'll produce the recommendation directly.

# Sackville Milestone 1 — Docs Pillar Architecture

## 1. Repo / package layout

pnpm workspace monorepo, Node 22, with the Python ingester as a sibling package inside the same repo (not published to npm; built/distributed via uv).

```
sackville/
  pnpm-workspace.yaml          # packages globs + version catalog
  biome.json
  package.json                 # private root
  packages/
    core/                      # TS domain logic: open DB, run hybrid query, types
      src/{db,search,schema,types}.ts
    mcp/                        # thin MCP adapter over core (stdio server)
      src/server.ts
    cli/                       # thin CLI adapter over core (#!/usr/bin/env node)
      src/index.ts
  py/
    sackville_ingest/           # uv-managed Python package; console_scripts CLI
      pyproject.toml
      src/sackville_ingest/{cli,sources,extract,chunk,embed,db}.py
  schema/
    sackville.schema.sql         # THE CONTRACT — single source of truth DDL
    sackville.schema.json        # version constant + dim + tokenizer, machine-readable
  fixtures/                    # tiny committed .docset + golden .sqlite for tests
```

Key rule: `core` is the only package that touches SQLite. `mcp` and `cli` are thin adapters depending on `core` via `workspace:*`. The Python side and the TS side never RPC; they meet only at `schema/sackville.schema.sql` and the on-disk `.sqlite` file. **Both languages read the schema version from `schema/sackville.schema.json` and refuse to operate on a mismatched DB** — this is what makes the file-as-contract safe.

## 2. Tool + library + version picks

TypeScript (Node 22 LTS):
- pnpm 11.4.0 (fallback 10.32+ if CI Node < 22)
- Biome 2.4.16 (lint+format, drop ESLint/Prettier)
- Vitest 4.1.x + @vitest/coverage-v8 4.1.7 (use `test.projects`, not `workspace`)
- tsdown 0.20.3 (ESM + .d.ts; CLI gets a shebang so bin auto-emits)
- better-sqlite3 (current major) — **required**, not `node:sqlite` (sqlite-vec extension loading needs Node 23.5+; we're on 22). Allowlist in pnpm `onlyBuiltDependencies`.
- sqlite-vec (npm, 0.1.x matching 0.1.9) loaded via `sqliteVec.load(db)`
- @modelcontextprotocol/sdk 1.29.0 — v1 subpath imports for `McpServer`/`StdioServerTransport`. Do **not** couple to v1 internals; v2 (split server/client) expected Q1 2026.
- Zod 3.25 or 4.0 (peer dep)
- TypeScript 5.x

Python (3.10+; recommend 3.12):
- uv 0.11.17 (project + lockfile + Python pin)
- Ruff 0.15.15 (lint+format)
- trafilatura 2.0.0 (main-content extraction, `favor_recall` for docs)
- selectolax 0.4.10 (LexborHTMLParser explicitly — keep code blocks/anchors trafilatura flattens)
- sqlite-vec 0.1.9 (PyPI) — must run on a Python whose sqlite3 allows `enable_load_extension`
- model2vec 0.8.2 with **potion-retrieval-32M** as default embedder (offline, numpy-only, 512-dim)
- stdlib sqlite3 (FTS5 built in)

Low-confidence / flag-for-attention picks:
- **Embedding model + dimension is the riskiest single decision.** model2vec/potion-retrieval-32M is 512-dim and static (uncontextualized) — cheap and offline but weaker on nuanced "how do I" semantic queries. fastembed/bge-small (384-dim) is the quality upgrade. The dim is **frozen into the vec0 schema**, so this is a contract decision, not an implementation detail. → human decision (Section 7).
- @modelcontextprotocol/sdk mid-transition (v1.29 now, v2 imminent). Medium confidence it stays stable through M1; keep the MCP layer thin so a v2 port is contained.
- selectolax 0.4.10 is very recent (2026-05-26) — low-risk but unproven longevity.
- Single-binary distribution (Node SEA / bun compile / Homebrew) is explicitly **out of scope for M1**; default to `node` bin + `uvx`.

## 3. SQLite index schema — the TS↔Python contract

`schema/sackville.schema.sql`. Python writes it; TS reads it. Note the explicit `sackville_meta` table carrying schema version + embedding model + dim so both sides can assert compatibility.

```sql
-- contract/version guard
CREATE TABLE sackville_meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seeded by ingester: schema_version, embed_model, embed_dim, built_at, builder_version

-- 1. canonical fragments (the source of truth for body text)
CREATE TABLE docs(
  id           INTEGER PRIMARY KEY,
  library      TEXT NOT NULL,     -- 'react'
  version      TEXT NOT NULL,     -- '19.0'  (the doc 'release', pinned)
  title        TEXT NOT NULL,
  symbol       TEXT,              -- 'useState'
  type         TEXT,              -- normalized Dash/DevDocs taxonomy: function|class|guide|...
  heading_path TEXT,              -- 'Hooks > useState'
  url          TEXT,              -- upstream URL (#anchor preserved)
  attribution  TEXT,              -- upstream license/attribution HTML (license compliance)
  body         TEXT NOT NULL      -- cleaned text fragment for snippets/embeddings
);
CREATE INDEX docs_libver ON docs(library, version);

-- 2. FTS5 external-content (no body duplication; enables snippet()/highlight())
CREATE VIRTUAL TABLE docs_fts USING fts5(
  title, body, symbol,
  library UNINDEXED, version UNINDEXED,
  content='docs', content_rowid='id',
  tokenize='porter unicode61',
  prefix='2 3'
);
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid,title,body,symbol,library,version)
  VALUES(new.id,new.title,new.body,new.symbol,new.library,new.version);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts,rowid,title,body,symbol,library,version)
  VALUES('delete',old.id,old.title,old.body,old.symbol,old.library,old.version);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts,rowid,title,body,symbol,library,version)
  VALUES('delete',old.id,old.title,old.body,old.symbol,old.library,old.version);
  INSERT INTO docs_fts(rowid,title,body,symbol,library,version)
  VALUES(new.id,new.title,new.body,new.symbol,new.library,new.version);
END;

-- 3. vectors with pushdown filters (DIM IS A CONTRACT CONSTANT — 512 for potion-retrieval-32M)
CREATE VIRTUAL TABLE docs_vec USING vec0(
  doc_id    INTEGER PRIMARY KEY,
  library   TEXT,              -- filterable in KNN WHERE
  version   TEXT,              -- filterable in KNN WHERE
  type      TEXT,              -- filterable in KNN WHERE
  embedding float[512] distance_metric=cosine
);
```

Contract invariants to encode as tests on **both** sides:
- `sackville_meta.embed_dim` must equal the `float[N]` in the vec0 DDL.
- `docs.id` == `docs_fts.rowid` == `docs_vec.doc_id`.
- FTS triggers must exist (no manual sync).
- Build with WAL, then `wal_checkpoint(TRUNCATE)` + `VACUUM` so the shipped file is a single clean artifact the TS reader opens read-only.

## 4. MCP tools (token-efficient)

Two tools. Search returns **compact metadata + resource links only — never inlines bodies.** Full text is fetched on demand via a Resource. This is the core token-economy move (Claude Code warns >10k, caps 25k, persists oversized to disk).

`sackville.search_docs`
- Input (Zod): `query: string`, `library?: string`, `version?: string`, `type?: string`, `limit?: number (default 8, max 25)`, `cursor?: string`
- Behavior: hybrid RRF (FTS5 MATCH + vec0 KNN), version filter pushed to **both** halves.
- structuredContent: `{ results: [{ id, title, symbol, type, library, version, score, snippet, resourceUri }], nextCursor?: string }` where `snippet` is a short FTS `snippet()` excerpt (~12 tokens) and `resourceUri` is `sackville://doc/{id}`.
- Also emit the same JSON as a text content block (some clients break on structuredContent alone).

`sackville.get_doc`
- Input: `id: number` (or accept the `sackville://doc/{id}` URI)
- structuredContent: `{ id, title, heading_path, library, version, url, attribution, body }` — the one place full body text is returned, and only when the agent explicitly asks.

Resource: `sackville://doc/{id}` mirrors `get_doc` so agents can follow resource links without a tool call.

Server `instructions` (≤2KB, since Tool Search is on): state that search returns summaries+links and the agent must call `get_doc`/follow the resource link for full content; describe the version-pin semantics. Paginate with opaque cursor; small default limit.

## 5. Ingestion pipeline stages (Python CLI)

`sackville-ingest build --source <docset|devdocs> --in <path> --out sackville.sqlite [--library X --version Z]`

1. **Acquire/identify source.** Two adapters behind one interface:
   - *Dash docset*: parse `Contents/Info.plist` (real plist parser — may be binary). Probe `sqlite_master`: `searchIndex` (canonical, ~99% of community docsets) vs `ZTOKEN` Core Data join. M1: implement plain-HTML + `searchIndex` only; tarix/brotli/Core Data are later passes.
   - *DevDocs*: ingest prebuilt `index.json` (entries: name/path/type) + `db.json` (path→HTML). Carry the `release` string as `version`. Both adapters normalize to the **same internal record** `(library, version, title, symbol, type, url, attribution, html)`.
2. **Resolve + extract.** Resolve `path` (relative file / `#anchor` / http URL — handle all three). Extract main content with trafilatura; use selectolax to retain code blocks, tables, heading anchors. Split shared pages by `#anchor` so entries stay finer-grained than pages.
3. **Chunk** by heading/section with overlap; compute `heading_path`.
4. **Type-normalize** Dash's ~76-value enum / DevDocs types onto Sackville's taxonomy via a mapping table.
5. **Embed** each chunk with model2vec potion-retrieval-32M → float32, 512-dim.
6. **Write DB** (apply `schema/sackville.schema.sql`, seed `sackville_meta`, insert `docs` so triggers populate FTS, insert vectors into `docs_vec`). WAL during build → checkpoint → VACUUM.
7. **Emit** machine-readable summary on stdout (counts, schema_version), logs on stderr, meaningful exit codes. Support resumable/incremental ingestion (long builds exceed subprocess timeouts).

Licensing gate (must-have, not optional): record per-doc `attribution`; respect each docset/DevDocs upstream license. **Microsoft/Apple/Oracle are excluded from DevDocs**; Dash licenses are per-folder. Indexing locally is generally fine; redistribution is not — surface attribution in results.

## 6. UNKNOWNS / risks for TDD + human decisions

Resolve during TDD:
- **Embedding dim/model freeze (512 vs 384).** Schema-breaking. Confirm before any vec0 code lands. → human.
- **Version-pin matching.** DevDocs tracks majors/LTS, not patches; Dash is whatever was packaged. Define the fallback when an installed semver has no exact doc version (nearest major? refuse? warn?). → human.
- **RRF tuning** (rrf_k=60, weights 0.8 fts / 1.0 vec) are starting guesses; validate with golden queries. Push version filter on **both** halves or stale versions leak.
- **Extension-loading portability** — the #1 footgun on macOS. better-sqlite3 (TS) bundles its own SQLite; Python must use a Homebrew/python.org interpreter. Add a startup assertion both sides.
- **Code-identifier search**: porter stemming over-stems code tokens. Decide if M1 needs a separate trigram mirror table (`detail='full'`) for symbols/code. Likely defer, but flag.
- Dash compression (tarix/brotli) and Core Data schema coverage — out of M1, but confirms which docsets are testable now.
- model2vec semantic quality on "idiomatic how-to" phrasing — measure; fastembed swap path must stay open (pluggable embedder, dim in meta).

Want the human to weigh in on:
1. Embedding model + dimension (512/potion vs 384/bge). 
2. Version-pin fallback policy.
3. First target corpus for M1 (which one library@version) — drives fixtures and licensing review.
4. License posture: local-index-only for M1, or plan redistribution (changes attribution requirements materially).

## 7. Smallest first red→green TDD step (proves the polyglot boundary)

Goal: prove Python writes a file that TS reads and queries — the entire contract — with the least code.

1. Write `schema/sackville.schema.sql` + `schema/sackville.schema.json` (`{schema_version:1, embed_dim:512, embed_model:"potion-retrieval-32M"}`).
2. **RED (TS, in `core`):** a Vitest test that opens a fixture DB at `fixtures/golden.sqlite`, loads sqlite-vec, asserts `sackville_meta.schema_version == 1`, and runs `search_docs("useState", library="react")` expecting exactly one known result row `{symbol:"useState", version:"19.0"}`. Fails because no fixture/no query code.
3. **GREEN (Python):** a minimal `sackville-ingest` path that applies the schema, seeds `sackville_meta`, inserts **one** hand-crafted `docs` row (`react/19.0/useState`, tiny body) and **one** zero/constant 512-dim vector into `docs_vec`, checkpoints + VACUUMs, writes `fixtures/golden.sqlite`. (No real scraping/embedding yet — a literal fixture row.)
4. **GREEN (TS):** implement `core.openDb()` + `core.searchDocs()` doing the FTS-only branch (vec optional) so the test passes.

This single cycle exercises every contract surface — schema file, meta/version guard, `docs`↔`docs_fts`↔`docs_vec` id alignment, sqlite-vec loading on both runtimes, and the search shape the MCP tool will wrap — without committing to a real source adapter, real embeddings, or RRF tuning. Real Dash/DevDocs ingestion and hybrid ranking layer on next, against the now-proven boundary.

## Findings by stream

### MCP server in TypeScript 2026
**Confidence:** high  
**Summary:** Ship on the modelcontextprotocol sdk version 1.29.0 from npm using McpServer via subpath imports. A v2 line is in development with a stable release expected Q1 2026, so target v1 today. Tools take a Zod input schema and optional output schema and return both a text content block and a structuredContent object. For a docs-search server the key constraint is token economy: Claude Code warns above 10k tokens, caps text at 25k by default, and persists oversized results to disk. Return compact summaries plus resource link blocks and only inline full doc bodies when the agent fetches a resource. Test with the SDK Client over InMemoryTransport plus MCP Inspector.

**Recommendation:** Use modelcontextprotocol sdk 1.29.0 with McpServer and StdioServerTransport. Expose a search tool returning a compact result set plus a resource for full doc bodies. Return snippet, title, score in structuredContent plus a resource link rather than inlining text. Always return both structuredContent and a JSON text block. Paginate with a cursor and small default limit. Stay under the 10k token warning. Register with claude mcp add at local scope and commit a project scoped config. Test via SDK Client over InMemoryTransport plus MCP Inspector.

**Versions:**
- modelcontextprotocol sdk 1.29.0 current stable; v2 in development expected Q1 2026; zod 3.25 or 4.0; Node.js 18 or higher; modelcontextprotocol inspector current

**Key facts:**
- Stable package is modelcontextprotocol sdk 1.29.0 (Node 18 plus, Zod peer dep). v1 uses subpath js imports for McpServer and StdioServerTransport. v2 (server and client packages) is in dev, expected Q1 2026. Tools are model invoked actions, Resources hold full doc bodies, Prompts are user templates. Structured output returns a JSON text block plus structuredContent; errors return isError true with content. A resource link references a resource without inlining bytes. Claude Code warns above 10k tokens, caps at 25k default, and persists oversized output to disk. Config is claude mcp add with flags before the name then command after a double dash. Tool Search is on by default so server instructions matter, truncated at 2KB. Test with SDK Client over InMemoryTransport plus MCP Inspector.

**Gotchas:**
- Mixing v1 subpath imports with the v2 server package will not compile. v1 registerTool schemas expect a raw Zod shape not a wrapped object. structuredContent without a matching JSON text block breaks some clients, so emit both. Claude Code silently persists oversized output to disk, so use resource links and pagination. Stdio servers are not auto reconnected, only HTTP and SSE are.

**Citations:**
- [modelcontextprotocol sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

### Kapeli Dash docset format and feasibility of Sackville ingesting existing docsets
**Confidence:** high  
**Summary:** A Dash .docset is a plain macOS-style bundle directory: docs live as ordinary HTML files under Contents/Resources/Documents/ and an index lives in a SQLite file at Contents/Resources/docSet.dsidx. There are TWO index schemas: the simple/canonical Dash one (a single searchIndex table with name/type/path) used by virtually all user-contributed docsets, and the legacy Apple/Xcode Core Data schema (ZTOKEN/ZTOKENNAME/ZTOKENTYPE/ZFILEPATH/ZTOKENMETAINFORMATION/ZSEARCHINDEX) used by docsets bundled with Xcode. Reading a docset programmatically is straightforward: open the SQLite, read (name, type, path), and resolve path (a relative file path, possibly with #anchor, or an http URL) against Documents/. Most docsets store plain HTML; some are compressed (older tarix.tgz + tarixIndex.db; Dash 6 and newer Apple docsets use a SHA-1/UUID-named cache with brotli compression). For Sackville, ingesting existing Dash docsets is very feasible and a strong bootstrap strategy: the format is open, the index is just SQLite, and the type taxonomy is already normalized. The main caveats are the two index variants, the compression formats, and per-docset documentation licensing.

**Recommendation:** Yes — Sackville should ingest existing Dash docsets to bootstrap its index; it is one of the cheapest, highest-quality sources of pre-curated, pre-typed dev documentation available. Concrete plan: (1) Treat a docset as a directory; read Contents/Info.plist (parse as XML or binary plist) for CFBundleName, dashIndexFilePath, DashDocSetFallbackURL, and DashDocSetFamily. (2) Open Contents/Resources/docSet.dsidx with a stock SQLite driver. Probe the schema: if a 'searchIndex' table exists, SELECT name, type, path — this covers ~99% of community docsets. If instead ZTOKEN exists, run the Core Data join to produce equivalent (name, type, path+#anchor) tuples. Normalize both into Sackville's own (title, type, href) records and map Dash's type strings onto Sackville's symbol taxonomy (the ~76-value enum is a ready-made mapping table). (3) Resolve each path: strip/keep the #fragment, join against Contents/Resources/Documents/. If the file is missing, check for tarix.tgz+tarixIndex.db (look up the offset/length in tarixIndex.db and read that slice of the gzip-decompressed tar) or an Apple-style brotli cache; fall back to DashDocSetFallbackURL only if you want online fetch. (4) For body text/embeddings, parse the resolved HTML (strip nav/chrome, keep the anchored section) rather than relying on Dash's optional FTS tables. Start with the plain-HTML, searchIndex-schema path first (covers the long tail of Dash-User-Contributions); add tarix and Core Data handling as second/third passes. Pull initial docsets from Kapeli/Dash-User-Contributions on GitHub. IMPORTANT on licensing: the docset format/metadata is freely usable, but the bundled HTML is the upstream project's documentation under its own license — read each docset's README/docset.json and respect those terms before redistributing or republishing content; indexing locally for search is generally fine, rehosting may not be.

**Versions:**
- Dash for macOS 6 (current major; introduced the modern brotli/UUID cache storage and FTS defaults)
- SQLite 3 (docSet.dsidx / tarixIndex.db / optimizedIndex.dsidx are all SQLite 3 databases)
- Apple property list format: XML plist 1.0 or Apple binary plist (bplist00) for Info.plist
- tarix (legacy compression tool; tarix.tgz = gzip-compressed tar, tarixIndex.db = SQLite offset index) — still present in older docsets
- Brotli compression for Dash 6 / modern Apple docset cache files
- Kapeli/Dash-User-Contributions GitHub repo (master branch, actively maintained as of 2026; per-docset docset.json + README)
- Reference readers as of 2026: Zeal (open-source cross-platform reader), Kapeli/dash-mcp-server, codybrom/DocsetMCP, dash-docs-el/helm-dash

**Key facts:**
- Bundle layout: <Name>.docset/Contents/Info.plist and <Name>.docset/Contents/Resources/docSet.dsidx (SQLite), with HTML under <Name>.docset/Contents/Resources/Documents/. The Documents tree mirrors the original site structure.
- Canonical index schema: CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT); plus CREATE UNIQUE INDEX anchor ON searchIndex (name, type, path). name is the searched label, type is one of Dash's enum strings, path is a relative path into Documents/ (may include a #anchor fragment) or an http(s):// URL.
- Apple/Xcode Core Data variant: separate tables ZTOKEN, ZTOKENNAME, ZTOKENTYPE, ZTOKENMETAINFORMATION, ZFILEPATH (and ZSEARCHINDEX). Resolve via a join, e.g. SELECT ty.ZTYPENAME, t.ZTOKENNAME, f.ZPATH, m.ZANCHOR FROM ZTOKEN t, ZTOKENTYPE ty, ZFILEPATH f, ZTOKENMETAINFORMATION m WHERE ty.Z_PK=t.ZTOKENTYPE AND f.Z_PK=m.ZFILE AND m.ZTOKEN=t.Z_PK. Path = ZPATH + optional #ZANCHOR. Detect by checking whether ZTOKEN exists vs searchIndex.
- type enum (~76+ values, normalized across languages): Annotation, Attribute, Binding, Builtin, Callback, Category, Class, Command, Component, Constant, Constructor, Define, Delegate, Diagram, Directive, Element, Entry, Enum, Environment, Error, Event, Exception, Extension, Field, File, Filter, Framework, Function, Global, Guide, Hook, Instance, Instruction, Interface, Keyword, Library, Literal, Macro, Method, Mixin, Modifier, Module, Namespace, Notation, Object, Operator, Option, Package, Parameter, Plugin, Procedure, Property, Protocol, Provider, Provisioner, Query, Record, Resource, Sample, Section, Service, Setting, Shortcut, Statement, Struct, Style, Subroutine, Tag, Test, Trait, Type, Union, Value, Variable, Word.
- Info.plist keys: CFBundleIdentifier, CFBundleName, DocSetPlatformFamily, isDashDocset (Boolean true), dashIndexFilePath (landing page), DashDocSetFamily (set to 'dashtoc' to enable in-page TOC anchors), DashDocSetFallbackURL (base URL for online redirect when a page is missing), DashDocSetPlayURL, isJavaScriptEnabled, DashDocSetDefaultFTSEnabled (turn on full-text search by default), DashDocSetFTSNotSupported (disable FTS).
- Compression: legacy compressed docsets ship tarix.tgz (a tar.gz of Documents) plus tarixIndex.db, a SQLite index mapping logical paths to byte offsets/lengths in the tar so you can extract a single file without unpacking everything. Dash 6 and newer Apple docsets instead use a cache directory of SHA-1/UUID-named files with brotli compression. Uncompressed docsets just have plain HTML in Documents/ (no tarix files).
- Full-text search: optional, gated by DashDocSetDefaultFTSEnabled in Info.plist; Dash builds SQLite FTS over the HTML, adding ~50% disk. The on-disk searchIndex still drives the primary name-based lookup. Dash internally also builds an optimizedIndex.dsidx for fast case-insensitive LIKE ranking (exact > prefix > substring), but that is an internal optimization, not part of the authored docset.
- TOC anchors: pages embed <a name="//apple_ref/<lang>/<EntryType>/<EntryName>" class="dashAnchor"></a> markers (Apple-ref style), and DashDocSetFamily='dashtoc' enables Dash to surface per-page tables of contents from them. EntryName is percent-encoded.
- Distribution/feeds: docsets are shipped as <name>.tgz (tar of the .docset, excluding .DS_Store) referenced by a small feed XML (version + download URLs). Kapeli's Dash-User-Contributions GitHub repo holds user-submitted docsets, each in its own folder with docset.json metadata and a README documenting that docset's own upstream documentation license.
- Reading is well-trodden: tools like Zeal, helm-dash/dash-docs (Emacs), DocsetMCP, and Kapeli's own dash-mcp-server all read docsets by opening the SQLite index and resolving paths into Documents/ (or extracting from tarix/Apple cache). DocsetMCP explicitly does name-based LIKE search then extracts the HTML and converts to Markdown, with in-memory caches for both Apple-cache and tarix formats.

**Gotchas:**
- Two index schemas exist. Don't assume searchIndex; Xcode/Apple docsets use the Core Data ZTOKEN/ZTOKENTYPE/ZFILEPATH tables and will appear empty to a naive searchIndex-only reader. Probe sqlite_master before querying.
- The path column is overloaded: it can be a relative file path, a relative path WITH a #anchor fragment (the anchor matters for jumping to the right symbol on a shared page), or an absolute http(s):// URL. Handle all three; don't blindly os.path.join a URL.
- Compression is not optional to support if you want full coverage: many large docsets ship only tarix.tgz/tarixIndex.db (no loose HTML), and Dash 6 / modern Apple docsets use SHA-1/UUID brotli caches. A reader that only looks in Documents/ will silently find no HTML for those.
- Info.plist may be a binary plist, not XML. Use a real plist parser, not an XML parser, or you'll fail on many docsets.
- optimizedIndex.dsidx is a Dash-internal runtime artifact, not part of the authored/distributed docset — don't depend on it being present; rely on docSet.dsidx.
- Licensing is per-docset, not repo-wide. Dash-User-Contributions has no single content license; each folder's README/docset.json carries the upstream doc license. Bulk-ingesting and especially redistributing content without checking each license is a legal risk.
- The unique index is on (name, type, path), so the same name can legitimately appear many times with different types/paths; de-dupe carefully and preserve type to keep symbol disambiguation.
- Apple-ref anchors use percent-encoded EntryName and a //apple_ref/<lang>/<type>/<name> convention; if you generate or match anchors, encode consistently or TOC jumps break.
- Feed XML and the .tgz wrapper are a distribution concern, not the on-disk format — once unpacked you work with the .docset directory directly; don't conflate the two.

**Citations:**
- [Docset Generation Guide - Create Documentation Sets for Dash (Kapeli)](https://kapeli.com/docsets)
- [Dash User Guide (Kapeli)](https://kapeli.com/dash_guide)
- [Dash 6: Now Available - Kapeli Blog](https://blog.kapeli.com/dash-6)
- [Kapeli/Dash-User-Contributions (GitHub)](https://github.com/Kapeli/Dash-User-Contributions)
- [Docset Contribution Checklist - Dash-User-Contributions Wiki](https://github.com/Kapeli/Dash-User-Contributions/wiki/Docset-Contribution-Checklist)
- [codybrom/DocsetMCP - MCP server for Dash-style docsets (GitHub)](https://github.com/codybrom/DocsetMCP)
- [Kapeli/dash-mcp-server (GitHub)](https://github.com/Kapeli/dash-mcp-server)
- [Handle "tarix" docsets? - dash-docs-el/dash-docs Issue #7](https://github.com/dash-docs-el/dash-docs/issues/7)
- [Compressed docset - zealdocs/zeal Issue #138](https://github.com/zealdocs/zeal/issues/138)
- [Generating Dash Docsets (legacy Kapeli guide mirror)](http://pythonic.zoomquiet.top/data/20121123091829/index.html)
- [xcode-docsets.md - Core Data ZTOKEN query example (gist)](https://gist.github.com/alikaragoz/4559786)

### DevDocs (freeCodeCamp/devdocs) as a documentation data source and format for version-pinned docs ingestion
**Confidence:** high  
**Summary:** DevDocs is a Ruby scraper framework plus a thin web app. Its scrapers (UrlScraper over HTTP via Typhoeus, FileScraper over local files) crawl upstream docs, run each page through an HTML::Pipeline filter chain (Nokogiri-based HTML filters then string text filters), and emit per-doc a set of normalized HTML partials plus two JSON files: index.json (searchable metadata: an `entries` array of {name, path, type} and a `types` array of {name, count, slug}) and db.json (a flat object mapping each `path` to its HTML content fragment string). A global manifest (docs.json / served as docs.json on the documents server) lists each available doc with name, slug, version, release, mtime, db_size, etc. The DevDocs *software* is MPL-2.0, but each scraped doc carries the *upstream* doc's own license; DevDocs only accepts docs whose license permits redistribution of modified versions (which is why Microsoft/MSDN, Apple, and Oracle docs are excluded). Versions are modeled as separate docs via a tilde slug convention (e.g. vue, vue~2, vue~1, node~14_lts), each with its own db.json/index.json and a `release` string. For Sackville's version-pinned use case, the format is genuinely reusable: ingest db.json+index.json directly rather than re-scraping, but reuse scraper *definitions* selectively for libraries DevDocs doesn't cover at the needed version.

**Recommendation:** Adopt a hybrid, with ingestion of DevDocs OUTPUT as the primary path and the scraper DEFINITIONS as a fallback authoring reference — do NOT run DevDocs' Ruby scraper stack as a live dependency.

1) Primary: ingest the prebuilt db.json + index.json bundles. The format is clean and directly mappable to a version-pinned index: index.json.entries gives you (name, path, type) records to index; db.json[path] gives the HTML fragment to store/chunk/embed. Resolve #anchors against the page HTML to extract the per-entry fragment. This avoids re-scraping, avoids maintaining Ruby/Nokogiri infra, and gives you DevDocs' already-normalized, attribution-stamped HTML.

2) Version pinning: map an installed dependency version to the nearest DevDocs slug using the tilde convention plus the manifest's `release` field — match major (and LTS line for node) since DevDocs tracks a small set of major versions, not every patch. Store the DevDocs `release` string alongside your records so you can show the user exactly which doc version backs an answer, and flag drift when the installed version's major doesn't have a corresponding DevDocs slug.

3) Coverage gaps / version mismatch: when DevDocs lacks the library or the pinned major version, reuse the scraper *definition* (base_urls, EntriesFilter selectors, CleanHtml rules) as a high-quality spec for your own ingester rather than copying the Ruby runtime. The selectors encode hard-won knowledge about each site's DOM. Build a small ingester that emits the SAME index.json/db.json shape so both paths converge on one internal format.

4) Licensing: treat DevDocs output as redistributable ONLY to the extent the upstream license allows, and propagate the per-doc attribution HTML into your index so it surfaces with results. Exclude Microsoft/Apple/Oracle docs from any redistributed/cached store; for those, link out or re-fetch on demand under their terms. Keep MPL-2.0 notices if you vendor any DevDocs code/definitions.

Net: ingest the output, mirror its schema as your canonical format, lean on scraper definitions only as authoring specs for gaps, and never make the live DevDocs Ruby pipeline a runtime dependency.

**Versions:**
- freeCodeCamp/devdocs: rolling main branch (no semantic release numbers; deployed continuously / Docker tag ghcr.io/freecodecamp/devdocs:latest, monthly auto-updated doc bundles) as of 2026
- License: Mozilla Public License v2.0 (MPL-2.0)
- Doc bundles versioned individually via slug~version (examples observed: vue (3.5.x), vue~2 (release 2.7.14), vue~1 (1.0.28), node~14_lts (14.17.0))
- Scraper stack: Ruby (Thor CLI tasks), Nokogiri HTML parsing, HTML::Pipeline filters, Typhoeus HTTP client

**Key facts:**
- Output format per doc: index.json + db.json. index.json = {entries:[{name,path,type}...], types:[{name,count,slug}...]}; db.json = {"<path>":"<html fragment string>"} keyed by the same path values used in index.json entries (path may include a #fragment anchor, e.g. 'operators/logical_operators#Logical_NOT').
- An 'entry' is the atomic searchable unit: a name (display/search label), a path (locator into db.json, optionally with a #anchor into a larger HTML page), and a type (category/grouping, lowercase letters only). Multiple entries can point into the same HTML page via different anchors, so entries are finer-grained than pages.
- Scraper architecture is Ruby under the Docs module in lib/docs/scrapers/. UrlScraper (HTTP, Typhoeus) and FileScraper (local filesystem) share crawl logic; pages must return 200, HTML content-type, and an effective URL within base_url(s). HTML::Pipeline applies HTML filters (ContainerFilter, CleanHtmlFilter, NormalizeUrlsFilter, InternalUrlsFilter, NormalizePathsFilter, +CleanLocalUrlsFilter for FileScraper) then text filters (InnerHtmlFilter, CleanTextFilter, AttributionFilter). Each scraper must implement an EntriesFilter (the metadata extractor) and a CleanHtml filter.
- Versioning: each library version is a SEPARATE doc with its own slug using a tilde convention (vue~2, vue~1, node~14_lts; the newest version usually takes the bare slug like vue). Each has its own db.json/index.json and a required `release` attribute (e.g. Vue 2 doc reports release 2.7.14). There is no in-file multi-version structure; versions are siblings, not nested.
- Licensing is two-tier: the scraper/app software is Mozilla Public License v2.0. Each generated doc bundle is governed by the UPSTREAM doc's own license, supplied to the scraper via the required :attribution parameter (an HTML copyright/license string appended to every page by AttributionFilter). DevDocs only ships docs whose license permits redistribution of modified versions.
- Redistribution is real and built-in: DevDocs distributes prebuilt bundles. Thor commands docs:generate (scrape), docs:package (bundle for download), docs:download (fetch prebuilt), docs:manifest (build the app's docs.json). Bundles are served from downloads.devdocs.io / documents.devdocs.io (S3: devdocs-downloads and devdocs-documents buckets). The local public/docs/docs.json manifest tracks which docs are present and is gitignored.
- Excluded vendors due to license restrictions on redistributing modified docs: Microsoft (MSDN), Apple, Oracle. These will NOT be available via DevDocs output and must be sourced independently if Sackville needs them.
- DevDocs also wishes (not strictly required by MPL) that generated doc files be attributed to DevDocs itself, in addition to the upstream attribution.

**Gotchas:**
- db.json is keyed by path; the same HTML page is shared by many entries that differ only by #anchor. You must split/locate by anchor to get per-entry fragments, or you'll over-return whole pages. Entries are finer-grained than db.json values.
- DevDocs tracks only a handful of major versions per library (e.g. vue, vue~2, vue~1), not every published patch/minor. Exact version-pin matching to an installed semver will usually only resolve at the major (or LTS) level — confirm via each doc's `release` string, which is the real version, not the slug.
- Microsoft/MSDN, Apple, and Oracle docs are intentionally absent because their licenses forbid redistributing modified versions. Any pipeline assuming full ecosystem coverage will have blind spots for .NET, Swift/Cocoa, and Java/Oracle stacks.
- Licensing is per-doc, not blanket. MPL-2.0 covers the tool only. Redistributing the scraped output legally depends on each upstream doc's license; you must carry and honor the :attribution HTML, and some seemingly-included docs may still have attribution/share-alike constraints.
- Prebuilt bundle URLs (downloads/documents.devdocs.io, S3 buckets) are infrastructure conventions that can change; they are not a versioned, stable public API contract. Pin to a self-hosted mirror (docs:download/docs:package) rather than hot-linking their S3 if you depend on availability.
- public/docs/docs.json is local state (gitignored) reflecting what's downloaded locally; don't confuse it with the canonical published manifest served from the documents host.
- The scraper definitions are Ruby + Nokogiri + HTML::Pipeline (Typhoeus for HTTP). Running them as-is pulls in a Ruby toolchain; porting selectors to another language is straightforward but the filter chain semantics (URL normalization, path rewriting) must be replicated or your db.json paths/links won't resolve consistently.
- DevDocs additionally requests attribution to DevDocs itself on generated files, separate from upstream attribution — relevant if Sackville redistributes the bundles rather than just indexing them internally.

**Citations:**
- [DevDocs Scraper Reference (architecture, filters, attribution)](https://github.com/freeCodeCamp/devdocs/blob/main/docs/scraper-reference.md)
- [DevDocs README (license MPL-2.0, redistribution rules, Thor commands)](https://github.com/freeCodeCamp/devdocs)
- [DevDocs adding-docs guide (scraper subclassing, Entries/CleanHtml filters)](https://github.com/freeCodeCamp/devdocs/blob/main/docs/adding-docs.md)
- [DevDocs maintainers guide (docs:package versions, downloads/documents servers, docs.json manifest)](https://github.com/freeCodeCamp/devdocs/blob/main/docs/maintainers.md)
- [DevDocs — Vue 2 documentation (tilde version slug example, release 2.7.14)](https://devdocs.io/vue~2/)
- [DevDocs — Node.js 14 LTS documentation (versioned slug node~14_lts)](https://devdocs.io/node~14_lts/)
- [Quick Guide to Downloading DevDocs Documentation (offline bundles, docs:download)](https://www.deskriders.dev/posts/1732621769-devdocs-offline-documentation-llm/)
- [DevDocs format for integration (issue discussing db.json/index.json reuse)](https://github.com/freeCodeCamp/devdocs/issues/133)

### 2026 Python stack for a documentation ingestion + indexing pipeline that outputs a SQLite database (FTS5 + vectors), packaged as a subprocess-invoked CLI
**Confidence:** high  
**Summary:** In 2026 the clear default Python toolchain is uv for project/dependency management and Ruff for lint+format, both from Astral. For a doc ingestion pipeline that produces a single SQLite file, the recommended shape is: fetch/read HTML, extract clean main content with trafilatura (article body + metadata) and use selectolax (lexbor backend) when you need fast surgical DOM parsing/structure (headings, code blocks, anchors). Store canonical chunks in a normal table, build an external-content FTS5 table over them for keyword search (stdlib sqlite3 supports FTS5 in all standard CPython 3.10+ builds), and store embeddings in a sqlite-vec vec0 virtual table for semantic/hybrid search. For offline, cheap, CPU-only embeddings the best default in 2026 is model2vec (potion-retrieval-32M for retrieval) — ~30MB, numpy-only, 100-500x faster than transformer encoders; fastembed (ONNX, bge-small-en-v1.5) is the step-up when you want stronger contextual quality without PyTorch. Package the tool as a console_scripts entry point so other processes can invoke it as a subprocess with clean stdout/exit codes.

**Recommendation:** Build the pipeline as a uv-managed project with a console_scripts CLI. Dependency/tooling: uv 0.11.x for project + lockfile + Python pinning; Ruff 0.15.x for lint+format. Pipeline stages: (1) Acquire HTML. (2) Extract main content with trafilatura 2.0.0 (favor_recall for docs, output text + metadata); use selectolax 0.4.10 (lexbor) to walk the DOM for structure you need to preserve — headings/anchors for deep links, fenced code blocks, tables. (3) Chunk by heading/section with overlap; store chunks in a canonical SQLite table (doc_id, url, anchor, title, heading_path, text). (4) Build an external-content FTS5 table over the canonical table with porter/unicode61 tokenizer and trigger-based sync; expose bm25() ranking. (5) Generate embeddings with model2vec 0.8.2 using potion-retrieval-32M as the default model (offline, fast, numpy-only), store them in a sqlite-vec 0.1.9 vec0 table keyed to chunk rowid. (6) Hybrid query: run FTS5 MATCH to get top-N candidates, re-rank by sqlite-vec cosine distance (or do parallel FTS + KNN and fuse with reciprocal-rank fusion). Output a single .sqlite file with WAL during build, then checkpoint/VACUUM. Default to model2vec; make the embedder pluggable so users can swap in fastembed (bge-small-en-v1.5) for higher quality. Package: pyproject.toml [project.scripts] entry point, emit machine-readable output on stdout, human logs on stderr, meaningful exit codes; ship a uv-built wheel or recommend `uv tool install` / `uvx` for subprocess callers.

**Versions:**
- uv 0.11.17 (released 2026-05-28)
- ruff 0.15.15 (released 2026-05-28)
- trafilatura 2.0.0 (released 2024-12-03)
- selectolax 0.4.10 (released 2026-05-26, lexbor backend)
- sqlite-vec 0.1.9 (released 2026-03-31)
- model2vec 0.8.2 (released 2026-05-29); recommended models potion-retrieval-32M (retrieval default), potion-base-8M (smallest/fastest), potion-multilingual-128M (multilingual)
- fastembed ~0.5.x (alternative embedder; default model BAAI/bge-small-en-v1.5, 384-dim, ONNX)
- Python 3.10+ (stdlib sqlite3 with FTS5 enabled); SQLite 3.41+ recommended for sqlite-vec
- Poetry 2.3.2 (Feb 2026) — only if you specifically need its publish workflow; otherwise prefer uv

**Key facts:**
- uv has overtaken Poetry in PyPI download volume (~75M vs ~66M monthly) and is the 2026 default for new projects: single cross-platform uv.lock, built-in Python version management, ~8s cold lockfile vs Poetry ~22s / pip-tools ~35s.
- Ruff 0.15.x is both linter and formatter (Black-compatible), configured under [tool.ruff] / [tool.ruff.lint] / [tool.ruff.format] in pyproject.toml; default line-length 88, set target-version explicitly.
- Python stdlib sqlite3 supports FTS5 out of the box in every standard CPython 3.10+ distribution (compiled with ENABLE_FTS5).
- Recommended FTS5 pattern: a normal canonical content table + an external-content FTS5 table, kept in sync with INSERT/UPDATE/DELETE triggers. External-content UPDATE/DELETE is order-sensitive (triggers must remove the OLD row values), which is why trigger-based sync is the safe approach.
- sqlite-vec (vec0 virtual tables) provides vector storage + KNN via MATCH but does NOT generate embeddings; load via sqlite_vec.load(conn) after enable_load_extension(True), insert vectors as float32 blobs (sqlite_vec.serialize_float32 or a numpy float32 array).
- model2vec produces static (uncontextualized) embeddings, ~8-30MB on disk, numpy-only dependency, up to ~500x faster on CPU than the source sentence-transformer — ideal for offline/cheap doc indexing.
- fastembed defaults to BAAI/bge-small-en-v1.5 (384-dim) via ONNX runtime, no PyTorch/GPU required — a good quality middle ground.
- selectolax with the lexbor backend is ~30x faster than BeautifulSoup and is the recommended HTML DOM parser; trafilatura is purpose-built for extracting main article content + metadata, a different job from a general parser.

**Gotchas:**
- Do NOT use a contentless (content='') FTS5 table if you need to read the original text back or rebuild — use external-content (content='your_table') so you keep canonical text and can rebuild the index. contentless-delete is a separate, more niche option.
- sqlite-vec is loaded as a runtime extension via enable_load_extension; some hardened/distro Python builds disable load_extension, and the build must allow it. Confirm at startup and fail with a clear message. It also requires SQLite 3.41+ for full feature support.
- model2vec embeddings are static/uncontextualized — great for keyword-like semantic recall and cheap indexing, but weaker than contextual models on nuanced semantic queries. For doc search the FTS5+model2vec hybrid covers this well; offer fastembed as the quality upgrade.
- trafilatura is for main-content extraction, NOT a general DOM API — for technical docs you often must combine it with selectolax to retain code blocks, tables, and heading anchors that trafilatura may strip or flatten.
- FTS5 external-content tables get out of sync if you UPDATE/DELETE the base table without the corresponding triggers (the index then references stale tokens). Add all three triggers before shipping and run 'INSERT INTO fts(fts) VALUES("rebuild")' as a recovery path.
- selectolax: use the lexbor backend explicitly (LexborHTMLParser); the older Modest backend's underlying C library is unmaintained.
- Embedding dimension must be fixed at vec0 table creation time (e.g. float[384] for bge-small, float[512] for potion-retrieval-32M) — switching models means a schema change/reindex. Record the model name+dim in a metadata table.
- When invoked as a subprocess, keep stdout pure (data/JSON only) and route progress/logs to stderr; long index builds can exceed default subprocess timeouts, so support resumable/incremental ingestion.

**Citations:**
- [Python Dependency Management in 2026 - Cuttlesoft](https://cuttlesoft.com/blog/2026/01/27/python-dependency-management-in-2026/)
- [Best Python Package Managers 2026: uv, pip, Poetry & Conda Compared - Scopir](https://scopir.com/posts/best-python-package-managers-2026/)
- [Configuring Ruff](https://docs.astral.sh/ruff/configuration/)
- [ruff · PyPI](https://pypi.org/project/ruff/)
- [uv · PyPI](https://pypi.org/project/uv/)
- [Efficient Web Scraping in Python: lxml, BeautifulSoup, and Selectolax - Medium](https://medium.com/@yahyamrafe202/in-depth-comparison-of-web-scraping-parsers-lxml-beautifulsoup-and-selectolax-4f268ddea8df)
- [selectolax · PyPI](https://pypi.org/project/selectolax/)
- [trafilatura · PyPI](https://pypi.org/project/trafilatura/)
- [Evaluation — Trafilatura 2.0.0 documentation](https://trafilatura.readthedocs.io/en/latest/evaluation.html)
- [Hybrid full-text search and vector search with SQLite - Alex Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [sqlite-vec Python documentation](https://alexgarcia.xyz/sqlite-vec/python.html)
- [sqlite-vec · PyPI](https://pypi.org/project/sqlite-vec/)
- [SQLite Python Tutorial: FTS5 and WAL [2026]](https://tech-insider.org/sqlite-python-tutorial-fts5-wal-mode-2026/)
- [GitHub - MinishLab/model2vec](https://github.com/MinishLab/model2vec)
- [Model2Vec: Distill a Small Fast Model from any Sentence Transformer - Hugging Face](https://huggingface.co/blog/Pringled/model2vec)
- [FastEmbed - Qdrant](https://qdrant.tech/documentation/fastembed/)
- [BAAI/bge-small-en-v1.5 · Hugging Face](https://huggingface.co/BAAI/bge-small-en-v1.5)

### 2026 TS monorepo toolchain spec
**Confidence:** high  
**Summary:** For a Node 22 monorepo shipping a core library, an MCP server, and a CLI, the 2026 consensus stack is pnpm workspaces (with version catalogs), Biome 2.4 as the single lint+format tool, Vitest 4.1 in projects-mode for TDD, and tsdown (Rolldown-based successor to tsup) as the bundler. Split into three publishable packages plus a private root; CLI and MCP both depend on core via the workspace protocol. Ship a normal Node bin for the CLI by default; for a single macOS binary, tsdown's @tsdown/exe wraps Node SEA, or use bun compile for smaller/faster binaries. For SQLite + sqlite-vec use better-sqlite3, because node:sqlite extension loading for sqlite-vec only works on Node 23.5+ and is not viable on Node 22. Distribute on macOS via a Homebrew tap pointing at a versioned, checksummed GitHub release tarball. Biome satisfies an opinionated, standard-like, zero-config-ish requirement, the main caveat being no plugin system.

**Recommendation:** pnpm-workspace monorepo on Node 22 with packages/core (domain logic), packages/cli, packages/mcp; adapters depend on core via workspace:*; pin shared tool versions in a pnpm catalog. Lint+format with Biome 2.4.16 (biome.json + biome check --write), dropping ESLint/Prettier. Test with Vitest 4.1 test.projects + watch mode + @vitest/coverage-v8. Build all packages with tsdown (ESM + .d.ts); give the CLI a #!/usr/bin/env node shebang so tsdown auto-emits its bin. In core use better-sqlite3 and load sqlite-vec via the sqlite-vec npm package; do not use node:sqlite for sqlite-vec on Node 22. Allowlist better-sqlite3 in pnpm onlyBuiltDependencies. Distribute on macOS via a homebrew-tap with a checksummed release-tarball Formula; default to a Node bin, building a single binary (prefer bun compile, or @tsdown/exe for pure-Node) only if Node-less/offline install is required. Use @modelcontextprotocol/sdk 1.x with stdio transport until v2 stabilizes.

**Versions:**
- Node.js 22 (LTS target)
- pnpm 11.4.0 (or 10.32+ for older Node)
- @biomejs/biome 2.4.16
- vitest 4.1.x
- @vitest/coverage-v8 4.1.7
- tsdown 0.20.3 (optional @tsdown/exe)
- better-sqlite3 (current major)
- sqlite-vec (latest npm)
- @modelcontextprotocol/sdk 1.29.0
- TypeScript 5.x (latest)

**Key facts:**
- Layout: private root + packages/core (library), packages/mcp (depends on core), packages/cli (depends on core); CLI and MCP are thin adapters; use workspace:* internal deps.
- pnpm 11.4.0 (May 2026) requires Node 22+ and is pure-ESM; pnpm 10.x is the fallback. Use pnpm-workspace.yaml with packages globs and a catalog for shared versions.
- pnpm v10+ disables dependency build scripts; better-sqlite3 must be allowlisted in onlyBuiltDependencies or its native addon won't compile.
- Biome 2.4.16 (May 27 2026): single binary lint+format, ~491 rules incl type-aware, one biome.json + biome check --write, 10-25x faster than ESLint; satisfies opinionated/zero-config-ish requirement.
- Biome gap: no plugin system, so ESLint custom/framework rules unavailable; rarely an issue for plain TS lib/CLI/MCP. biome migrate eslint is approximate.
- Vitest 4.1.x + @vitest/coverage-v8 4.1.7; monorepo key is test.projects (renamed from workspace in 3.2); V8 AST-remapped coverage; watch mode drives TDD.
- tsdown 0.20.3: Rolldown-based, ESM-first, emits ESM + .d.ts, tsup-compatible, endorsed successor (tsup unmaintained); auto-writes bin when entry has #!/usr/bin/env node shebang.
- Single-binary: @tsdown/exe wraps Node SEA (pure-Node but experimental, ~80MB); bun compile (fastest ~8ms, adds Bun); deno compile (robust, adds Deno). Default to Node bin unless offline/Node-less install needed.
- SQLite: better-sqlite3 recommended (sync, FTS5 built-in, reliable extension loading, Drizzle default). node:sqlite ships in Node 22 but sqlite-vec extension loading needs Node 23.5+, so not viable on Node 22. libsql is for Turso/edge.
- sqlite-vec loads via npm sqlite-vec: import * as sqliteVec from 'sqlite-vec'; sqliteVec.load(db) against a better-sqlite3 handle.
- Homebrew: homebrew-tap repo + Ruby Formula pulling a versioned sha256-checksummed GitHub release tarball. @modelcontextprotocol/sdk is 1.29.0 (production-recommended); breaking v2 (split server/client) anticipated Q1 2026.

**Gotchas:**
- sqlite-vec via node:sqlite needs Node 23.5.0+; on Node 22 it does not work, forcing better-sqlite3.
- pnpm 10/11 skip dependency build scripts by default; better-sqlite3 must be in onlyBuiltDependencies or it fails to load; easy to miss in CI.
- Node SEA is experimental: ESM-entry support new, mainFormat:module cannot combine with useSnapshot, binaries ~80MB; many teams transpile to CJS for SEA.
- Biome has no plugin system; custom/framework lint rules not expressible; validate required rules first.
- Vitest monorepo key is projects not workspace since 3.2; older vitest.workspace.ts examples outdated.
- pnpm 11 is pure-ESM and needs Node 22+; pin pnpm 10.x if any tooling/CI runs older Node.
- better-sqlite3 native addons are arch-specific (arm64 vs x86_64); single-binary/Homebrew artifacts must match macOS arch and bundlers won't inline the .node file.
- MCP SDK mid-transition: v1.29.x current but breaking v2 imminent; avoid coupling to v1 internals.

**Citations:**
- [pnpm Workspaces docs](https://pnpm.io/workspaces)
- [pnpm 11.0 release notes](https://pnpm.io/blog/releases/11.0)
- [Biome v2.4 release blog](https://biomejs.dev/blog/biome-v2-4/)
- [@biomejs/biome npm versions](https://www.npmjs.com/package/@biomejs/biome?activeTab=versions)
- [Biome migrate from ESLint and Prettier](https://biomejs.dev/guides/migrate-eslint-prettier/)
- [Vitest Coverage guide](https://vitest.dev/guide/coverage)
- [tsup vs tsdown vs unbuild 2026](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)
- [tsdown Executable option](https://tsdown.dev/options/exe)
- [Node SEA ESM support discussion](https://github.com/nodejs/node/issues/53565)
- [Loading sqlite-vec in Node.js](https://alexgarcia.xyz/sqlite-vec/js.html)
- [better-sqlite3 vs libsql vs sql.js 2026](https://www.pkgpulse.com/guides/better-sqlite3-vs-libsql-vs-sql-js-sqlite-nodejs-2026)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Distributing scripts via Homebrew](https://justin.searls.co/posts/how-to-distribute-your-own-scripts-via-homebrew/)

### SQLite full-text (FTS5) + vector (sqlite-vec) hybrid search for a documentation search engine, 2026
**Confidence:** high  
**Summary:** For a docs search engine, the idiomatic 2026 stack is SQLite FTS5 (built into SQLite) for keyword/BM25 search plus the sqlite-vec extension (current stable v0.1.9, with 0.1.10-alpha builds) for vector KNN, fused with Reciprocal Rank Fusion (RRF). Store the canonical document fragments in a normal SQLite table (the "content" table), index its searchable text with an FTS5 external-content table (so the full text isn't duplicated), and store embeddings in a vec0 virtual table. vec0 now supports typed metadata columns (filterable in the KNN WHERE clause), auxiliary columns (retrievable but unfilterable), and partition keys — this lets you filter a vector search by library/version directly. Hybrid ranking runs both searches with a per-method LIMIT k, then combines ranks with RRF (k≈60, equal weights to start) so a fragment that scores well in either keyword or semantic search rises to the top. The single biggest portability gotcha is that the system Python/Node SQLite on macOS (and node:sqlite) is often compiled without extension-loading support, so you must use a Homebrew/python.org Python or a SQLite built with load-extension enabled.

**Recommendation:** Use three coordinated tables. (1) A plain `docs` content table holding fragment id, title, body, symbol, type, library, version. (2) An FTS5 external-content table over the searchable text. (3) A vec0 virtual table holding the embedding plus library/version/type as filterable metadata columns and the doc id as the key. Keep FTS5 in sync with AFTER INSERT/UPDATE/DELETE triggers on `docs`. Run hybrid search as: an FTS CTE (MATCH on the query, LIMIT k, rank by bm25 via row_number), a vec CTE (MATCH embedding AND k=:k, with metadata filters like `AND library=:lib AND version=:ver` pushed down so version-scoped queries only consider relevant vectors), FULL OUTER JOIN them on doc id, score with RRF (rrf_k=60, weights 1.0/1.0 to start), join back to `docs` for display fields, and use snippet()/highlight() from the FTS table for excerpts. For 'idiomatic way to do X in library Y version Z': require the version filter on BOTH halves (FTS WHERE + a join filter, and vec metadata WHERE), then bias weight_vec slightly higher than weight_fts (e.g. 1.0 vec / 0.8 fts) since 'how do I' phrasing is semantic, and apply a recency/version tiebreak. DDL sketch below.

Schema (DDL sketch):
```sql
-- 1. canonical fragments
CREATE TABLE docs(
  id INTEGER PRIMARY KEY,
  title TEXT, body TEXT,
  symbol TEXT, type TEXT,        -- e.g. 'useState', 'function|class|guide'
  library TEXT, version TEXT,    -- e.g. 'react', '19.0'
  url TEXT
);

-- 2. FTS5 external-content index (no body duplication; supports snippet/highlight)
CREATE VIRTUAL TABLE docs_fts USING fts5(
  title, body, symbol,               -- searchable columns
  library UNINDEXED, version UNINDEXED,
  content='docs', content_rowid='id',
  tokenize='porter unicode61',       -- stemmed prose; add a trigram mirror for code if needed
  prefix='2 3'
);
-- keep in sync
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid,title,body,symbol,library,version)
  VALUES(new.id,new.title,new.body,new.symbol,new.library,new.version);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts,rowid,title,body,symbol,library,version)
  VALUES('delete',old.id,old.title,old.body,old.symbol,old.library,old.version);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts,rowid,title,body,symbol,library,version)
  VALUES('delete',old.id,old.title,old.body,old.symbol,old.library,old.version);
  INSERT INTO docs_fts(rowid,title,body,symbol,library,version)
  VALUES(new.id,new.title,new.body,new.symbol,new.library,new.version);
END;
-- optional: a trigram mirror for exact code/identifier substring search
-- CREATE VIRTUAL TABLE docs_code USING fts5(symbol, body, content='docs',
--   content_rowid='id', tokenize='trigram', detail='full');

-- 3. vectors with pushdown filters
CREATE VIRTUAL TABLE docs_vec USING vec0(
  doc_id INTEGER PRIMARY KEY,
  library TEXT,                       -- metadata: filterable in KNN
  version TEXT,                       -- metadata: filterable in KNN
  type TEXT,                          -- metadata: filterable in KNN
  embedding float[768] distance_metric=cosine,
  +title TEXT                         -- auxiliary: returned, not filtered
);
```

Hybrid query (RRF):
```sql
WITH fts AS (
  SELECT rowid AS id, row_number() OVER (ORDER BY rank) AS r
  FROM docs_fts
  WHERE docs_fts MATCH :q AND library=:lib AND version=:ver
  LIMIT :k
),
vec AS (
  SELECT doc_id AS id, row_number() OVER (ORDER BY distance) AS r
  FROM docs_vec
  WHERE embedding MATCH :qvec AND k=:k
    AND library=:lib AND version=:ver
)
SELECT d.id, d.title, d.url,
       snippet(docs_fts,1,'<b>','</b>','…',12) AS excerpt,
       coalesce(1.0/(60+fts.r),0)*0.8
     + coalesce(1.0/(60+vec.r),0)*1.0 AS score
FROM fts FULL OUTER JOIN vec USING(id)
JOIN docs d ON d.id = coalesce(fts.id, vec.id)
ORDER BY score DESC
LIMIT 20;
```
(snippet() works because docs_fts is external-content and can read body from docs.)

**Versions:**
- sqlite-vec 0.1.9 (stable, 2026-03-31); 0.1.10-alpha.1/.2/.3 available
- sqlite-vec npm package: sqlite-vec (matches 0.1.x)
- sqlite-vec PyPI package: sqlite-vec (matches 0.1.x)
- SQLite FTS5: bundled with SQLite 3.x (no separate version; enabled in standard builds)
- node:sqlite built-in module requires Node.js >= 23.5.0 and allowExtension:true to load extensions
- better-sqlite3 (Node) bundles its own extension-capable SQLite — recommended for portability

**Key facts:**
- FTS5 is bundled with SQLite (no separate install); it is the keyword/BM25 half of the system. bm25() returns a value where smaller (more negative) = better match, so you ORDER BY rank/bm25() ascending.
- External-content FTS5 tables (content='docs', content_rowid='id') store only the inverted index and read column values from your real table on demand — best choice for docs because the body text is large and you don't want to duplicate it. You must keep them in sync via triggers (or rebuild with insert into fts(fts) values('rebuild')).
- Contentless tables (content='') store only the index and cannot return original column values or do UPDATE/DELETE — use only if you never need snippet()/highlight() to read original text. For an excerpt-producing docs engine, external-content is the better fit since snippet()/highlight() need the source text.
- Tokenizers: unicode61 (default, good general multilingual word search), porter (stemming wrapper over unicode61 so 'running' matches 'run' — good for prose body), trigram (substring/LIKE-style and code-identifier matching, supports matching inside tokens; needs detail='full'). You can stack them, e.g. tokenize='porter unicode61'.
- snippet(tbl, colidx, '<b>', '</b>', '...', tokens) and highlight(tbl, colidx, '<b>','</b>') produce result excerpts with matched terms wrapped — colidx is per-column, use -1/auto for snippet to pick best column.
- Prefix indexes: declare prefix='2 3' in the FTS5 table to make prefix queries like 'config*' fast.
- sqlite-vec current stable is v0.1.9 (2026-03-31); 0.1.10-alpha builds exist. Pure C, no deps, runs anywhere SQLite runs including WASM.
- vec0 virtual table stores vectors as float[N] (also supports bit[N] and int8[N] for quantization). KNN query uses: WHERE embedding MATCH :query AND k = :k ORDER BY distance. distance_metric=cosine|L2|L1 selectable (L2 default).
- vec0 supports up to 16 metadata columns (TEXT/INTEGER/FLOAT/BOOLEAN) that are filterable inside the KNN WHERE clause (e.g. AND library='react' AND version='19'), up to 4 partition key columns, and up to 16 auxiliary columns (prefixed with +) that are retrievable but NOT filterable — good for storing large blobs/text alongside the vector.
- RRF hybrid query: run FTS and vec each in a CTE with row_number() over (order by score/distance) as rank, FULL OUTER JOIN on the shared id, combined = coalesce(1.0/(rrf_k+fts_rank),0)*w_fts + coalesce(1.0/(rrf_k+vec_rank),0)*w_vec, ORDER BY combined DESC. Typical rrf_k=60, weights=1.0.
- Node loading: npm i sqlite-vec, then import * as sqliteVec from 'sqlite-vec'; sqliteVec.load(db) with better-sqlite3, or with node:sqlite (23.5.0+) use new DatabaseSync(path,{allowExtension:true}).
- Python loading: pip install sqlite-vec; db.enable_load_extension(True); sqlite_vec.load(db); db.enable_load_extension(False). Use sqlite_vec.serialize_float32(list) (or numpy .astype(np.float32)) to bind vectors as the compact binary format.

**Gotchas:**
- macOS portability: system Python's sqlite3 and node:sqlite are frequently compiled with OMIT_LOAD_EXTENSION / without enable_load_extension, so sqlite-vec won't load. Fix by using Homebrew or python.org Python (which link a SQLite built with extension loading), or better-sqlite3 (bundles its own SQLite) on Node. This is the #1 cross-platform footgun.
- snippet()/highlight() require the original text to be readable — works with external-content tables (reads from docs) but NOT with truly contentless (content='') tables. Don't pick contentless if you need excerpts.
- External-content FTS5 does not auto-sync — you MUST add INSERT/UPDATE/DELETE triggers (using the 'delete' command form with the OLD row values) or the index drifts out of sync and corrupts results. Run 'optimize'/'rebuild' periodically.
- bm25()/rank is ascending-better (smaller is better); RRF needs the row_number ordered by rank ASC. Mixing up sort direction silently inverts relevance.
- vec0 metadata columns are limited (16 metadata / 4 partition / 16 auxiliary) and metadata filters support only =,!=,<,<=,>,>= (boolean only =/!=). Plan library/version/type as metadata; keep large text as auxiliary (+col) or join back to docs.
- KNN in vec0 needs both `MATCH` and `AND k=:k` (or LIMIT) or it errors / does a full scan. The k binding is how vec0 knows how many neighbors to return.
- trigram tokenizer needs detail='full' and is heavier on storage; use it as a separate mirror table for code-identifier substring search rather than the main prose index. porter stemming can over-stem code tokens, which is another reason to separate code vs prose indexes.
- RRF weights and rrf_k=60 are starting points, not tuned values — for version-specific 'how to' queries, push the version filter on BOTH FTS and vec halves or stale-version fragments leak in via whichever half lacks the filter.
- sqlite-vec is pre-1.0 (v0.1.9); the vec0 on-disk format and APIs can still change between minor versions — pin the version and re-test embeddings/index after upgrades. Quantization (bit[]/int8[]) trades recall for size/speed.

**Citations:**
- [Hybrid full-text search and vector search with SQLite — Alex Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [sqlite-vec GitHub (releases / README)](https://github.com/asg017/sqlite-vec)
- [sqlite-vec vec0 virtual table features](https://alexgarcia.xyz/sqlite-vec/features/vec0.html)
- [sqlite-vec KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html)
- [Using sqlite-vec in Python — Alex Garcia](https://alexgarcia.xyz/sqlite-vec/python.html)
- [Using sqlite-vec in JavaScript/Node — Alex Garcia](https://alexgarcia.xyz/sqlite-vec/js.html)
- [SQLite FTS5 Extension (official docs)](https://sqlite.org/fts5.html)
- [Loading SQLite extensions in Python on macOS — Simon Willison](https://til.simonwillison.net/sqlite/sqlite-extensions-python-macos)
- [Hybrid full-text search and vector search with SQLite — Simon Willison](https://simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite/)
