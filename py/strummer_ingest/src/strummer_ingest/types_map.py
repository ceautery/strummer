"""Rule-based normalization of DevDocs type strings into Strummer's taxonomy.

DevDocs type strings look like ``"Namespace: Category"`` (e.g. ``"React: Hooks"``).
:func:`normalize_type` maps any input string to a lowercase taxonomy label using
ordered keyword rules — first match wins — so it copes with unseen namespaces and
categories rather than relying on a fixed lookup table.
"""

from __future__ import annotations


def normalize_type(devdocs_type: str) -> str:
    """Map a DevDocs ``type`` string to a normalized Strummer taxonomy label.

    Matching is case-insensitive and rule-ordered; the first matching rule wins.
    Empty or unrecognized input falls back to ``"reference"``.
    """
    text = (devdocs_type or "").strip()
    lowered = text.lower()

    # The category (after the namespace colon) is what carries the taxonomy
    # signal; key off it so namespace tokens like "react-hooks" in
    # "Eslint-plugin-react-hooks: Lints" don't shadow the real category.
    category = lowered.split(":", 1)[1].strip() if ":" in lowered else lowered

    if "legacy" in category:
        return "legacy"
    if "hooks" in category:
        return "hook"
    if "components" in category:
        return "component"
    if "directives" in category:
        return "directive"
    if "lints" in category:
        return "lint"
    if "apis" in category or " api" in category or category == "api":
        return "api"
    if lowered.startswith("learn:") or lowered.startswith("learn "):
        return "guide"
    return "reference"


# Dash docset `type` strings are a fixed single-word vocabulary (the Dash entry
# types), unlike DevDocs' "Namespace: Category". Map them to the same taxonomy.
_DASH_TYPE_MAP = {
    "function": "function",
    "func": "function",
    "constructor": "function",
    "method": "method",
    "class": "class",
    "interface": "class",
    "struct": "class",
    "type": "class",
    "protocol": "class",
    "enum": "class",
    "trait": "class",
    "exception": "class",
    "component": "component",
    "directive": "directive",
    "hook": "hook",
    "guide": "guide",
    "section": "guide",
    "sample": "guide",
}


def normalize_dash_type(dash_type: str) -> str:
    """Map a Dash docset ``type`` token to a normalized Strummer taxonomy label.

    Case-insensitive; unrecognized tokens (Module, Constant, Property, Command, …)
    fall back to ``"reference"``.
    """
    return _DASH_TYPE_MAP.get((dash_type or "").strip().lower(), "reference")
