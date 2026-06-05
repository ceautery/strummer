-- Sackville index schema — THE CONTRACT between the Python ingester (writer)
-- and the TypeScript core (reader). Keep schema/sackville.schema.json in sync;
-- both sides assert sackville_meta.schema_version before operating.
--
-- Invariants (tested on both sides):
--   * sackville_meta.embed_dim == the float[N] in docs_vec below
--   * docs.id == docs_fts.rowid == docs_vec.doc_id
--   * the FTS sync triggers below exist (no manual FTS writes)

-- Contract / version guard. Seeded by the ingester with:
--   schema_version, embed_model, embed_dim, built_at, builder_version
CREATE TABLE sackville_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Canonical documentation fragments (source of truth for body text).
CREATE TABLE docs (
  id           INTEGER PRIMARY KEY,
  library      TEXT NOT NULL,   -- e.g. 'react'
  version      TEXT NOT NULL,   -- pinned doc release, e.g. '19.0'
  title        TEXT NOT NULL,
  symbol       TEXT,            -- e.g. 'useState'
  type         TEXT,            -- normalized taxonomy: function|class|guide|...
  heading_path TEXT,            -- e.g. 'Hooks > useState'
  url          TEXT,            -- upstream URL (#anchor preserved)
  attribution  TEXT,            -- upstream license/attribution (compliance)
  body         TEXT NOT NULL    -- cleaned fragment text (snippets + embeddings)
);
CREATE INDEX docs_libver ON docs (library, version);

-- Full-text search, external-content over docs (no body duplication).
CREATE VIRTUAL TABLE docs_fts USING fts5 (
  title,
  body,
  symbol,
  library UNINDEXED,
  version UNINDEXED,
  content='docs',
  content_rowid='id',
  tokenize='porter unicode61',
  prefix='2 3'
);

-- Keep docs_fts in sync with docs automatically.
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts (rowid, title, body, symbol, library, version)
  VALUES (new.id, new.title, new.body, new.symbol, new.library, new.version);
END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts (docs_fts, rowid, title, body, symbol, library, version)
  VALUES ('delete', old.id, old.title, old.body, old.symbol, old.library, old.version);
END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts (docs_fts, rowid, title, body, symbol, library, version)
  VALUES ('delete', old.id, old.title, old.body, old.symbol, old.library, old.version);
  INSERT INTO docs_fts (rowid, title, body, symbol, library, version)
  VALUES (new.id, new.title, new.body, new.symbol, new.library, new.version);
END;

-- Vector index for semantic search. The float[N] dimension is a CONTRACT
-- constant and MUST equal sackville_meta.embed_dim (384 for bge-small-en-v1.5).
-- library/version/type are pushdown filter columns for KNN queries.
CREATE VIRTUAL TABLE docs_vec USING vec0 (
  doc_id    INTEGER PRIMARY KEY,
  library   TEXT,
  version   TEXT,
  type      TEXT,
  embedding float[384] distance_metric=cosine
);
