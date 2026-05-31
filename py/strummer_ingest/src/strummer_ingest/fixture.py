"""Build the golden test fixture used by the TypeScript boundary test.

A single hand-crafted react/useState fragment with a constant embedding — no
scraping or real embedding yet. This proves the entire contract end to end:
schema application, meta seeding, docs/FTS/vec id alignment, and a clean file
the TypeScript reader opens.
"""

from __future__ import annotations

from pathlib import Path

from .db import (
    EMBED_DIM,
    apply_schema,
    finalize,
    insert_doc,
    insert_vector,
    open_writer,
    seed_meta,
)


def build_golden_fixture(out_path: str | Path) -> int:
    """(Re)build the golden fixture at ``out_path``. Returns the doc count."""
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    for p in (out, out.with_name(out.name + "-wal"), out.with_name(out.name + "-shm")):
        p.unlink(missing_ok=True)

    conn = open_writer(out)
    try:
        apply_schema(conn)
        # Fixed timestamp so the committed fixture is byte-stable across rebuilds.
        seed_meta(conn, builder_version="fixture", built_at="1970-01-01T00:00:00+00:00")
        doc_id = insert_doc(
            conn,
            library="react",
            version="19.0",
            title="useState",
            symbol="useState",
            type="function",
            heading_path="Hooks > useState",
            url="https://react.dev/reference/react/useState",
            attribution="React documentation, MIT License",
            body="useState is a React Hook that lets you add a state variable to your component.",
        )
        insert_vector(
            conn,
            doc_id=doc_id,
            library="react",
            version="19.0",
            type="function",
            embedding=[0.0] * EMBED_DIM,
        )
        finalize(conn)
    finally:
        conn.close()
    return 1
