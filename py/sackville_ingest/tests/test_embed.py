"""Tests for the embedder abstraction.

Covers the deterministic :class:`FakeEmbedder` and verifies that importing the
module stays cheap and offline (no eager ``fastembed`` import). The real
``FastEmbedEmbedder`` is not exercised by default — it would download a model.
"""

from __future__ import annotations

import importlib
import os
import sys

import pytest


def test_import_does_not_pull_in_fastembed() -> None:
    # Drop any cached import so the assertion is meaningful.
    sys.modules.pop("fastembed", None)
    sys.modules.pop("sackville_ingest.embed", None)
    importlib.import_module("sackville_ingest.embed")
    assert "fastembed" not in sys.modules


def test_fake_embedder_is_deterministic() -> None:
    from sackville_ingest.embed import FakeEmbedder

    emb = FakeEmbedder()
    assert emb.dim == 384

    vecs = emb.embed(["a", "b", "a"])
    assert len(vecs) == 3
    for v in vecs:
        assert len(v) == 384
        assert all(isinstance(x, float) for x in v)

    assert vecs[0] == vecs[2]  # same text -> identical vector
    assert vecs[0] != vecs[1]  # different text -> different vector


def test_fake_embedder_custom_dim() -> None:
    from sackville_ingest.embed import FakeEmbedder

    emb = FakeEmbedder(dim=16)
    assert emb.dim == 16
    (vec,) = emb.embed(["hello"])
    assert len(vec) == 16


def test_fake_embedder_empty_input() -> None:
    from sackville_ingest.embed import FakeEmbedder

    assert FakeEmbedder().embed([]) == []


def test_schema_to_fastembed_mapping() -> None:
    from sackville_ingest.embed import SCHEMA_TO_FASTEMBED

    assert SCHEMA_TO_FASTEMBED["bge-small-en-v1.5"] == "BAAI/bge-small-en-v1.5"


def test_fake_embedder_satisfies_protocol() -> None:
    from sackville_ingest.embed import Embedder, FakeEmbedder

    emb: Embedder = FakeEmbedder()
    assert emb.dim == 384


def test_fastembed_constructs_lazily_without_download() -> None:
    from sackville_ingest.embed import FastEmbedEmbedder

    sys.modules.pop("fastembed", None)
    # Construction must not import fastembed or download a model.
    emb = FastEmbedEmbedder()
    assert emb.dim == 384
    assert emb.model_name == "BAAI/bge-small-en-v1.5"
    assert "fastembed" not in sys.modules


@pytest.mark.skipif(
    not os.environ.get("SACKVILLE_RUN_EMBED_TESTS"),
    reason="real fastembed model download is slow; set SACKVILLE_RUN_EMBED_TESTS to run",
)
def test_fastembed_real_embedding() -> None:
    from sackville_ingest.embed import FastEmbedEmbedder

    emb = FastEmbedEmbedder()
    vecs = emb.embed(["hello world"])
    assert len(vecs) == 1
    assert len(vecs[0]) == 384
    assert all(isinstance(x, float) for x in vecs[0])
