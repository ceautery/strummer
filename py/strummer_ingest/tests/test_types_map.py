"""Tests for the DevDocs type-string normalization rules."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from strummer_ingest.types_map import normalize_type

_INDEX = Path(__file__).parent / "data" / "devdocs_react" / "index.json"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("React: Hooks", "hook"),
        ("React: Components", "component"),
        ("React-dom: Components", "component"),
        ("React Server Components: Directives", "directive"),
        ("Learn: Adding Interactivity", "guide"),
        ("Eslint-plugin-react-hooks: Lints", "lint"),
        ("React: Legacy APIs", "legacy"),
        ("React: APIs", "api"),
        ("React: Reference", "reference"),
        ("", "reference"),
        ("Something Unknown", "reference"),
    ],
)
def test_normalize_type(raw: str, expected: str) -> None:
    assert normalize_type(raw) == expected


def test_precedence_legacy_beats_hooks() -> None:
    # 'Legacy' wins over later rules even when other keywords appear.
    assert normalize_type("React: Legacy Hooks") == "legacy"


def test_hooks_case_insensitive() -> None:
    assert normalize_type("react: hooks") == "hook"


def test_api_via_singular_keyword() -> None:
    assert normalize_type("React: useId API") == "api"


def test_learn_via_space_prefix() -> None:
    assert normalize_type("Learn Adding State") == "guide"


def test_garbage_inputs_default_to_reference() -> None:
    for junk in ["   ", ":", "12345", "\n\t"]:
        assert normalize_type(junk) == "reference"


def test_every_index_type_maps_without_raising() -> None:
    data = json.loads(_INDEX.read_text())
    types = {entry["type"] for entry in data["entries"]}
    assert types  # fixture must contain at least one type
    valid = {"legacy", "hook", "component", "directive", "lint", "api", "guide", "reference"}
    for t in types:
        assert normalize_type(t) in valid
