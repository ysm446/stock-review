"""llama.cpp (llama-server) release checking and download for Windows builds.

Binaries are stored under ``runtime/llama-server/<tag>/``. The old
``bin/llama-server/`` layout is still recognized for backward compatibility.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import zipfile
from pathlib import Path
from urllib import request as urllib_request

_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = _ROOT / "runtime" / "llama-server"
LEGACY_DIR = _ROOT / "bin" / "llama-server"

GITHUB_LATEST = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
_HEADERS = {
    "User-Agent": "stock-review-app",
    "Accept": "application/vnd.github+json",
}
_CHUNK = 256 * 1024


def _build_number(name: str) -> int:
    match = re.search(r"b(\d+)", name or "")
    return int(match.group(1)) if match else 0


def _iter_build_dirs():
    for base in (RUNTIME_DIR, LEGACY_DIR):
        if not base.exists():
            continue
        for child in base.iterdir():
            if child.is_dir() and (child / "llama-server.exe").exists():
                yield child


def get_local_status() -> dict:
    builds = sorted(_iter_build_dirs(), key=lambda d: _build_number(d.name), reverse=True)
    if not builds:
        return {"installed": False, "build": "", "build_number": 0, "path": "", "count": 0}
    latest = builds[0]
    return {
        "installed": True,
        "build": latest.name,
        "build_number": _build_number(latest.name),
        "path": str(latest),
        "count": len(builds),
    }


def _variant_label(asset_name: str) -> str:
    low = asset_name.lower()
    if "cpu" in low:
        return "CPU"
    if "cuda" in low:
        match = re.search(r"cuda-(\d+\.\d+)", low)
        return f"CUDA {match.group(1)} (NVIDIA)" if match else "CUDA (NVIDIA)"
    if "vulkan" in low:
        return "Vulkan (汎用GPU)"
    if "hip" in low or "radeon" in low:
        return "HIP / ROCm (AMD)"
    if "sycl" in low:
        return "SYCL (Intel)"
    if "openvino" in low:
        match = re.search(r"openvino-([\d.]+)", low)
        return f"OpenVINO {match.group(1)} (Intel)" if match else "OpenVINO (Intel)"
    return asset_name


def _cuda_version(asset_name: str) -> str:
    match = re.search(r"cuda-(\d+\.\d+)", asset_name.lower())
    return match.group(1) if match else ""


def _http_json(url: str) -> dict:
    request = urllib_request.Request(url, headers=_HEADERS)
    with urllib_request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_latest_release() -> dict:
    """Return the latest release tag plus the selectable Windows x64 variants."""
    data = _http_json(GITHUB_LATEST)
    tag = str(data.get("tag_name") or "")
    assets = data.get("assets", [])

    variants = []
    cudart = {}
    for asset in assets:
        name = str(asset.get("name") or "")
        low = name.lower()
        url = asset.get("browser_download_url") or ""
        if low.startswith("llama-") and "bin-win-" in low and low.endswith("x64.zip"):
            variants.append({
                "asset_name": name,
                "label": _variant_label(name),
                "size": int(asset.get("size") or 0),
                "url": url,
            })
        elif low.startswith("cudart-") and low.endswith("x64.zip"):
            version = _cuda_version(name)
            if version:
                cudart[version] = {"asset_name": name, "url": url, "size": int(asset.get("size") or 0)}

    # Stable ordering: CPU, CUDA (ascending), Vulkan, others.
    def sort_key(variant):
        label = variant["label"]
        if label == "CPU":
            return (0, "")
        if label.startswith("CUDA"):
            return (1, label)
        if label.startswith("Vulkan"):
            return (2, "")
        return (3, label)

    variants.sort(key=sort_key)

    local = get_local_status()
    return {
        "tag": tag,
        "build_number": _build_number(tag),
        "variants": variants,
        "cudart": cudart,
        "local": local,
        "update_available": _build_number(tag) > local["build_number"],
    }


def _download_zip(url: str, stage: str):
    """Download a zip to memory, yielding progress events; finally yields the buffer."""
    request = urllib_request.Request(url, headers=_HEADERS)
    with urllib_request.urlopen(request, timeout=120) as response:
        total = int(response.headers.get("Content-Length") or 0)
        buffer = io.BytesIO()
        received = 0
        last_percent = -1
        while True:
            chunk = response.read(_CHUNK)
            if not chunk:
                break
            buffer.write(chunk)
            received += len(chunk)
            percent = int(received * 100 / total) if total else 0
            if percent != last_percent:
                last_percent = percent
                yield {"type": "progress", "stage": stage, "received": received, "total": total, "percent": percent}
    buffer.seek(0)
    yield {"type": "_buffer", "buffer": buffer}


def _extract_flat(buffer: io.BytesIO, target_dir: Path) -> None:
    """Extract a zip and ensure llama-server.exe ends up directly under target_dir."""
    with zipfile.ZipFile(buffer) as archive:
        archive.extractall(target_dir)
    exe = next(target_dir.rglob("llama-server.exe"), None)
    if exe and exe.parent != target_dir:
        for item in exe.parent.iterdir():
            destination = target_dir / item.name
            if destination.exists():
                continue
            shutil.move(str(item), str(destination))


def _extract_into(buffer: io.BytesIO, target_dir: Path) -> None:
    """Extract auxiliary files (e.g. cudart DLLs) directly into target_dir."""
    with zipfile.ZipFile(buffer) as archive:
        for member in archive.namelist():
            if member.endswith("/"):
                continue
            name = Path(member).name
            with archive.open(member) as source, open(target_dir / name, "wb") as out:
                shutil.copyfileobj(source, out)


def download_build(asset_name: str):
    """Download and install the given build variant, yielding SSE-friendly events."""
    release = fetch_latest_release()
    tag = release["tag"]
    variant = next((v for v in release["variants"] if v["asset_name"] == asset_name), None)
    if not variant:
        raise ValueError(f"Asset not found in latest release: {asset_name}")

    target_dir = RUNTIME_DIR / tag
    target_dir.mkdir(parents=True, exist_ok=True)

    main_buffer = None
    for event in _download_zip(variant["url"], "main"):
        if event["type"] == "_buffer":
            main_buffer = event["buffer"]
        else:
            yield event
    yield {"type": "progress", "stage": "extract", "percent": 100}
    _extract_flat(main_buffer, target_dir)

    # CUDA builds need the matching cudart DLLs bundled in.
    cuda_version = _cuda_version(asset_name)
    if cuda_version and cuda_version in release["cudart"]:
        cudart = release["cudart"][cuda_version]
        cudart_buffer = None
        for event in _download_zip(cudart["url"], "cudart"):
            if event["type"] == "_buffer":
                cudart_buffer = event["buffer"]
            else:
                yield event
        if cudart_buffer is not None:
            _extract_into(cudart_buffer, target_dir)

    if not (target_dir / "llama-server.exe").exists():
        raise RuntimeError("llama-server.exe was not found after extraction")

    yield {"type": "done", "build": tag, "build_number": _build_number(tag), "path": str(target_dir)}
