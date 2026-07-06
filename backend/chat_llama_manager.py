"""llama-server の役割ベース管理（news-picker の llama_manager パターンを移植）。

- standard（:8081）: 常駐向けの軽量モデル。ノート要約などの背景処理と、
  deep が落ちているときのチャットのフォールバック先。
- deep（:8082）: チャット用の高性能モデル。VRAM 節約のため手動でロード/アンロードする。

設定と PID は data/llama_paths.json に保存する:
  {"roles": {"standard": {"model_path": ..., "ctx_size": ..., "pid": ...}, "deep": {...}}}
"""
from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib import request as urllib_request

from shared import atomic_write_text
from paths import LLAMA_PATHS_FILE as _PATHS_FILE

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
# Downloaded llama-server builds live under runtime/; bin/ is the legacy location.
_RUNTIME_DIR = _ROOT / "runtime" / "llama-server"
_LEGACY_BIN_DIR = _ROOT / "bin" / "llama-server"

# 注意: news-picker が同一マシンで 8081/8082 を使うため、衝突しないポートを選ぶこと
ROLES: dict[str, dict] = {
    "standard": {"port": 8091, "default_ctx": 16384, "label": "常駐"},
    "deep": {"port": 8092, "default_ctx": 32768, "label": "深堀り"},
}

CTX_OPTIONS = (4096, 8192, 16384, 32768, 65536)


def role_base_url(role: str) -> str:
    return f"http://127.0.0.1:{ROLES[role]['port']}"


def _find_latest_exe() -> Path:
    builds = [
        child
        for base in (_RUNTIME_DIR, _LEGACY_BIN_DIR)
        if base.exists()
        for child in base.iterdir()
        if child.is_dir() and (child / "llama-server.exe").exists()
    ]
    builds.sort(
        key=lambda d: int(m.group(1)) if (m := re.search(r"b(\d+)", d.name)) else 0,
        reverse=True,
    )
    if not builds:
        raise RuntimeError("No llama-server builds found in runtime/llama-server/")
    return builds[0] / "llama-server.exe"


def _get_paths() -> dict:
    if _PATHS_FILE.exists():
        try:
            return json.loads(_PATHS_FILE.read_text("utf-8-sig"))
        except Exception:
            pass
    return {}


def _save_paths(paths: dict) -> None:
    _PATHS_FILE.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(_PATHS_FILE, json.dumps(paths, indent=2, ensure_ascii=False))


def _role_state(paths: dict, role: str) -> dict:
    return paths.setdefault("roles", {}).setdefault(role, {})


def migrate_legacy_state() -> None:
    """旧・単一サーバー構成（:8080、active_model_path/llama_server_pid）からの移行。

    旧キーが残っていれば、稼働中の旧サーバーを止め、選択されていたモデルを
    deep（チャット役割）に引き継ぐ。
    """
    paths = _get_paths()
    if "llama_server_pid" not in paths and "active_model_path" not in paths:
        return
    legacy_pid = paths.pop("llama_server_pid", None)
    legacy_model = paths.pop("active_model_path", "")
    legacy_ctx = paths.pop("ctx_size", None)
    if legacy_pid:
        _kill_pid(legacy_pid)
    deep = _role_state(paths, "deep")
    if legacy_model and not deep.get("model_path"):
        deep["model_path"] = legacy_model
        if legacy_ctx:
            deep["ctx_size"] = int(legacy_ctx)
    _save_paths(paths)
    logger.info("Migrated legacy llama state (model → deep role)")


def _kill_pid(pid) -> None:
    if not pid:
        return
    if sys.platform == "win32":
        result = subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True, text=True,
        )
        logger.info("taskkill /PID %s → rc=%s", pid, result.returncode)
    else:
        try:
            import os
            os.kill(int(pid), 9)
        except OSError:
            pass


