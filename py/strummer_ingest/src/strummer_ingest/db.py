"""SQLite index writer — the Python half of the file-as-contract boundary.

Loads sqlite-vec, applies schema/strummer.schema.sql, and provides typed insert
helpers. Both the DDL and the version/dim constants come from the repo-root
``schema/`` directory so Python and TypeScript can never drift.
"""

from __future__ import annotations

import json
import sqlite3
import struct
from datetime import UTC, datetime
from pathlib import Path

import sqlite_vec


def _schema_dir() -> Path:
    """Locate the repo-root ``schema/`` directory (dev layout or installed)."""
    seeds = (Path(__file__).resolve(), Path.cwd().resolve())
    for seed in seeds:
        for base in (seed, *seed.parents):
            if (base / "schema" / "strummer.schema.sql").exists():
                return base / "schema"
    raise FileNotFoundError("could not locate schema/strummer.schema.sql")


SCHEMA_DIR = _schema_dir()
SCHEMA_SQL = (SCHEMA_DIR / "strummer.schema.sql").read_text()
SCHEMA_JSON = json.loads((SCHEMA_DIR / "strummer.schema.json").read_text())

SCHEMA_VERSION: int = SCHEMA_JSON["schema_version"]
EMBED_MODEL: str = SCHEMA_JSON["embed_model"]
EMBED_DIM: int = SCHEMA_JSON["embed_dim"]


def open_writer(path: str | Path) -> sqlite3.Connection:
    """Open a writable connection with sqlite-vec loaded (creates the file)."""
    conn = sqlite3.connect(str(path))
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def apply_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)


def seed_meta(
    conn: sqlite3.Connection,
    *,
    builder_version: str,
    built_at: str | None = None,
) -> None:
    """Seed strummer_meta. Pass a fixed ``built_at`` for deterministic fixtures."""
    conn.executemany(
        "INSERT INTO strummer_meta(key, value) VALUES (?, ?)",
        [
            ("schema_version", str(SCHEMA_VERSION)),
            ("embed_model", EMBED_MODEL),
            ("embed_dim", str(EMBED_DIM)),
            ("built_at", built_at or datetime.now(UTC).isoformat()),
            ("builder_version", builder_version),
        ],
    )


def insert_doc(
    conn: sqlite3.Connection,
    *,
    library: str,
    version: str,
    title: str,
    body: str,
    symbol: str | None = None,
    type: str | None = None,
    heading_path: str | None = None,
    url: str | None = None,
    attribution: str | None = None,
) -> int:
    """Insert a canonical fragment; FTS is kept in sync by triggers. Returns id."""
    cur = conn.execute(
        """
        INSERT INTO docs(
            library, version, title, symbol, type, heading_path, url, attribution, body
        )
        VALUES (
            :library, :version, :title, :symbol, :type, :heading_path, :url, :attribution, :body
        )
        """,
        {
            "library": library,
            "version": version,
            "title": title,
            "symbol": symbol,
            "type": type,
            "heading_path": heading_path,
            "url": url,
            "attribution": attribution,
            "body": body,
        },
    )
    return int(cur.lastrowid)


def insert_vector(
    conn: sqlite3.Connection,
    *,
    doc_id: int,
    library: str,
    version: str,
    type: str | None,
    embedding: list[float],
) -> None:
    if len(embedding) != EMBED_DIM:
        raise ValueError(f"embedding has {len(embedding)} dims, expected {EMBED_DIM}")
    blob = struct.pack(f"{EMBED_DIM}f", *embedding)
    conn.execute(
        "INSERT INTO docs_vec(doc_id, library, version, type, embedding) VALUES (?, ?, ?, ?, ?)",
        (doc_id, library, version, type, blob),
    )


def finalize(conn: sqlite3.Connection) -> None:
    """Checkpoint and VACUUM so the shipped file is a single clean artifact.

    Switches journal_mode back to DELETE so no -wal/-shm sidecars linger after
    close — the reader (and git) sees exactly one ``.sqlite`` file.
    """
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("VACUUM")
    conn.commit()
