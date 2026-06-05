"""Tests for the index builder using the deterministic FakeEmbedder."""

from __future__ import annotations

import sqlite3

import sqlite_vec

from sackville_ingest.build import build_index
from sackville_ingest.db import EMBED_DIM
from sackville_ingest.embed import FakeEmbedder
from sackville_ingest.model import Fragment


def _open(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def _fragments() -> list[Fragment]:
    return [
        Fragment(
            library="react",
            version="19.2",
            title="useState",
            body="useState lets you add a state variable to your component.",
            symbol="useState",
            type="hook",
            heading_path="useState",
            url="https://react.dev/reference/react/useState",
            attribution="CC-BY-4.0",
        ),
        Fragment(
            library="react",
            version="19.2",
            title="useEffect",
            body="useEffect lets you synchronize a component with an external system.",
            symbol="useEffect",
            type="hook",
        ),
    ]


def test_build_index_persists_docs_fts_and_vectors(tmp_path):
    out = tmp_path / "react.sqlite"
    count = build_index(_fragments(), FakeEmbedder(), out)
    assert count == 2

    conn = _open(str(out))
    assert conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM docs_vec").fetchone()[0] == 2

    # FTS finds the hook, and ids stay aligned across docs/fts/vec.
    (doc_id, symbol) = conn.execute(
        "SELECT d.id, d.symbol FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid "
        "WHERE docs_fts MATCH 'synchronize'"
    ).fetchone()
    assert symbol == "useEffect"
    assert (
        conn.execute("SELECT COUNT(*) FROM docs_vec WHERE doc_id = ?", (doc_id,)).fetchone()[0] == 1
    )
    conn.close()


def test_build_index_rejects_dim_mismatch(tmp_path):
    import pytest

    with pytest.raises(ValueError, match="embed_dim"):
        build_index(_fragments(), FakeEmbedder(dim=EMBED_DIM + 1), tmp_path / "bad.sqlite")


def _frag(version: str, title: str) -> Fragment:
    return Fragment(
        library="react", version=version, title=title, body=f"{title} body text", type="hook"
    )


def test_append_adds_another_version_to_one_index(tmp_path):
    out = tmp_path / "react.sqlite"
    build_index([_frag("19.2", "useState")], FakeEmbedder(), out)
    build_index([_frag("18.3.1", "useState")], FakeEmbedder(), out, append=True)

    conn = _open(str(out))
    versions = {v for (v,) in conn.execute("SELECT DISTINCT version FROM docs").fetchall()}
    assert versions == {"19.2", "18.3.1"}
    assert conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM docs_vec").fetchone()[0] == 2
    # meta seeded exactly once.
    assert (
        conn.execute("SELECT COUNT(*) FROM sackville_meta WHERE key='schema_version'").fetchone()[0]
        == 1
    )
    conn.close()
