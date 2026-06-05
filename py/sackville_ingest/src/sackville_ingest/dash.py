"""Dash docset source adapter.

A Dash docset is a bundle: ``<Name>.docset/Contents/Resources/docSet.dsidx``
(a SQLite ``searchIndex`` of name/type/path entries) plus the page HTML under
``Contents/Resources/Documents/``. This adapter reads the index, chunks each
referenced page into heading sections (reusing :func:`split_sections`), attaches
the matching entry's name/type, and yields normalized :class:`Fragment` records
— mirroring the DevDocs adapter.

Scope: the user-contributed ``searchIndex`` schema. The legacy Core Data schema
(``ZTOKEN`` tables) is not yet supported.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

from .extract import split_sections, symbol_from_heading
from .model import Fragment
from .types_map import normalize_dash_type

# Types whose entry name is a code symbol worth recording.
_SYMBOL_TYPES = {"hook", "component", "api", "directive", "function", "class", "method"}


def _resolve(docset: Path) -> tuple[Path, Path]:
    """Locate (docSet.dsidx, Documents/) given a docset bundle or its Resources dir."""
    for base in (docset / "Contents" / "Resources", docset):
        dsidx = base / "docSet.dsidx"
        if dsidx.exists():
            return dsidx, base / "Documents"
    raise FileNotFoundError(f"no docSet.dsidx found under {docset}")


def _read_index(dsidx: Path) -> list[dict]:
    """Read the docset's searchIndex into entry dicts (page + anchor split out)."""
    conn = sqlite3.connect(f"file:{dsidx}?mode=ro", uri=True)
    try:
        tables = {
            row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "searchIndex" not in tables:
            raise ValueError(
                f"{dsidx}: no 'searchIndex' table — Core Data docsets are not yet supported"
            )
        rows = conn.execute("SELECT name, type, path FROM searchIndex").fetchall()
    finally:
        conn.close()

    entries: list[dict] = []
    for name, dtype, path in rows:
        if not path:
            continue
        page, _, anchor = path.partition("#")
        entries.append({"name": name, "type": dtype, "page": page, "anchor": anchor or None})
    return entries


def iter_fragments(
    docset: Path | str,
    *,
    library: str,
    version: str,
    home: str,
    attribution: str,
) -> Iterator[Fragment]:
    """Yield one Fragment per heading section across the docset's indexed pages."""
    dsidx, documents = _resolve(Path(docset))
    entries = _read_index(dsidx)

    # page -> {anchor|None: entry} and page -> [entries] (preserving index order).
    by_page_anchor: dict[str, dict[str | None, dict]] = {}
    pages: list[str] = []
    by_page: dict[str, list[dict]] = {}
    for entry in entries:
        page = entry["page"]
        by_page_anchor.setdefault(page, {}).setdefault(entry["anchor"], entry)
        if page not in by_page:
            by_page[page] = []
            pages.append(page)
        by_page[page].append(entry)

    home_base = home.rstrip("/")

    for page in pages:
        html_path = documents / page
        if not html_path.exists():
            continue
        sections = split_sections(html_path.read_text(encoding="utf-8", errors="replace"))
        if not sections:
            continue

        anchor_map = by_page_anchor.get(page, {})
        page_entries = by_page.get(page, [])
        page_entry = anchor_map.get(None) or (page_entries[0] if page_entries else None)
        default_type = normalize_dash_type(page_entries[0]["type"]) if page_entries else "reference"
        page_title = sections[0].heading or (page_entry["name"] if page_entry else page)

        for section in sections:
            body = section.text.strip()
            if not body:
                continue

            matched = anchor_map.get(section.anchor) if section.anchor else None
            if matched is None and section.level == 1:
                matched = page_entry

            doc_type = normalize_dash_type(matched["type"]) if matched else default_type

            if matched:
                entry_symbol = matched["name"] if doc_type in _SYMBOL_TYPES else None
                symbol = entry_symbol or symbol_from_heading(section.heading)
                title = (
                    matched["name"] if section.level == 1 else (section.heading or matched["name"])
                )
            else:
                symbol = symbol_from_heading(section.heading)
                title = section.heading or page_title

            heading_path = page_title if section.level == 1 else f"{page_title} > {section.heading}"

            url: str | None = None
            if home_base:
                url = f"{home_base}/{page}"
                # Real HTML anchors round-trip; Dash's "//apple_ref/…" TOC anchors do not.
                if section.anchor and not section.anchor.startswith("//"):
                    url = f"{url}#{section.anchor}"

            yield Fragment(
                library=library,
                version=version,
                title=title,
                body=body,
                symbol=symbol,
                type=doc_type,
                heading_path=heading_path,
                url=url,
                attribution=attribution,
            )
