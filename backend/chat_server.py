"""Chat backend – FastAPI server (port 8001)."""
from __future__ import annotations

import asyncio
import importlib
import json
import logging
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Make backend/ importable when run as `python backend/chat_server.py`
sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import chat_store as store
import chat_llama_manager as llama
import chat_agent
import llm_client
import llama_updater
import embed_manager
from chat_embedder import warmup as embed_warmup

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = _ROOT / "models"


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db()
    llama.migrate_legacy_state()
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, embed_warmup)
    # standard（常駐モデル）が設定済みなら自動起動（時間がかかるためバックグラウンドで）
    loop.run_in_executor(None, llama.ensure_standard)
    yield
    try:
        llama.stop_all()
    except Exception:
        pass


app = FastAPI(lifespan=lifespan)
# Electron renderer は file:// 起点のため Origin は "null"。それ以外のオリジン
# （ブラウザ上の任意のサイト等）にはレスポンスを読ませない。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Electron main が起動時に生成するトークン。CORS だけでは外部サイトからの
# 書き込み系リクエスト自体は止められないため、全リクエストで検証する。
API_TOKEN = os.environ.get("STOCK_REVIEW_API_TOKEN", "")


@app.middleware("http")
async def _require_api_token(request: Request, call_next):
    if API_TOKEN and request.method != "OPTIONS" and request.url.path != "/health":
        if request.headers.get("x-api-token") != API_TOKEN:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# ── Health ────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


# ── System resource monitor ───────────────────────────────

_nvml_inited = False


def _get_psutil():
    try:
        import psutil
        return psutil
    except Exception:
        return None


def _get_pynvml():
    """Return an initialized pynvml module, or None when no NVIDIA GPU/driver."""
    global _nvml_inited
    try:
        import pynvml
    except Exception:
        return None
    if not _nvml_inited:
        try:
            pynvml.nvmlInit()
            _nvml_inited = True
        except Exception:
            return None
    return pynvml


def _venv_python() -> str:
    candidate = _ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return str(candidate) if candidate.exists() else sys.executable


@app.get("/system/resources")
def system_resources():
    psutil = _get_psutil()
    if psutil is None:
        return {"available": False, "cpu_percent": 0, "ram_used_gb": 0,
                "ram_total_gb": 0, "ram_percent": 0, "gpus": []}

    vm = psutil.virtual_memory()
    gpus = []
    pynvml = _get_pynvml()
    if pynvml is not None:
        try:
            for i in range(pynvml.nvmlDeviceGetCount()):
                handle = pynvml.nvmlDeviceGetHandleByIndex(i)
                name = pynvml.nvmlDeviceGetName(handle)
                util = pynvml.nvmlDeviceGetUtilizationRates(handle)
                mem = pynvml.nvmlDeviceGetMemoryInfo(handle)
                gpus.append({
                    "name": name if isinstance(name, str) else name.decode(),
                    "gpu_percent": util.gpu,
                    "vram_used_gb": round(mem.used / (1024 ** 3), 2),
                    "vram_total_gb": round(mem.total / (1024 ** 3), 2),
                    "vram_percent": round(mem.used / mem.total * 100, 1) if mem.total else 0,
                })
        except Exception:
            pass

    return {
        "available": True,
        "cpu_percent": psutil.cpu_percent(interval=None),
        "ram_used_gb": round(vm.used / (1024 ** 3), 2),
        "ram_total_gb": round(vm.total / (1024 ** 3), 2),
        "ram_percent": vm.percent,
        "gpus": gpus,
    }


@app.post("/system/install-deps")
def system_install_deps():
    """Install the resource-monitor dependencies into the venv (small, quick)."""
    cmd = [_venv_python(), "-m", "pip", "install", "psutil", "nvidia-ml-py"]
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=str(_ROOT))
    importlib.invalidate_caches()
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "pip install failed").strip()
        raise HTTPException(500, detail[-400:])
    return {"ok": True}


# ── Model management ──────────────────────────────────────

def _find_gguf_files() -> list[dict]:
    results = []
    for p in MODELS_DIR.rglob("*.gguf"):
        if not p.name.lower().startswith("mmproj"):
            results.append({
                "name": p.name,
                "path": str(p),
                "relative_path": str(p.relative_to(MODELS_DIR)),
            })
    return results


