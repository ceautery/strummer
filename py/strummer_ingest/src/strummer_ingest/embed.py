"""Embedder abstraction for the ingestion pipeline.

Defines the :class:`Embedder` protocol plus two implementations: the
deterministic :class:`FakeEmbedder` (used in unit tests and offline builds) and
:class:`FastEmbedEmbedder`, which wraps ``fastembed`` for real embeddings. The
output dimension is fixed at 384 to match the SQLite vector schema.

``fastembed`` is imported lazily so that importing this module stays cheap and
fully offline — the heavy dependency is only pulled in when an embedding is
actually requested.
"""

from __future__ import annotations

import hashlib
import struct
from typing import Protocol, runtime_checkable

# Our schema's embed_model name -> the fastembed model id that produces it.
SCHEMA_TO_FASTEMBED = {"bge-small-en-v1.5": "BAAI/bge-small-en-v1.5"}

# Fixed embedding dimension for the vector schema.
EMBED_DIM = 384


@runtime_checkable
class Embedder(Protocol):
    """Anything that turns texts into fixed-dimension float vectors."""

    dim: int

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return one ``dim``-length vector per input text."""
        ...


class FakeEmbedder:
    """Deterministic, dependency-free pseudo-embedder.

    The vector is derived purely from the text via a hash digest, so the same
    text always yields the same vector and distinct texts yield distinct
    vectors. Values are not semantically meaningful — this exists for fast,
    hermetic tests and offline index builds.
    """

    def __init__(self, dim: int = EMBED_DIM) -> None:
        self.dim = dim

    def _vector(self, text: str) -> list[float]:
        out: list[float] = []
        counter = 0
        # Expand the digest deterministically until we have `dim` floats.
        while len(out) < self.dim:
            digest = hashlib.sha256(f"{counter}:{text}".encode()).digest()
            # 8 unsigned 32-bit ints per 32-byte digest -> 8 floats in [0, 1).
            for value in struct.unpack("<8I", digest):
                out.append(value / 0xFFFFFFFF)
                if len(out) == self.dim:
                    break
            counter += 1
        return out

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]


class FastEmbedEmbedder:
    """Real embedder backed by ``fastembed`` (BAAI/bge-small-en-v1.5).

    The ``fastembed`` import and model construction are deferred until the first
    :meth:`embed` call, so constructing this object never downloads a model nor
    imports the heavy dependency.
    """

    def __init__(self, model_name: str = "BAAI/bge-small-en-v1.5", dim: int = EMBED_DIM) -> None:
        self.model_name = model_name
        self.dim = dim
        self._model: object | None = None

    def _ensure_model(self) -> object:
        if self._model is None:
            from fastembed import TextEmbedding  # lazy import: keeps module offline

            self._model = TextEmbedding(model_name=self.model_name)
        return self._model

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._ensure_model()
        return [vec.tolist() for vec in model.embed(texts)]  # type: ignore[attr-defined]
