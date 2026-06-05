"""Shared data model — the contract between ingestion pipeline stages.

A source adapter yields :class:`Fragment` records; the index writer persists
them. :class:`Section` is the intermediate unit produced by HTML chunking.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Section:
    """A chunk of a documentation page, split at a heading boundary."""

    level: int  # heading level: 1 (page title), 2, or 3
    heading: str  # cleaned heading text, e.g. "useState(initialState)"
    anchor: str | None  # heading id used for the URL fragment + entry matching
    text: str  # cleaned body text of this section (code blocks preserved)


@dataclass(frozen=True)
class Fragment:
    """A canonical, indexable documentation fragment (one `docs` row)."""

    library: str
    version: str
    title: str
    body: str
    symbol: str | None = None
    type: str | None = None
    heading_path: str | None = None
    url: str | None = None
    attribution: str | None = None
