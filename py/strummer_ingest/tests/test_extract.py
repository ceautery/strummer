"""Tests for the HTML section splitter."""

from __future__ import annotations

import json
from pathlib import Path

from strummer_ingest.extract import split_sections, symbol_from_heading

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


TOC_HTML = """
<h1>Widget</h1>
<ul>
  <li><a href="#usage">Usage</a></li>
  <li><a href="#api-reference">API reference</a></li>
</ul>
<p>A widget does things.</p>
<h2 id="usage">Usage</h2>
<p>Use it like so.</p>
"""


def test_strips_on_page_toc_from_first_section() -> None:
    sections = split_sections(TOC_HTML)
    intro = sections[0]
    assert intro.heading == "Widget"
    assert "A widget does things." in intro.text
    # The on-page table-of-contents link labels must not bleed into the body.
    assert "Usage" not in intro.text
    assert "API reference" not in intro.text


def test_keeps_content_lists_that_are_not_toc() -> None:
    html = (
        "<h1>List</h1><ul><li>first item</li><li>second item</li></ul>"
        '<p>see <a href="https://x/">elsewhere</a></p>'
    )
    sections = split_sections(html)
    assert "first item" in sections[0].text
    assert "second item" in sections[0].text


def test_symbol_from_heading() -> None:
    assert symbol_from_heading("useState(initialState)") == "useState"
    assert symbol_from_heading("ReactDOM.render(element, container)") == "ReactDOM.render"
    assert symbol_from_heading("flushSync(callback) ") == "flushSync"
    # Prose headings are not symbols.
    assert symbol_from_heading("Usage") is None
    assert symbol_from_heading("Adding state to a component") is None


def test_devdocs_react_usestate() -> None:
    db_path = Path(__file__).parent / "data" / "devdocs_react" / "db.json"
    db = json.loads(db_path.read_text())
    html = db["reference/react/usestate"]

    sections = split_sections(html)
    assert len(sections) >= 2
    assert sections[0].heading == "useState"
    assert "state variable" in sections[0].text
    assert any(s.anchor == "reference" for s in sections)
