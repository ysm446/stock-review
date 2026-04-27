"""Chat backend – FastAPI server (port 8001)."""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Make backend/ importable when run as `python backend/chat_server.py`
sys.path.insert(0, str(Path(__file__).parent))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from urllib import request as urllib_request

import chat_store as store
import chat_llama_manager as llama
from chat_embedder import warmup as embed_warmup

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger(__name__)

_ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = _ROOT / "models"


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.init_db()
    asyncio.get_event_loop().run_in_executor(None, embed_warmup)
    yield
    try:
        llama.eject_model()
    except Exception:
        pass


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health ────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok"}


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


class LoadModelRequest(BaseModel):
    model_path: str
    ctx_size: int = 4096
    n_gpu_layers: int = -1


@app.get("/models")
def get_models():
    return _find_gguf_files()


@app.get("/model/status")
def model_status():
    return llama.get_status()


@app.post("/model/load")
async def model_load(req: LoadModelRequest):
    try:
        await asyncio.to_thread(llama.load_model, req.model_path, req.ctx_size, req.n_gpu_layers)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/model/unload")
async def model_unload():
    await asyncio.to_thread(llama.eject_model)
    return {"ok": True}


# ── Workspaces ────────────────────────────────────────────

class WorkspaceBody(BaseModel):
    name: str


@app.get("/workspaces")
def get_workspaces():
    return store.list_workspaces()


@app.post("/workspaces", status_code=201)
def post_workspace(body: WorkspaceBody):
    return store.create_workspace(body.name)


@app.patch("/workspaces/{id}")
def patch_workspace(id: int, body: WorkspaceBody):
    store.rename_workspace(id, body.name)
    return {"ok": True}


@app.delete("/workspaces/{id}")
def del_workspace(id: int):
    store.delete_workspace(id)
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


# ── Chat streaming ────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    session_id: int
    messages: list[ChatMessage]


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    if not llama.is_ready():
        raise HTTPException(503, "モデルが読み込まれていません")

    messages = [{"role": m.role, "content": m.content} for m in req.messages]

    # Persist user message and auto-title on first turn
    if messages and messages[-1]["role"] == "user":
        user_content = messages[-1]["content"]
        existing = await asyncio.to_thread(store.list_messages, req.session_id)
        is_first = len(existing) == 0
        await asyncio.to_thread(store.append_message, req.session_id, "user", user_content)
        if is_first:
            await asyncio.to_thread(store.rename_session, req.session_id, user_content[:28].strip())

    async def generate():
        body = json.dumps({"model": "local", "messages": messages, "stream": True}).encode()
        http_req = urllib_request.Request(
            f"{llama.LLAMA_BASE_URL}/v1/chat/completions",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        accumulated = ""
        try:
            with urllib_request.urlopen(http_req, timeout=120) as resp:
                for raw_line in resp:
                    line = raw_line.decode("utf-8").strip()
                    if not line.startswith("data: "):
                        continue
                    payload = line[6:]
                    if payload == "[DONE]":
                        break
                    try:
                        data = json.loads(payload)
                        chunk = data["choices"][0]["delta"].get("content", "")
                        if chunk:
                            accumulated += chunk
                            yield f"data: {json.dumps({'type': 'token', 'content': chunk})}\n\n"
                    except Exception:
                        pass
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            return

        if accumulated:
            await asyncio.to_thread(store.append_message, req.session_id, "assistant", accumulated)

        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
