"""llama-server lifecycle management (based on lm-chat's llama_manager.py)."""
from __future__ import annotations

import json
import logging
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib import request as urllib_request

logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
_PATHS_FILE = _ROOT / "data" / "llama_paths.json"
_BIN_DIR = _ROOT / "bin" / "llama-server"

LLAMA_PORT = 8080
LLAMA_BASE_URL = f"http://127.0.0.1:{LLAMA_PORT}"
DEFAULT_CTX_SIZE = 4096


def _find_latest_exe() -> Path:
    builds = sorted(
        [d for d in _BIN_DIR.iterdir() if d.is_dir()],
        key=lambda d: int(m.group(1)) if (m := re.search(r"b(\d+)", d.name)) else 0,
        reverse=True,
    )
    if not builds:
        raise RuntimeError("No llama-server builds found in bin/llama-server/")
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
    _PATHS_FILE.write_text(json.dumps(paths, indent=2, ensure_ascii=False), "utf-8")


def is_ready() -> bool:
    try:
        with urllib_request.urlopen(f"{LLAMA_BASE_URL}/health", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def get_status() -> dict:
    paths = _get_paths()
    model_path = paths.get("active_model_path", "")
    ctx_size = int(paths.get("ctx_size") or DEFAULT_CTX_SIZE)
    return {
        "loaded": is_ready(),
        "model_path": model_path,
        "model_name": Path(model_path).name if model_path else "",
        "ctx_size": ctx_size,
    }


def save_context_size(ctx_size: int) -> None:
    paths = _get_paths()
    paths["ctx_size"] = int(ctx_size)
    _save_paths(paths)


def _kill_running() -> None:
    paths = _get_paths()
    pid = paths.get("llama_server_pid")
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
    paths["llama_server_pid"] = None
    _save_paths(paths)


def _wait_for_server(timeout: int = 90) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ready():
            return
        time.sleep(1.5)
    raise TimeoutError("llama-server did not start within the timeout")


def load_model(model_path: str, ctx_size: int = DEFAULT_CTX_SIZE, n_gpu_layers: int = -1) -> None:
    _kill_running()
    time.sleep(1)

    exe = _find_latest_exe()
    model_p = Path(model_path)
    if not model_p.exists():
        raise ValueError(f"Model file not found: {model_path}")

    mmproj_candidates = [f for f in model_p.parent.glob("*.gguf") if "mmproj" in f.name.lower()]

    cmd = [
        str(exe),
        "--model", model_path,
        "--host", "127.0.0.1",
        "--port", str(LLAMA_PORT),
        "--ctx-size", str(ctx_size),
        "--n-gpu-layers", str(n_gpu_layers),
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
    paths["active_model_path"] = model_path
    paths["ctx_size"] = ctx_size
    paths["llama_server_pid"] = proc.pid
    _save_paths(paths)

    _wait_for_server()
    logger.info("llama-server ready (model: %s)", model_p.name)


def eject_model() -> None:
    logger.info("Ejecting model...")
    _kill_running()
    paths = _get_paths()
    paths["active_model_path"] = ""
    paths["llama_server_pid"] = None
    _save_paths(paths)
