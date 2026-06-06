"""Guard for the level-3 onboarding tutorial's bundled docset (ADR 0020 addendum 2).

Proves the tutorial's offline ingest command actually builds a searchable index
from the hand-authored `examples/tutorial/storefront/docs/storefront-core`
DevDocs pair — so the `search` step in the README finds the contract semantics.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from sackville_ingest.cli import main

DOCSET = (
    Path(__file__).resolve().parents[3]
    / "examples"
    / "tutorial"
    / "storefront"
    / "docs"
    / "storefront-core"
)


def test_tutorial_storefront_docset_ingests_offline(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out = tmp_path / "storefront-core.sqlite"
    code = main(
        [
            "build",
            "--index",
            str(DOCSET / "index.json"),
            "--db",
            str(DOCSET / "db.json"),
            "--library",
            "storefront-core",
            "--version",
            "1.0.0",
            "--home",
            "https://example.com/storefront-core/",
            "--embedder",
            "fake",
            "--out",
            str(out),
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["library"] == "storefront-core"
    assert payload["docs"] >= 3
    assert out.exists()

    conn = sqlite3.connect(out)
    try:
        # The page documenting that `balance` is an integer (cents) is findable.
        (rowid,) = conn.execute(
            "SELECT rowid FROM docs_fts WHERE docs_fts MATCH 'balance' LIMIT 1"
        ).fetchone()
        (body,) = conn.execute("SELECT body FROM docs WHERE id = ?", (rowid,)).fetchone()
        assert "balance" in body.lower()
    finally:
        conn.close()
