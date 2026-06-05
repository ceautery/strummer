"""Fetch DevDocs documentation data over HTTP.

DevDocs serves each documentation set as ``index.json`` (entries + types) and
``db.json`` (path -> HTML) from the documents host, with set metadata (release,
attribution) in the top-level manifest.
"""

from __future__ import annotations

import json
import urllib.request
from html import unescape
from pathlib import Path

DOCUMENTS_HOST = "https://documents.devdocs.io"
MANIFEST_URL = "https://devdocs.io/docs.json"
DEFAULT_TIMEOUT = 180
USER_AGENT = "sackville-ingest/0.0 (+https://github.com/ceautery/sackville)"


def devdocs_url(slug: str, name: str, mtime: int | None = None) -> str:
    """Build the data URL for a DevDocs file (cache-busted by mtime if given)."""
    url = f"{DOCUMENTS_HOST}/{slug}/{name}"
    return f"{url}?{mtime}" if mtime else url


def _get(url: str) -> bytes:
    # A User-Agent is required: DevDocs returns 403 to the default urllib agent.
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:  # noqa: S310 (https only)
        return resp.read()


def fetch_manifest_entry(slug: str) -> dict | None:
    """Return the manifest entry for ``slug`` (release, attribution, links), or None."""
    docs = json.loads(_get(MANIFEST_URL))
    for doc in docs:
        if doc.get("slug") == slug:
            return doc
    return None


def fetch_devdocs(slug: str, out_dir: str | Path, *, mtime: int | None = None) -> Path:
    """Download index.json + db.json for ``slug`` into ``out_dir``. Returns the dir."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name in ("index.json", "db.json"):
        (out / name).write_bytes(_get(devdocs_url(slug, name, mtime)))
    return out


def clean_attribution(raw: str) -> str:
    """Flatten a manifest attribution blob (HTML entities + tags) to plain text."""
    text = unescape(raw)
    for tag in ("<br>", "<br/>", "<br />"):
        text = text.replace(tag, " ")
    return " ".join(text.split())
