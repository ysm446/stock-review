"""Embedding helper using ruri-v3-310m (準備済み・将来の memory/RAG 用)."""
from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

logger = logging.getLogger(__name__)

_MODEL_NAME = "cl-nagoya/ruri-v3-310m"
_CACHE_DIR = Path(__file__).resolve().parent.parent / "models" / "embeddings"
_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_MODEL_NAME, cache_folder=str(_CACHE_DIR))
    return _model


@lru_cache(maxsize=512)
def embed(text: str) -> tuple[float, ...]:
    model = _get_model()
    vector = model.encode(text, normalize_embeddings=True, show_progress_bar=False)
    return tuple(float(v) for v in vector)


def warmup() -> None:
    try:
        embed("warmup")
        logger.info("Embedder (ruri-v3-310m) warmed up.")
    except ImportError:
        logger.warning("sentence-transformers not installed; embedder disabled.")
    except Exception as e:
        logger.warning("Embedder warmup failed: %s", e)
