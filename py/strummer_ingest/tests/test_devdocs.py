"""Tests for the DevDocs source adapter against the hermetic React sample."""

from __future__ import annotations

import json
from pathlib import Path

from strummer_ingest.devdocs import iter_fragments

DATA = Path(__file__).parent / "data" / "devdocs_react"


def _load_fragments():
    index = json.loads((DATA / "index.json").read_text())
    db = json.loads((DATA / "db.json").read_text())
    return list(
        iter_fragments(
            index,
            db,
            library="react",
            version="19.2",
            home="https://react.dev/",
            attribution="© Facebook, CC-BY-4.0",
        )
    )


def test_yields_fragments_with_core_fields():
    frags = _load_fragments()
    assert frags, "expected at least one fragment"
    for f in frags:
        assert f.library == "react"
        assert f.version == "19.2"
        assert f.body.strip()
        assert f.attribution == "© Facebook, CC-BY-4.0"


def test_usestate_fragment_is_a_hook_with_recovered_url():
    frags = _load_fragments()
    intro = next(f for f in frags if f.symbol == "useState" and "state variable" in f.body)
    assert intro.type == "hook"
    assert intro.title == "useState"
    # DevDocs lowercases paths; the adapter recovers the entry's casing.
    assert intro.url == "https://react.dev/reference/react/useState"


def test_symbol_derived_from_signature_heading_without_entry():
    # The h3 signature section has no DevDocs entry of its own; the symbol is
    # recovered from the heading's call signature.
    index = {"entries": [{"name": "Thing", "path": "api/thing", "type": "class"}]}
    db = {
        "api/thing": (
            "<h1>Thing</h1><p>A thing.</p>"
            '<h2 id="methods">Methods</h2>'
            '<h3 id="render">render(props)</h3><p>Renders the thing.</p>'
        )
    }
    frags = list(
        iter_fragments(index, db, library="x", version="1", home="https://e/", attribution="a")
    )
    render = next(f for f in frags if "Renders the thing." in f.body)
    assert render.symbol == "render"


def test_learn_page_is_a_guide():
    frags = _load_fragments()
    guide = [f for f in frags if f.url and "state-a-components-memory" in f.url]
    assert guide
    assert all(f.type == "guide" for f in guide)
