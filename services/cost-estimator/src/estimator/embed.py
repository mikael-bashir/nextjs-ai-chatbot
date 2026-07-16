"""Local, self-hosted semantic embedding of a theorem signature.

Primary path: a sentence-transformer model (config EST_EMBED_MODEL) loaded once
and run on CPU — milliseconds per short theorem, no API, no per-call cost, fully
private. This is the "understands the goal" half of the feature vector.

Fallback path: if `sentence-transformers` (or the model) isn't available, a
deterministic character n-gram *hashing* embedding is used instead. It's weaker
but real, dependency-free, and keeps the entire pipeline runnable so you can wire
everything up before committing to the heavy model download. Swap in the real
model any time by installing the extra — no code change, vectors just get better.

The embedder is a process-wide singleton (`get_embedder()`); the model loads
lazily on first use so importing this module is cheap.
"""
from __future__ import annotations

import hashlib
from typing import List, Optional

import numpy as np

from . import config


class _HashingEmbedder:
    """Dependency-free deterministic embedding: hashed char 3/4/5-grams → dim."""

    kind = "hashing"

    def __init__(self, dim: int):
        self.dim = dim

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dim, dtype="float32")
        t = f"^{text.lower()}$"
        for n in (3, 4, 5):
            for i in range(len(t) - n + 1):
                g = t[i : i + n]
                h = int.from_bytes(hashlib.blake2b(g.encode(), digest_size=8).digest(), "little")
                v[h % self.dim] += 1.0
        norm = float(np.linalg.norm(v))
        return v / norm if norm > 0 else v

    def encode(self, texts: List[str]) -> np.ndarray:
        return np.vstack([self._vec(t) for t in texts])


class _STEmbedder:
    kind = "sentence-transformer"

    def __init__(self, model):
        self.model = model
        self.dim = int(model.get_sentence_embedding_dimension())

    def encode(self, texts: List[str]) -> np.ndarray:
        return np.asarray(
            self.model.encode(texts, normalize_embeddings=True, show_progress_bar=False),
            dtype="float32",
        )


_singleton = None


def get_embedder():
    global _singleton
    if _singleton is not None:
        return _singleton
    if config.EMBED_ENABLED:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore

            model = SentenceTransformer(config.EMBED_MODEL, device="cpu")
            _singleton = _STEmbedder(model)
            return _singleton
        except Exception as e:  # missing package / model / offline → fallback
            print(f"[embed] sentence-transformers unavailable ({e!s}); using hashing fallback")
    _singleton = _HashingEmbedder(config.EMBED_DIM)
    return _singleton


def embed_one(signature: str) -> np.ndarray:
    return get_embedder().encode([signature or ""])[0]


def embed_many(signatures: List[str]) -> np.ndarray:
    return get_embedder().encode([s or "" for s in signatures])


def embedder_info() -> dict:
    e = get_embedder()
    return {"kind": e.kind, "dim": int(getattr(e, "dim", config.EMBED_DIM))}
