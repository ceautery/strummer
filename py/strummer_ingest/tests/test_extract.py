"""Tests for the HTML section splitter."""

from __future__ import annotations

import json
from pathlib import Path

from strummer_ingest.extract import split_sections

INLINE_HTML = """
<h1>Widget<a href="#undefined" aria-label="Link"><svg><path d="M0 0"></path></svg></a></h1>
<div>
<p>A widget is a thing you can use.</p>
</div>
<h2 id="usage">Usage <a href="#usage" aria-label="Link"><svg><path d="M0 0"></path></svg></a></h2>
<pre data-language="py"><code>w = Widget(name="x")</code></pre>
"""


def test_inline_two_sections() -> None:
    sections = split_sections(INLINE_HTML)
    assert len(sections) == 2

    assert sections[0].level == 1
    assert sections[0].heading == "Widget"
    assert sections[0].anchor is None
    assert "A widget is a thing you can use." in sections[0].text

    assert sections[1].level == 2
    assert sections[1].heading == "Usage"
    assert sections[1].anchor == "usage"
    # code block text must be preserved
    assert 'w = Widget(name="x")' in sections[1].text


def test_devdocs_react_usestate() -> None:
    db_path = Path(__file__).parent / "data" / "devdocs_react" / "db.json"
    db = json.loads(db_path.read_text())
    html = db["reference/react/usestate"]

    sections = split_sections(html)
    assert len(sections) >= 2
    assert sections[0].heading == "useState"
    assert "state variable" in sections[0].text
    assert any(s.anchor == "reference" for s in sections)