def is_ready(role: str) -> bool:
    try:
        with urllib_request.urlopen(f"{role_base_url(role)}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def chat_base_url() -> str | None:
    """チャットに使うサーバー。deep 優先、落ちていれば standard にフォールバック。"""
    if is_ready("deep"):
        return role_base_url("deep")
    if is_ready("standard"):
        return role_base_url("standard")
    return None


def chat_role() -> str | None:
    if is_ready("deep"):
        return "deep"
    if is_ready("standard"):
        return "standard"
    return None


def get_roles_status() -> dict:
    paths = _get_paths()
    roles = {}
    for role, config in ROLES.items():
        state = (paths.get("roles") or {}).get(role, {})
        model_path = state.get("model_path", "")
        roles[role] = {
            "role": role,
            "label": config["label"],
            "port": config["port"],
            "ready": is_ready(role),
            "model_path": model_path,
            "model_name": Path(model_path).name if model_path else "",
            "ctx_size": int(state.get("ctx_size") or config["default_ctx"]),
            "autostart": bool(state.get("autostart")),
        }
    active = chat_role()
    return {
        "roles": roles,
        "chat_role": active,
        "chat_model_name": roles[active]["model_name"] if active else "",
    }


def save_role_settings(role: str, model_path: str | None = None, ctx_size: int | None = None,
                       autostart: bool | None = None) -> None:
    paths = _get_paths()
    state = _role_state(paths, role)
    if model_path is not None:
        state["model_path"] = model_path
    if ctx_size is not None:
        state["ctx_size"] = int(ctx_size)
    if autostart is not None:
        state["autostart"] = bool(autostart)
    _save_paths(paths)


def _wait_for_server(role: str, timeout: int = 120) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ready(role):
            return
        time.sleep(1.5)
    raise TimeoutError(f"llama-server ({role}) did not start within the timeout")


def start(role: str, model_path: str | None = None, ctx_size: int | None = None,
          n_gpu_layers: int = -1) -> None:
    """役割のサーバーを起動する。既に起動済みで同じモデルなら何もしない。"""
    if role not in ROLES:
        raise ValueError(f"Unknown role: {role}")

    paths = _get_paths()
    state = _role_state(paths, role)
    target_path = model_path or state.get("model_path", "")
    if not target_path:
        raise ValueError("モデルが設定されていません")
    target_ctx = int(ctx_size or state.get("ctx_size") or ROLES[role]["default_ctx"])

    if is_ready(role) and state.get("model_path") == target_path and int(state.get("ctx_size") or 0) == target_ctx:
        logger.info("llama-server (%s) already running: %s", role, Path(target_path).name)
        return

    stop(role)
    time.sleep(1)

    exe = _find_latest_exe()
    model_p = Path(target_path)
    if not model_p.exists():
        raise ValueError(f"Model file not found: {target_path}")

    mmproj_candidates = [f for f in model_p.parent.glob("*.gguf") if "mmproj" in f.name.lower()]

    cmd = [
        str(exe),
        "--model", str(model_p),
        "--host", "127.0.0.1",
        "--port", str(ROLES[role]["port"]),
        "--ctx-size", str(target_ctx),
        "--n-gpu-layers", str(n_gpu_layers),
        # チャットテンプレートによるツールコール解析と reasoning_content の分離に必須
        "--jinja",
        "--alias", model_p.stem,
    ]
    if mmproj_candidates:
        cmd += ["--mmproj", str(mmproj_candidates[0])]

    kwargs: dict = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE

    logger.info("Starting llama-server (%s): %s", role, model_p.name)
    proc = subprocess.Popen(cmd, cwd=exe.parent, **kwargs)
    time.sleep(1)
    if proc.poll() is not None:
        raise RuntimeError("llama-server exited immediately after launch")

    paths = _get_paths()
    state = _role_state(paths, role)
    state["model_path"] = str(model_p)
    state["ctx_size"] = target_ctx
    state["pid"] = proc.pid
    _save_paths(paths)

    _wait_for_server(role)
    logger.info("llama-server (%s) ready: %s", role, model_p.name)


def stop(role: str) -> None:
    paths = _get_paths()
    state = _role_state(paths, role)
    pid = state.get("pid")
    if pid:
        _kill_pid(pid)
        state["pid"] = None
        _save_paths(paths)


def stop_all() -> None:
    for role in ROLES:
        try:
            stop(role)
        except Exception:
            pass


def ensure_standard() -> None:
    """standard が「自動起動 ON」かつモデル設定済みのときだけ起動する。

    既定は自動起動しない（ノートPC 等では常駐させず、必要なときに手動起動 /
    要求時ロードする）。設定は roles.standard.autostart（マシン固有）。
    """
    try:
        paths = _get_paths()
        state = (paths.get("roles") or {}).get("standard", {})
        if state.get("model_path") and state.get("autostart"):
            start("standard")
    except Exception as e:
        logger.warning("ensure_standard failed: %s", e)
