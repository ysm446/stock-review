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
    ctx_size: int = llama.DEFAULT_CTX_SIZE
    n_gpu_layers: int = -1


class ModelSettingsRequest(BaseModel):
    ctx_size: int = llama.DEFAULT_CTX_SIZE


def _validate_ctx_size(ctx_size: int) -> int:
    allowed = {4096, 8192, 16384, 32768}
    if ctx_size not in allowed:
        raise HTTPException(400, "ctx_size must be one of 4096, 8192, 16384, 32768")
    return ctx_size


@app.get("/models")
def get_models():
    return _find_gguf_files()


@app.get("/model/status")
def model_status():
    return llama.get_status()


@app.post("/model/settings")
def model_settings(req: ModelSettingsRequest):
    llama.save_context_size(_validate_ctx_size(req.ctx_size))
    return llama.get_status()


@app.post("/model/load")
async def model_load(req: LoadModelRequest):
    try:
        ctx_size = _validate_ctx_size(req.ctx_size)
        await asyncio.to_thread(llama.load_model, req.model_path, ctx_size, req.n_gpu_layers)
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


@app.get("/documents/search")
def document_search(session_id: int, query: str, top_k: int = 3):
    return {"items": store.search_documents_for_session(session_id, query, top_k=top_k)}


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


@app.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    if not llama.is_ready():
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
    llm_messages = messages
    if req.system_prompt:
        llm_messages = [{"role": "system", "content": req.system_prompt}, *llm_messages]
    if context:
        llm_messages = [{"role": "system", "content": context}, *llm_messages]

    # Persist user message and auto-title on first turn
    user_message = None
    if user_content and req.persist_user:
        existing = await asyncio.to_thread(store.list_messages, req.session_id)
        is_first = len(existing) == 0
        user_message = await asyncio.to_thread(store.append_message, req.session_id, "user", user_content)
        if is_first:
            await asyncio.to_thread(store.rename_session, req.session_id, user_content[:28].strip())

    def generate():
        body = json.dumps({"model": "local", "messages": llm_messages, "stream": True}).encode()
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
