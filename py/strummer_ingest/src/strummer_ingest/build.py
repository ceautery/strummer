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
    append: bool = False,
) -> int:
    """Build (or append to) an index at ``out_path`` from ``fragments``.

    With ``append=True`` and an existing file, add fragments to the current index
    (e.g. another version of the same library) instead of recreating it. Returns
    the number of fragments written in this call.
    """
    if embedder.dim != dbmod.EMBED_DIM:
        raise ValueError(f"embedder dim {embedder.dim} != schema embed_dim {dbmod.EMBED_DIM}")

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    reuse = append and out.exists()
    if not reuse:
        for p in (out, out.with_name(out.name + "-wal"), out.with_name(out.name + "-shm")):
            p.unlink(missing_ok=True)

    frags = list(fragments)
    conn = dbmod.open_writer(out)
    try:
        if reuse:
            existing = dict(conn.execute("SELECT key, value FROM strummer_meta").fetchall())
            if int(existing.get("schema_version", -1)) != dbmod.SCHEMA_VERSION:
                raise ValueError(
                    f"cannot append: existing index is schema "
                    f"v{existing.get('schema_version')}, expected v{dbmod.SCHEMA_VERSION}"
                )
        else:
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
