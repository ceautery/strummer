"""Offline tests for DevDocs fetch helpers (URL building + attribution cleanup)."""

from __future__ import annotations

from strummer_ingest.fetch import clean_attribution, devdocs_url


def test_devdocs_url_with_and_without_mtime():
    assert devdocs_url("react", "index.json") == "https://documents.devdocs.io/react/index.json"
    assert devdocs_url("react", "db.json", 123) == "https://documents.devdocs.io/react/db.json?123"


def test_clean_attribution_flattens_entities_and_breaks():
    raw = "&copy; 2013&ndash;present Facebook Inc.<br>\n      Licensed under CC BY 4.0."
    cleaned = clean_attribution(raw)
    assert "©" in cleaned
    assert "<br>" not in cleaned
    assert "  " not in cleaned
    assert cleaned.endswith("CC BY 4.0.")
