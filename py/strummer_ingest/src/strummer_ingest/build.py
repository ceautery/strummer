"""Index builder — persist Fragments into the SQLite contract with embeddings."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from . import db as dbmod
from .embed import Embedder
from .model import Fragment


def build_index(
    fragments: Iterable[Fragment],
    embedder: Embedder,
    out_path: str | Path,
    *,
    builder_version: str = "ingest",
) -> int:
    """Build a fresh index at ``out_path`` from ``fragments``. Returns doc count."""
    if embedder.dim != dbmod.EMBED_DIM:
        raise ValueError(f"embedder dim {embedder.dim} != schema embed_dim {dbmod.EMBED_DIM}")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    for p in (out, out.with_name(out.name + "-wal"), out.with_name(out.name + "-shm")):
        p.unlink(missing_ok=True)

    frags = list(fragments)
    conn = dbmod.open_writer(out)
    try:
        dbmod.apply_schema(conn)
        dbmod.seed_meta(conn, builder_version=builder_version)

        ids = [
            dbmod.insert_doc(
                conn,
                library=f.library,
                version=f.version,
                title=f.title,
                body=f.body,
                symbol=f.symbol,
                type=f.type,
                heading_path=f.heading_path,
                url=f.url,
                attribution=f.attribution,
            )
            for f in frags
        ]

        vectors = embedder.embed([f.body for f in frags]) if frags else []
        for doc_id, frag, vector in zip(ids, frags, vectors, strict=True):
            dbmod.insert_vector(
                conn,
                doc_id=doc_id,
                library=frag.library,
                version=frag.version,
                type=frag.type,
                embedding=vector,
            )

        dbmod.finalize(conn)
    finally:
        conn.close()

    return len(frags)
