"""End-to-end CLI tests for `strummer-ingest build` source wiring."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from strummer_ingest.cli import main


def _make_docset(root: Path) -> Path:
    docset = root / "Widget.docset"
    documents = docset / "Contents" / "Resources" / "Documents"
    documents.mkdir(parents=True)
    (documents / "widget.html").write_text(
        "<h1>Widget</h1><p>A widget you can use.</p>"
        '<h2 id="render">render(opts)</h2><p>Renders it.</p>'
    )
    (documents / "guide.html").write_text("<h1>Getting Started</h1><p>Install it first.</p>")
    conn = sqlite3.connect(docset / "Contents" / "Resources" / "docSet.dsidx")
    conn.execute(
        "CREATE TABLE searchIndex(id INTEGER PRIMARY KEY, name TEXT, type TEXT, path TEXT)"
    )
    conn.executemany(
        "INSERT INTO searchIndex(name, type, path) VALUES (?, ?, ?)",
        [
            ("Widget", "Class", "widget.html"),
            ("render", "Method", "widget.html#render"),
            ("Getting Started", "Guide", "guide.html"),
        ],
    )
    conn.commit()
    conn.close()
    return docset


def test_build_from_docset(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    docset = _make_docset(tmp_path)
    out = tmp_path / "widget.sqlite"
    code = main(
        [
            "build",
            "--docset",
            str(docset),
            "--library",
            "widget",
            "--version",
            "1.0",
            "--home",
            "https://widget.dev/",
            "--attribution",
            "© Widget",
            "--embedder",
            "fake",
            "--out",
            str(out),
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is True
    assert payload["library"] == "widget"
    assert payload["docs"] == 3
    assert out.exists()

    rows = sqlite3.connect(out).execute("SELECT count(*) FROM docs").fetchone()
    assert rows[0] == 3
