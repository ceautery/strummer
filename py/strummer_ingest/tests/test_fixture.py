"""Python-side contract tests: the index we write matches the schema invariants."""

from __future__ import annotations

import sqlite3
import struct

import sqlite_vec

from strummer_ingest.db import EMBED_DIM, EMBED_MODEL, SCHEMA_VERSION
from strummer_ingest.fixture import build_golden_fixture


def _open(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def test_fixture_seeds_meta(tmp_path) -> None:
    out = tmp_path / "golden.sqlite"
    assert build_golden_fixture(out) == 1
    conn = _open(str(out))
    meta = dict(conn.execute("SELECT key, value FROM strummer_meta").fetchall())
    assert meta["schema_version"] == str(SCHEMA_VERSION)
    assert meta["embed_model"] == EMBED_MODEL
    assert meta["embed_dim"] == str(EMBED_DIM)
    conn.close()


def test_fixture_has_aligned_ids_across_tables(tmp_path) -> None:
    out = tmp_path / "golden.sqlite"
    build_golden_fixture(out)
    conn = _open(str(out))

    (doc_id, symbol, version) = conn.execute(
        "SELECT id, symbol, version FROM docs WHERE library = 'react'"
    ).fetchone()
    assert symbol == "useState"
    assert version == "19.0"

    # FTS rowid and the canonical id agree.
    (fts_rowid,) = conn.execute(
        "SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'useState'"
    ).fetchone()
    assert fts_rowid == doc_id

    # The vector row exists with the right dimension.
    (blob,) = conn.execute("SELECT embedding FROM docs_vec WHERE doc_id = ?", (doc_id,)).fetchone()
    assert len(struct.unpack(f"{EMBED_DIM}f", blob)) == EMBED_DIM

    conn.close()
