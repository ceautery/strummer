"""HTML chunking — split a documentation page into heading-bounded sections.

:func:`split_sections` walks a parsed HTML body in document order. Every
``<h1>``/``<h2>``/``<h3>`` starts a new :class:`~strummer_ingest.model.Section`;
the content elements between headings accumulate into the current section's
body text. Code-block text (``<pre>``/``<code>``) is preserved.
"""

from __future__ import annotations

import re

from selectolax.lexbor import LexborHTMLParser, LexborNode

from strummer_ingest.model import Section

_HEADING_LEVELS = {"h1": 1, "h2": 2, "h3": 3}
_WS_RE = re.compile(r"\s+")


def _collapse(text: str) -> str:
    """Collapse runs of whitespace to single spaces and strip the ends."""
    return _WS_RE.sub(" ", text).strip()


def _node_text(node: LexborNode) -> str:
    """Visible text of a node, including code blocks, whitespace-collapsed.

    In-heading icon links carry an SVG and no visible label, so they
    contribute nothing once whitespace is collapsed.
    """
    return _collapse(node.text(deep=True, separator=" ", strip=False))


def split_sections(html: str) -> list[Section]:
    """Split *html* into sections at ``<h1>``/``<h2>``/``<h3>`` boundaries.

    Sections are returned in document order. A section is skipped only when
    both its heading and body text are empty.
    """
    tree = LexborHTMLParser(html)
    body = tree.body
    sections: list[Section] = []
    if body is None:
        return sections

    level: int | None = None
    heading = ""
    anchor: str | None = None
    parts: list[str] = []
    started = False

    def finalize() -> None:
        text = _collapse(" ".join(parts))
        if not heading and not text:
            return
        sections.append(
            Section(
                level=level if level is not None else 1,
                heading=heading,
                anchor=anchor,
                text=text,
            )
        )

    for node in body.iter():
        node_level = _HEADING_LEVELS.get(node.tag or "")
        if node_level is not None:
            if started:
                finalize()
            level = node_level
            heading = _node_text(node)
            anchor = node.attributes.get("id")
            parts = []
            started = True
        else:
            chunk = _node_text(node)
            if chunk:
                parts.append(chunk)

    if started:
        finalize()

    return sections