class RoleStartRequest(BaseModel):
    model_path: str | None = None
    ctx_size: int | None = None
    n_gpu_layers: int = -1


class RoleSettingsRequest(BaseModel):
    model_path: str | None = None
    ctx_size: int | None = None
    autostart: bool | None = None


def _validate_role(role: str) -> str:
    if role not in llama.ROLES:
        raise HTTPException(404, f"Unknown role: {role}")
    return role


def _validate_ctx_size(ctx_size: int | None) -> int | None:
    if ctx_size is None:
        return None
    if ctx_size not in llama.CTX_OPTIONS:
        raise HTTPException(400, f"ctx_size must be one of {sorted(llama.CTX_OPTIONS)}")
    return ctx_size


@app.get("/models")
def get_models():
    return _find_gguf_files()


@app.get("/llama/roles")
def llama_roles():
    return llama.get_roles_status()


@app.post("/llama/{role}/start")
async def llama_role_start(role: str, req: RoleStartRequest):
    _validate_role(role)
    try:
        await asyncio.to_thread(
            llama.start, role, req.model_path, _validate_ctx_size(req.ctx_size), req.n_gpu_layers
        )
        return llama.get_roles_status()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/llama/{role}/stop")
async def llama_role_stop(role: str):
    _validate_role(role)
    await asyncio.to_thread(llama.stop, role)
    return llama.get_roles_status()


@app.put("/llama/{role}/settings")
def llama_role_settings(role: str, req: RoleSettingsRequest):
    _validate_role(role)
    llama.save_role_settings(role, req.model_path, _validate_ctx_size(req.ctx_size), req.autostart)
    return llama.get_roles_status()


# ── llama-server runtime (download / update) ──────────────

class LlamaDownloadRequest(BaseModel):
    asset_name: str


@app.get("/llama/status")
def llama_status():
    return llama_updater.get_local_status()


@app.get("/llama/releases/latest")
async def llama_latest_release():
    try:
        return await asyncio.to_thread(llama_updater.fetch_latest_release)
    except Exception as e:
        raise HTTPException(502, f"リリース情報の取得に失敗しました: {e}")


@app.post("/llama/download")
def llama_download(req: LlamaDownloadRequest):
    def event_stream():
        try:
            for event in llama_updater.download_build(req.asset_name):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Embedding model (status / download) ───────────────────

@app.get("/embedding/status")
def embedding_status():
    return embed_manager.get_status()


@app.post("/embedding/download")
def embedding_download():
    def event_stream():
        try:
            for event in embed_manager.download():
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/embedding/install-deps")
def embedding_install_deps():
    def event_stream():
        try:
            for event in embed_manager.install_deps():
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Workspaces ────────────────────────────────────────────

class WorkspaceBody(BaseModel):
    name: str


class ReorderBody(BaseModel):
    ids: list[int]


class DocumentBody(BaseModel):
    title: str = "Untitled"
    content: str = ""


class NotesBody(BaseModel):
    content: str = ""


class MessageBody(BaseModel):
    content: str


class SessionBody(BaseModel):
    title: str = "New chat"


@app.get("/workspaces")
def get_workspaces():
    return store.list_workspaces()


@app.post("/workspaces", status_code=201)
def post_workspace(body: WorkspaceBody):
    return store.create_workspace(body.name)


@app.patch("/workspaces/reorder")
def patch_workspaces_reorder(body: ReorderBody):
    store.reorder_workspaces(body.ids)
    return {"ok": True}


@app.patch("/workspaces/{id}")
def patch_workspace(id: int, body: WorkspaceBody):
    store.rename_workspace(id, body.name)
    return {"ok": True}


@app.delete("/workspaces/{id}")
def del_workspace(id: int):
    store.delete_workspace(id)
    return {"ok": True}


# ── Documents ─────────────────────────────────────────────

@app.get("/stocks/{ticker}/workspace")
def get_stock_workspace(ticker: str):
    try:
        workspace = store.get_or_create_stock_workspace(ticker)
        notes = store.get_stock_notes(ticker)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "workspace": workspace,
        "sessions": store.list_sessions(int(workspace["id"])),
        "notes": notes,
    }


