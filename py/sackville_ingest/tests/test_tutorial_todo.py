"""Guard for the onboarding tutorial's bundled docset (ADR 0020).

Proves the tutorial's offline ingest command actually builds a searchable index
from the hand-authored `examples/tutorial/todo/docs/todo-core` DevDocs pair.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from sackville_ingest.cli import main

DOCSET = (
    Path(__file__).resolve().parents[3] / "examples" / "tutorial" / "todo" / "docs" / "todo-core"
)


def test_tutorial_docset_ingests_offline(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "todo-core.sqlite"
    code = main(
        [
            "build",
            "--index",
            str(DOCSET / "index.json"),
            "--db",
            str(DOCSET / "db.json"),
            "--library",
            "todo-core",
            "--version",
            "0.1.0",
            "--home",
            "https://example.com/todo-core/",
            "--embedder",
            "fake",
            "--out",
            str(out),
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["library"] == "todo-core"
    assert payload["docs"] >= 3
    assert out.exists()

    conn = sqlite3.connect(out)
    try:
        # The semantics page the tutorial searches for is findable via FTS.
        (rowid,) = conn.execute(
            "SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'active' LIMIT 1"
        ).fetchone()
        (body,) = conn.execute("SELECT body FROM docs WHERE id = ?", (rowid,)).fetchone()
        assert "active" in body.lower()
    finally:
        conn.close()
