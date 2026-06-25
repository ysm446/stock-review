"""Embedding model (ruri-v3-310m) status + manual download for the settings UI.

The model is fetched from HuggingFace into ``models/embeddings/`` by
sentence-transformers. This module exposes a lightweight status check and a
manual download that reports coarse progress by polling the cache directory.
"""
from __future__ import annotations

import importlib.util
import threading
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = _ROOT / "models" / "embeddings"
MODEL_NAME = "cl-nagoya/ruri-v3-310m"
_REPO_FOLDER = "models--" + MODEL_NAME.replace("/", "--")


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _snapshot_dir() -> Path | None:
    base = CACHE_DIR / _REPO_FOLDER / "snapshots"
    if base.exists():
        for snap in base.iterdir():
            if (snap / "config.json").exists():
                return snap
    return None


def is_cached() -> bool:
    if _snapshot_dir() is not None:
        return True
    # Fallback for non-standard cache layouts: any config.json next to weights.
    if CACHE_DIR.exists():
        for cfg in CACHE_DIR.rglob("config.json"):
            folder = cfg.parent
            if any(folder.glob("*.safetensors")) or any(folder.glob("pytorch_model.bin")):
                return True
    return False


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total


def get_status() -> dict:
    return {
        "model_name": MODEL_NAME,
        "available": _has_module("sentence_transformers"),
        "sqlite_vec": _has_module("sqlite_vec"),
        "cached": is_cached(),
        "path": str(CACHE_DIR),
    }


def _expected_total() -> int:
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(MODEL_NAME, files_metadata=True)
        return sum(int(s.size) for s in info.siblings if getattr(s, "size", None))
    except Exception:
        return 0


def download():
    """Download the embedding model, yielding SSE-friendly progress events."""
    if not _has_module("sentence_transformers"):
        raise RuntimeError(
            "sentence-transformers が未インストールです。requirements-optional.txt を導入してください。"
        )
    if is_cached():
        yield {"type": "done", "cached": True}
        return

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    total = _expected_total()
    blobs = CACHE_DIR / _REPO_FOLDER / "blobs"
    error: dict = {}

    def _run():
        try:
            from sentence_transformers import SentenceTransformer

            SentenceTransformer(MODEL_NAME, cache_folder=str(CACHE_DIR))
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller below
            error["msg"] = str(exc)

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()

    last_percent = -1
    while thread.is_alive():
        downloaded = _dir_size(blobs)
        percent = int(downloaded * 100 / total) if total else 0
        if percent != last_percent:
            last_percent = percent
            yield {"type": "progress", "received": downloaded, "total": total, "percent": min(percent, 99)}
        time.sleep(0.5)
    thread.join()

    if error:
        raise RuntimeError(error["msg"])
    yield {"type": "done", "cached": True}