@app.get("/stocks/{ticker}/sessions")
def get_stock_sessions(ticker: str):
    try:
        return store.list_stock_sessions(ticker)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/stocks/{ticker}/sessions", status_code=201)
def post_stock_session(ticker: str, body: SessionBody):
    try:
        return store.create_stock_session(ticker, body.title)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/stocks/{ticker}/notes")
def get_stock_notes(ticker: str):
    return store.get_stock_notes(ticker)


@app.patch("/stocks/{ticker}/notes")
def patch_stock_notes(ticker: str, body: NotesBody):
    return store.save_stock_notes(ticker, body.content)


@app.get("/workspaces/{workspace_id}/documents")
def get_documents(workspace_id: int):
    return store.list_documents(workspace_id)


@app.post("/workspaces/{workspace_id}/documents", status_code=201)
def post_document(workspace_id: int, body: DocumentBody):
    return store.create_document(workspace_id, body.title, body.content)


# 注意: /documents/search は /documents/{id} より先に登録しないと {id} に飲まれて 422 になる
@app.get("/documents/search")
def document_search(session_id: int, query: str, top_k: int = 3):
    return {"items": store.search_documents_for_session(session_id, query, top_k=top_k)}


@app.get("/documents/{id}")
def get_document(id: int):
    doc = store.get_document(id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    return doc


@app.patch("/documents/{id}")
def patch_document(id: int, body: DocumentBody):
    try:
        return store.update_document(id, body.title, body.content)
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.delete("/documents/{id}")
def del_document(id: int):
    store.delete_document(id)
    return {"ok": True}


# ── Sessions ──────────────────────────────────────────────

class SessionBody(BaseModel):
    title: str = "新しい会話"


@app.get("/workspaces/{workspace_id}/sessions")
def get_sessions(workspace_id: int):
    return store.list_sessions(workspace_id)


@app.post("/workspaces/{workspace_id}/sessions", status_code=201)
def post_session(workspace_id: int, body: SessionBody):
    return store.create_session(workspace_id, body.title)


@app.patch("/workspaces/{workspace_id}/sessions/reorder")
def patch_sessions_reorder(workspace_id: int, body: ReorderBody):
    store.reorder_sessions(workspace_id, body.ids)
    return {"ok": True}


@app.patch("/sessions/{id}")
def patch_session(id: int, body: SessionBody):
    store.rename_session(id, body.title)
    return {"ok": True}


@app.delete("/sessions/{id}")
def del_session(id: int):
    store.delete_session(id)
    return {"ok": True}


# ── Messages ──────────────────────────────────────────────

@app.get("/sessions/{session_id}/messages")
def get_messages(session_id: int):
    return store.list_messages(session_id)


@app.patch("/messages/{id}")
def patch_message(id: int, body: MessageBody):
    try:
        return store.update_message(id, body.content)
    except ValueError:
        raise HTTPException(404, "Message not found")


@app.delete("/messages/{id}")
def del_message(id: int):
    session_id = store.delete_message(id)
    if session_id is None:
        raise HTTPException(404, "Message not found")
    return {"ok": True, "session_id": session_id}


@app.delete("/messages/{id}/from")
def del_messages_from(id: int):
    session_id = store.delete_messages_from(id)
    if session_id is None:
        raise HTTPException(404, "Message not found")
    return {"ok": True, "session_id": session_id}


@app.delete("/messages/{id}/after")
def del_messages_after(id: int):
    session_id = store.delete_messages_after(id)
    if session_id is None:
        raise HTTPException(404, "Message not found")
    return {"ok": True, "session_id": session_id}


# ── Memory ────────────────────────────────────────────────

@app.get("/memory/search")
def memory_search(session_id: int, query: str, top_k: int = 5, half_life_days: int = 30):
    items = store.search_memory_for_session(
        session_id,
        query,
        top_k=top_k,
        half_life_days=half_life_days,
    )
    return {"items": items}


@app.get("/memory/stats")
def memory_stats():
    return store.memory_stats()


# ── Chat streaming ────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    session_id: int
    messages: list[ChatMessage]
    persist_user: bool = True
    persist_assistant: bool = True
    system_prompt: str | None = None


def _summary_base_url() -> str | None:
    """要約など背景処理は standard（軽量モデル）優先。無ければチャット用にフォールバック。"""
    if llama.is_ready("standard"):
        return llama.role_base_url("standard")
    return llama.chat_base_url()


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """ツール無しの単発ストリーム（銘柄ノート要約などの背景処理用）。

    standard 役割を優先し、思考（thinking）は無効化して高速に返す。
    """
    base_url = _summary_base_url()
    if not base_url:
        raise HTTPException(503, "モデルが読み込まれていません")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    user_content = messages[-1]["content"] if messages and messages[-1]["role"] == "user" else ""
    context = ""
    if user_content:
        context = await asyncio.to_thread(
            store.build_combined_context,
            req.session_id,
            user_content,
        )
    # system メッセージは1つに結合（Qwen3 系は複数で 400）
    system_parts = [part for part in (req.system_prompt or "", context) if part]
    llm_messages = messages
    if system_parts:
        llm_messages = [{"role": "system", "content": "\n\n".join(system_parts)}, *messages]

    # Persist user message and auto-title on first turn
    user_message = None
    if user_content and req.persist_user:
        existing = await asyncio.to_thread(store.list_messages, req.session_id)
        is_first = len(existing) == 0
        user_message = await asyncio.to_thread(store.append_message, req.session_id, "user", user_content)
        if is_first:
            await asyncio.to_thread(store.rename_session, req.session_id, user_content[:28].strip())

    def generate():
        accumulated = ""
        try:
            for kind, data in llm_client.chat_stream(
                base_url, llm_messages, max_tokens=4096, enable_thinking=False
            ):
                if kind == "content":
                    accumulated += data
                    yield f"data: {json.dumps({'type': 'token', 'content': data}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
            return

        assistant_message = None
        if accumulated and req.persist_assistant:
            assistant_message = store.append_message(req.session_id, "assistant", accumulated)
            if user_content:
                store.save_turn_memory(req.session_id, user_content, accumulated)

        yield f"data: {json.dumps({'type': 'done', 'message': assistant_message, 'user_message': user_message})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/chat/agent-stream")
