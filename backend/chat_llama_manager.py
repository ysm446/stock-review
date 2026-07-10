"""llama-server の管理（単一サーバー構成）。

起動直後は何もロードされていない。ユーザーがモデル設定から GGUF を選んで
ロードすると、その1台がチャット・ノート要約などすべての処理を担当する。

設定と PID は llama_paths.json に保存する:
  {"server": {"model_path": ..., "ctx_size": ..., "pid": ...}}
"""
from __future__ import annotations

import json
import logging
import re
import socket
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
PORT = 8091
DEFAULT_CTX = 16384

CTX_OPTIONS = (4096, 8192, 16384, 32768, 65536)


def base_url() -> str:
    return f"http://127.0.0.1:{PORT}"


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


def _server_state(paths: dict) -> dict:
    return paths.setdefault("server", {})


def migrate_legacy_state() -> None:
    """旧構成からの移行。

    - 役割ベース（roles.standard / roles.deep、2026-07 世代）: 稼働中のサーバーを
      止め、deep（無ければ standard）のモデル選択を単一サーバーへ引き継ぐ。
    - 旧・単一サーバー構成（:8080、active_model_path/llama_server_pid）: 同様に
      モデル選択を引き継ぐ。
    """
    paths = _get_paths()
    changed = False

    roles = paths.pop("roles", None)
    if isinstance(roles, dict):
        server = _server_state(paths)
        standard = roles.get("standard") or {}
        deep = roles.get("deep") or {}
        # 旧 standard は新構成と同じポート（8091）なので、稼働中ならそのまま引き継ぐ
        # （アップグレード直後にロード済みモデルを落とさない）。deep（8092）は停止する。
        _kill_pid(deep.get("pid"))
        if standard.get("pid") and is_ready():
            server["model_path"] = standard.get("model_path", "")
            if standard.get("ctx_size"):
                server["ctx_size"] = int(standard["ctx_size"])
            server["pid"] = standard["pid"]
            logger.info("Adopted running standard server as the single server")
        else:
            _kill_pid(standard.get("pid"))
            for state in (deep, standard):
                if state.get("model_path") and not server.get("model_path"):
                    server["model_path"] = state["model_path"]
                    if state.get("ctx_size"):
                        server["ctx_size"] = int(state["ctx_size"])
        changed = True
        logger.info("Migrated role-based llama state (deep/standard → server)")

    if "llama_server_pid" in paths or "active_model_path" in paths:
        legacy_pid = paths.pop("llama_server_pid", None)
        legacy_model = paths.pop("active_model_path", "")
        legacy_ctx = paths.pop("ctx_size", None)
        _kill_pid(legacy_pid)
        server = _server_state(paths)
        if legacy_model and not server.get("model_path"):
            server["model_path"] = legacy_model
            if legacy_ctx:
                server["ctx_size"] = int(legacy_ctx)
        changed = True
        logger.info("Migrated legacy llama state (:8080 → server)")

    if changed:
        _save_paths(paths)


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


def is_ready() -> bool:
    # まず素の TCP 接続で待ち受けの有無を確認する。Windows では待ち受けの無い
    # ポートへの SYN が拒否（RST）されずに破棄されることがあり、いきなり HTTP
    # プローブするとサーバー停止中は毎回タイムアウト（2秒）まで待たされるため。
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.3):
            pass
    except OSError:
        return False
    try:
        with urllib_request.urlopen(f"{base_url()}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def get_status() -> dict:
    paths = _get_paths()
    state = paths.get("server") or {}
    model_path = state.get("model_path", "")
    return {
        "ready": is_ready(),
        "port": PORT,
        "model_path": model_path,
        "model_name": Path(model_path).name if model_path else "",
        "ctx_size": int(state.get("ctx_size") or DEFAULT_CTX),
    }


def save_settings(model_path: str | None = None, ctx_size: int | None = None) -> None:
    paths = _get_paths()
    state = _server_state(paths)
    if model_path is not None:
        state["model_path"] = model_path
    if ctx_size is not None:
        state["ctx_size"] = int(ctx_size)
    _save_paths(paths)


def _wait_for_server(timeout: int = 120) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ready():
            return
        time.sleep(1.5)
    raise TimeoutError("llama-server did not start within the timeout")


def start(model_path: str | None = None, ctx_size: int | None = None,
          n_gpu_layers: int = -1) -> None:
    """サーバーを起動する。既に同じモデル・同じ ctx で起動済みなら何もしない。"""
    paths = _get_paths()
    state = _server_state(paths)
    target_path = model_path or state.get("model_path", "")
    if not target_path:
        raise ValueError("モデルが設定されていません")
    target_ctx = int(ctx_size or state.get("ctx_size") or DEFAULT_CTX)

    if is_ready() and state.get("model_path") == target_path and int(state.get("ctx_size") or 0) == target_ctx:
        logger.info("llama-server already running: %s", Path(target_path).name)
        return

    stop()
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
        "--port", str(PORT),
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

    logger.info("Starting llama-server: %s", model_p.name)
    proc = subprocess.Popen(cmd, cwd=exe.parent, **kwargs)
    time.sleep(1)
    if proc.poll() is not None:
        raise RuntimeError("llama-server exited immediately after launch")

    paths = _get_paths()
    state = _server_state(paths)
    state["model_path"] = str(model_p)
    state["ctx_size"] = target_ctx
    state["pid"] = proc.pid
    _save_paths(paths)

    _wait_for_server()
    logger.info("llama-server ready: %s", model_p.name)


def stop() -> None:
    paths = _get_paths()
    state = _server_state(paths)
    pid = state.get("pid")
    if pid:
        _kill_pid(pid)
        state["pid"] = None
        _save_paths(paths)


def stop_all() -> None:
    try:
        stop()
    except Exception:
        pass
