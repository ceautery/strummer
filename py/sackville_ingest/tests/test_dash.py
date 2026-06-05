"""Tests for the Dash docset source adapter against a synthetic docset."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from sackville_ingest.dash import iter_fragments
from sackville_ingest.types_map import normalize_dash_type


def _make_docset(root: Path) -> Path:
    docset = root / "Widget.docset"
    resources = docset / "Contents" / "Resources"
    documents = resources / "Documents"
    documents.mkdir(parents=True)
    (documents / "widget.html").write_text(
        "<h1>Widget</h1><p>A widget you can use.</p>"
        '<h2 id="render">render(opts)</h2><p>Renders it.</p>'
    )
    (documents / "guide.html").write_text(
        "<h1>Getting Started</h1><p>Install the widget first.</p>"
    )
    conn = sqlite3.connect(resources / "docSet.dsidx")
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


def test_iter_fragments_from_docset(tmp_path: Path) -> None:
    frags = list(
        iter_fragments(
            _make_docset(tmp_path),
            library="widget",
            version="1.0",
            home="https://widget.dev/",
            attribution="© Widget",
        )
    )
    assert frags
    for f in frags:
        assert f.library == "widget"
        assert f.version == "1.0"
        assert f.body.strip()
        assert f.attribution == "© Widget"

    # Class page: type + symbol from the page entry, URL built from home + path.
    widget = next(f for f in frags if f.title == "Widget")
    assert widget.type == "class"
    assert widget.symbol == "Widget"
    assert widget.url == "https://widget.dev/widget.html"

    # Method section matched by its HTML anchor.
    render = next(f for f in frags if "Renders it." in f.body)
    assert render.type == "method"
    assert render.symbol == "render"
    assert render.url == "https://widget.dev/widget.html#render"

    # Guide page.
    guide = next(f for f in frags if "Install the widget first." in f.body)
    assert guide.type == "guide"


def test_no_home_yields_no_url(tmp_path: Path) -> None:
    frags = list(
        iter_fragments(
            _make_docset(tmp_path), library="widget", version="1.0", home="", attribution=""
        )
    )
    assert all(f.url is None for f in frags)


def test_missing_searchindex_raises(tmp_path: Path) -> None:
    docset = tmp_path / "Empty.docset"
    resources = docset / "Contents" / "Resources"
    resources.mkdir(parents=True)
    sqlite3.connect(resources / "docSet.dsidx").close()  # db with no searchIndex table
    with pytest.raises(ValueError, match="searchIndex"):
        list(iter_fragments(docset, library="x", version="1", home="", attribution=""))


def test_normalize_dash_type() -> None:
    assert normalize_dash_type("Function") == "function"
    assert normalize_dash_type("Constructor") == "function"
    assert normalize_dash_type("Method") == "method"
    assert normalize_dash_type("Class") == "class"
    assert normalize_dash_type("Interface") == "class"
    assert normalize_dash_type("Guide") == "guide"
    assert normalize_dash_type("Component") == "component"
    assert normalize_dash_type("Constant") == "reference"
    assert normalize_dash_type("") == "reference"
