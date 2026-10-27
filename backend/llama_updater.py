"""llama.cpp (llama-server) release checking and download for Windows builds.

Binaries are stored under ``runtime/llama-server/<asset name>/``
(e.g. ``llama-b11913-bin-win-cuda-13.4-x64``) so that variants of the same build
(CPU / CUDA / Vulkan ...) never mix their DLLs. Older layouts are still recognized:
``runtime/llama-server/<tag>/`` and ``bin/llama-server/<asset name>/``.

Installs are staged: everything is downloaded and extracted into a hidden
``.staging-*`` directory first, and only renamed to the final name after the
whole build (including the CUDA runtime) is in place. A failed or interrupted
install therefore never shows up as an installed build.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
import zipfile
from pathlib import Path
from urllib import request as urllib_request

_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = _ROOT / "runtime" / "llama-server"
LEGACY_DIR = _ROOT / "bin" / "llama-server"

GITHUB_RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
_HEADERS = {
    "User-Agent": "stock-review-app",
    "Accept": "application/vnd.github+json",
}
_CHUNK = 256 * 1024
_INSTALL_INFO = "install.json"
_STAGING_PREFIX = ".staging-"


def _build_number(name: str) -> int:
    match = re.search(r"b(\d+)", name or "")
    return int(match.group(1)) if match else 0


def _iter_build_dirs():
    for base in (RUNTIME_DIR, LEGACY_DIR):
        if not base.exists():
            continue
        for child in base.iterdir():
            # 隠しフォルダ（作業中の .staging-* や置き換え前の退避）は数えない
            if child.name.startswith("."):
                continue
            if child.is_dir() and (child / "llama-server.exe").exists():
                yield child


def _read_install_info(build_dir: Path) -> dict:
    try:
        return json.loads((build_dir / _INSTALL_INFO).read_text("utf-8"))
    except Exception:
        return {}


def _build_sort_key(build_dir: Path) -> tuple:
    # 同じ番号のビルドが複数あるときは、後からインストールした方を優先する
    info = _read_install_info(build_dir)
    installed_at = info.get("installed_at") or (build_dir / "llama-server.exe").stat().st_mtime
    return (_build_number(build_dir.name), float(installed_at))


def _sorted_builds() -> list[Path]:
    return sorted(_iter_build_dirs(), key=_build_sort_key, reverse=True)


def find_server_exe() -> Path:
    """起動に使う llama-server.exe（最も新しいビルド）。"""
    builds = _sorted_builds()
    if not builds:
        raise RuntimeError("No llama-server builds found in runtime/llama-server/")
    return builds[0] / "llama-server.exe"


def get_local_status() -> dict:
    builds = _sorted_builds()
    if not builds:
        return {"installed": False, "build": "", "variant": "", "build_number": 0, "path": "", "count": 0}
    latest = builds[0]
    asset_name = _read_install_info(latest).get("asset_name") or latest.name
    number = _build_number(latest.name)
    return {
        "installed": True,
        "build": f"b{number}" if number else latest.name,
        # 旧形式（runtime/llama-server/<tag>/）はフォルダ名から種類が分からないので空
        "variant": _variant_label(asset_name) if "-bin-win-" in asset_name.lower() else "",
        "build_number": number,
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
    if "rocm" in low or "hip" in low or "radeon" in low:
        match = re.search(r"rocm-([\d.]+)", low)
        return f"ROCm {match.group(1)} (AMD)" if match else "HIP / ROCm (AMD)"
    if "sycl" in low:
        return "SYCL (Intel)"
    if "openvino" in low:
        match = re.search(r"openvino-([\d.]+)", low)
        return f"OpenVINO {match.group(1)} (Intel)" if match else "OpenVINO (Intel)"
    return asset_name


def _cuda_version(asset_name: str) -> str:
    match = re.search(r"cuda-(\d+\.\d+)", asset_name.lower())
    return match.group(1) if match else ""


def _http_json(url: str):
    request = urllib_request.Request(url, headers=_HEADERS)
    with urllib_request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def _parse_release(data: dict) -> dict:
    tag = str(data.get("tag_name") or "")
    variants = []
    cudart = {}
    for asset in data.get("assets", []):
        name = str(asset.get("name") or "")
        low = name.lower()
        entry = {
            "asset_name": name,
            "url": asset.get("browser_download_url") or "",
            "size": int(asset.get("size") or 0),
            # GitHub が付ける "sha256:<hex>"。無いリリースもある
            "digest": str(asset.get("digest") or ""),
        }
        if low.startswith("llama-") and "bin-win-" in low and low.endswith("x64.zip"):
            variants.append({**entry, "label": _variant_label(name)})
        elif low.startswith("cudart-") and low.endswith("x64.zip"):
            version = _cuda_version(name)
            if version:
                cudart[version] = entry

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
    return {"tag": tag, "build_number": _build_number(tag), "variants": variants, "cudart": cudart}


def _find_latest_build_release() -> dict:
    """Windows 向けビルドを持つ最新の bNNNN リリースを返す。

    llama.cpp はビルド（bNNNN）をプレリリースとして公開し、「Latest」は v0.7.0 のような
    バイナリを持たない版番号リリースになっている。そのため /releases/latest ではなく
    一覧から探す（一覧は新しい順）。
    """
    for data in _http_json(f"{GITHUB_RELEASES}?per_page=30"):
        if data.get("draft") or not re.fullmatch(r"b\d+", str(data.get("tag_name") or "")):
            continue
        release = _parse_release(data)
        if release["variants"]:
            return release
    raise RuntimeError("Windows 向けのビルドを含むリリースが見つかりません")


def fetch_latest_release() -> dict:
    """Return the latest build release tag plus the selectable Windows x64 variants."""
    release = _find_latest_build_release()
    local = get_local_status()
    return {
        **release,
        "local": local,
        "update_available": release["build_number"] > local["build_number"],
    }


def _fetch_release(tag: str) -> dict:
    # llama.cpp は1日に何度もリリースされるため、「最新」を取り直すと確認時と別の版に
    # なりうる。確認時の版をタグで指定して取得する
    if not re.fullmatch(r"b\d+", tag or ""):
        raise ValueError(f"不正なリリースタグです: {tag}")
    return _parse_release(_http_json(f"{GITHUB_RELEASES}/tags/{tag}"))


def _download_to_file(entry: dict, dest: Path, stage: str):
    """Download an asset to dest, yielding progress events, and verify its sha256 if known."""
    request = urllib_request.Request(entry["url"], headers=_HEADERS)
    digest = hashlib.sha256()
    with urllib_request.urlopen(request, timeout=120) as response, open(dest, "wb") as out:
        total = int(response.headers.get("Content-Length") or 0)
        received = 0
        last_percent = -1
        while True:
            chunk = response.read(_CHUNK)
            if not chunk:
                break
            out.write(chunk)
            digest.update(chunk)
            received += len(chunk)
            percent = int(received * 100 / total) if total else 0
            if percent != last_percent:
                last_percent = percent
                yield {"type": "progress", "stage": stage, "received": received, "total": total, "percent": percent}
    if total and received != total:
        raise RuntimeError(f"{entry['asset_name']} のダウンロードが途中で終わりました（{received} / {total} バイト）")
    expected = entry.get("digest", "")
    if expected.startswith("sha256:") and digest.hexdigest() != expected.split(":", 1)[1].lower():
        raise RuntimeError(f"{entry['asset_name']} のチェックサムが一致しません")


def _extract_flat(zip_path: Path, target_dir: Path) -> None:
    """Extract a zip and ensure llama-server.exe ends up directly under target_dir."""
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(target_dir)
    exe = next(target_dir.rglob("llama-server.exe"), None)
    if exe and exe.parent != target_dir:
        for item in exe.parent.iterdir():
            shutil.move(str(item), str(target_dir / item.name))


def _extract_into(zip_path: Path, target_dir: Path) -> None:
    """Extract auxiliary files (e.g. cudart DLLs) directly into target_dir."""
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.namelist():
            if member.endswith("/"):
                continue
            name = Path(member).name
            with archive.open(member) as source, open(target_dir / name, "wb") as out:
                shutil.copyfileobj(source, out)


def _clean_stale_staging() -> None:
    if not RUNTIME_DIR.exists():
        return
    for child in RUNTIME_DIR.iterdir():
        if child.is_dir() and child.name.startswith("."):
            shutil.rmtree(child, ignore_errors=True)


def _replace_build_dir(staging: Path, target: Path) -> None:
    """staging を target の名前にする。同じ種類が既にあれば退避してから置き換える。"""
    if not target.exists():
        staging.rename(target)
        return
    backup = target.with_name(f".old-{target.name}-{int(time.time())}")
    try:
        # 起動中の llama-server.exe を含むフォルダは Windows では名前を変えられない。
        # 途中まで消して壊すことがないよう、削除ではなく名前の変更で確かめる
        target.rename(backup)
    except OSError as e:
        raise RuntimeError(
            f"{target.name} は使用中のため置き換えられません。モデルを停止してからもう一度実行してください。"
        ) from e
    staging.rename(target)
    shutil.rmtree(backup, ignore_errors=True)


def download_build(asset_name: str, tag: str):
    """Download and install the given build variant, yielding SSE-friendly events."""
    release = _fetch_release(tag)
    variant = next((v for v in release["variants"] if v["asset_name"] == asset_name), None)
    if not variant:
        raise ValueError(f"{tag} に {asset_name} が見つかりません")

    cudart = None
    cuda_version = _cuda_version(asset_name)
    if cuda_version:
        cudart = release["cudart"].get(cuda_version)
        if not cudart:
            # ランタイム無しの CUDA 版は、CUDA Toolkit が無い環境では起動できない
            raise RuntimeError(f"{tag} に CUDA {cuda_version} のランタイム（cudart）が見つかりません")

    folder_name = asset_name[:-len(".zip")]
    target_dir = RUNTIME_DIR / folder_name
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    _clean_stale_staging()
    staging = RUNTIME_DIR / f"{_STAGING_PREFIX}{folder_name}"
    staging.mkdir()
    try:
        main_zip = staging / "_download.zip"
        yield from _download_to_file(variant, main_zip, "main")
        yield {"type": "progress", "stage": "extract", "percent": 100}
        _extract_flat(main_zip, staging)
        main_zip.unlink()

        if cudart:
            cudart_zip = staging / "_cudart.zip"
            yield from _download_to_file(cudart, cudart_zip, "cudart")
            _extract_into(cudart_zip, staging)
            cudart_zip.unlink()

        if not (staging / "llama-server.exe").exists():
            raise RuntimeError("展開後に llama-server.exe が見つかりません")
        (staging / _INSTALL_INFO).write_text(
            json.dumps({"tag": tag, "asset_name": asset_name, "installed_at": time.time()}, ensure_ascii=False),
            encoding="utf-8",
        )
        _replace_build_dir(staging, target_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    yield {
        "type": "done",
        "build": tag,
        "build_number": _build_number(tag),
        "variant": variant["label"],
        "path": str(target_dir),
    }