async def chat_agent_stream(req: ChatRequest):
    """ツール（Web検索・ニュース検索・銘柄指標）を使うエージェンティックチャット。

    deep 役割を優先し、落ちていれば standard で応答する（使用モデルは model イベントで通知）。
    """
    chat_role = llama.chat_role()
    if chat_role is None:
        raise HTTPException(503, "モデルが読み込まれていません")
    base_url = llama.role_base_url(chat_role)
    status = llama.get_roles_status()
    model_name = status["roles"][chat_role]["model_name"]

    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    user_content = messages[-1]["content"] if messages and messages[-1]["role"] == "user" else ""
    context = ""
    if user_content:
        context = await asyncio.to_thread(
            store.build_combined_context,
            req.session_id,
            user_content,
        )

    # Qwen3 系テンプレートは system メッセージが複数あると 400 を返すため、必ず1つに結合する
    system_parts = [
        part for part in (req.system_prompt or "", chat_agent.AGENT_SYSTEM_PROMPT, context) if part
    ]
    llm_messages = [{"role": "system", "content": "\n\n".join(system_parts)}, *messages]

    user_message = None
    if user_content and req.persist_user:
        existing = await asyncio.to_thread(store.list_messages, req.session_id)
        is_first = len(existing) == 0
        user_message = await asyncio.to_thread(store.append_message, req.session_id, "user", user_content)
        if is_first:
            await asyncio.to_thread(store.rename_session, req.session_id, user_content[:28].strip())

    def generate():
        final_text = ""
        yield f"data: {json.dumps({'type': 'model', 'name': model_name, 'role': chat_role}, ensure_ascii=False)}\n\n"
        try:
            for event in chat_agent.run_chat_agent(llm_messages, base_url=base_url):
                if event.get("type") == "_final":
                    final_text = event.get("content") or ""
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
            return

        assistant_message = None
        if final_text and req.persist_assistant:
            assistant_message = store.append_message(req.session_id, "assistant", final_text)
            if user_content:
                store.save_turn_memory(req.session_id, user_content, final_text)

        yield f"data: {json.dumps({'type': 'done', 'message': assistant_message, 'user_message': user_message}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
