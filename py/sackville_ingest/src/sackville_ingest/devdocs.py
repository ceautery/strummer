"""DevDocs source adapter.

Turns a DevDocs documentation set (``index.json`` entries + ``db.json`` page
HTML) into normalized :class:`Fragment` records by chunking each page into
heading sections and attaching the matching entry's name/type.
"""

from __future__ import annotations

from collections.abc import Iterator

from .extract import split_sections, symbol_from_heading
from .model import Fragment
from .types_map import normalize_type

# Types for which the entry name is a code symbol worth recording.
_SYMBOL_TYPES = {"hook", "component", "api", "directive", "function", "class", "method"}


def _split_path(path: str) -> tuple[str, str | None]:
    """Split a DevDocs entry path into (page, anchor)."""
    page, _, anchor = path.partition("#")
    return page, (anchor or None)


def _recover_case(page: str, name: str) -> str:
    """DevDocs lowercases paths; if the entry name matches the last path segment
    case-insensitively, restore its original casing for a correct upstream URL."""
    head, sep, last = page.rpartition("/")
    if sep and last and last.lower() == name.lower():
        return f"{head}/{name}"
    return page


def iter_fragments(
    index: dict,
    db: dict,
    *,
    library: str,
    version: str,
    home: str,
    attribution: str,
) -> Iterator[Fragment]:
    """Yield one Fragment per heading section across all pages."""
    entries = index.get("entries", [])

    # page -> {anchor|None: entry}, and page -> [entries] (for type fallback).
    by_page_anchor: dict[str, dict[str | None, dict]] = {}
    by_page: dict[str, list[dict]] = {}
    for entry in entries:
        page, anchor = _split_path(entry["path"])
        by_page_anchor.setdefault(page, {})[anchor] = entry
        by_page.setdefault(page, []).append(entry)

    home_base = home.rstrip("/")

    for page, html in db.items():
        if page == "index":  # docset landing page, not a doc fragment
            continue
        sections = split_sections(html)
        if not sections:
            continue

        page_title = sections[0].heading or page
        anchor_map = by_page_anchor.get(page, {})
        page_entry = anchor_map.get(None)
        page_entries = by_page.get(page, [])
        if page_entries:
            default_type = normalize_type(page_entries[0]["type"])
        else:
            default_type = "guide" if page.startswith("learn") else "reference"

        for section in sections:
            body = section.text.strip()
            if not body:
                continue

            matched = anchor_map.get(section.anchor) if section.anchor else page_entry
            if section.level == 1 and matched is None:
                matched = page_entry

            doc_type = normalize_type(matched["type"]) if matched else default_type

            # Prefer the matched entry's name as the symbol; otherwise recover
            # one from a signature-style heading (e.g. "render(props)").
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

            url_page = _recover_case(page, matched["name"]) if matched else page
            url = f"{home_base}/{url_page}"
            if section.anchor:
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
