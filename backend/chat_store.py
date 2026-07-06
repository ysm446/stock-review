from __future__ import annotations

import logging
import math
import re
import sqlite3
import struct
import time
import uuid
from pathlib import Path

from shared import atomic_write_text
from paths import CHAT_DB_FILE as DB_PATH, DATA_DIR, STOCKS_DIR

EMBED_DIM = 768

logger = logging.getLogger(__name__)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
    except Exception as e:
        logger.debug("sqlite-vec unavailable: %s", e)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _now() -> int:
    return int(time.time() * 1000)


def _new_memory_id() -> str:
    return f"mem_{uuid.uuid4().hex}"


def _new_document_chunk_id() -> str:
    return f"dc_{uuid.uuid4().hex}"


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def _ensure_default_workspace(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM workspaces ORDER BY id LIMIT 1").fetchone()
    if row:
        return int(row["id"])

    now = _now()
    cur = conn.execute(
        "INSERT INTO workspaces (name, sort_order, created_at, updated_at) VALUES (?, 0, ?, ?)",
        ("デフォルト", now, now),
    )
    return int(cur.lastrowid)


def _ensure_messages_schema(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "messages")
    if not columns:
        conn.execute("""
            CREATE TABLE messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role       TEXT    NOT NULL,
                content    TEXT    NOT NULL,
                created_at INTEGER NOT NULL
            )
        """)
        return

    if "session_id" in columns:
        return

    if "conversation_id" not in columns:
        raise RuntimeError("Unsupported chat messages schema")

    workspace_id = _ensure_default_workspace(conn)
    if "conversations" in {
        row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }:
        conn.execute("""
            INSERT OR IGNORE INTO sessions (id, workspace_id, title, sort_order, created_at, updated_at)
            SELECT id, ?, title, 0, created_at, updated_at FROM conversations
        """, (workspace_id,))

    conn.execute("ALTER TABLE messages RENAME TO messages_legacy")
    conn.execute("""
        CREATE TABLE messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role       TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        INSERT INTO messages (id, session_id, role, content, created_at)
        SELECT id, conversation_id, role, content, created_at FROM messages_legacy
        WHERE conversation_id IN (SELECT id FROM sessions)
    """)
    conn.execute("DROP TABLE messages_legacy")


def _ensure_memory_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_chunks (
            id           TEXT PRIMARY KEY,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            session_id   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            chunk_type   TEXT    NOT NULL DEFAULT 'qa',
            content      TEXT    NOT NULL,
            created_at   INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            id UNINDEXED,
            content,
            tokenize='trigram'
        );
        CREATE INDEX IF NOT EXISTS idx_memory_chunks_workspace ON memory_chunks(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_memory_chunks_session ON memory_chunks(session_id);
    """)
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[{EMBED_DIM}])"
        )
    except Exception as e:
        logger.warning("memory_vec unavailable; vector memory search disabled: %s", e)


def _ensure_documents_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS workspace_documents (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title        TEXT    NOT NULL DEFAULT 'Untitled',
            content      TEXT    NOT NULL DEFAULT '',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_documents_ws ON workspace_documents(workspace_id);
        CREATE TABLE IF NOT EXISTS document_chunks (
            id           TEXT PRIMARY KEY,
            document_id  INTEGER NOT NULL REFERENCES workspace_documents(id) ON DELETE CASCADE,
            workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            chunk_index  INTEGER NOT NULL DEFAULT 0,
            content      TEXT    NOT NULL,
            created_at   INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
            id UNINDEXED,
            content,
            tokenize='trigram'
        );
        CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id);
        CREATE INDEX IF NOT EXISTS idx_document_chunks_ws ON document_chunks(workspace_id);
    """)
    try:
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS document_vec USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[{EMBED_DIM}])"
        )
    except Exception as e:
        logger.warning("document_vec unavailable; vector document search disabled: %s", e)


def _ensure_workspace_scope_schema(conn: sqlite3.Connection) -> None:
    columns = _table_columns(conn, "workspaces")
    if "scope" not in columns:
        conn.execute("ALTER TABLE workspaces ADD COLUMN scope TEXT NOT NULL DEFAULT 'general'")
    if "ticker" not in columns:
        conn.execute("ALTER TABLE workspaces ADD COLUMN ticker TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspaces_scope ON workspaces(scope)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspaces_ticker ON workspaces(ticker)")


def init_db() -> None:
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS workspaces (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                name       TEXT    NOT NULL DEFAULT '新しいワークスペース',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                title        TEXT    NOT NULL DEFAULT '新しい会話',
                sort_order   INTEGER NOT NULL DEFAULT 0,
                created_at   INTEGER NOT NULL,
                updated_at   INTEGER NOT NULL
            );
        """)
        _ensure_workspace_scope_schema(conn)
        _ensure_messages_schema(conn)
        _ensure_memory_schema(conn)
        _ensure_documents_schema(conn)
        conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_sessions_ws  ON sessions(workspace_id);
            CREATE INDEX IF NOT EXISTS idx_messages_ses ON messages(session_id);
        """)
        cur = conn.execute("SELECT COUNT(*) FROM workspaces")
        if cur.fetchone()[0] == 0:
            now = _now()
            conn.execute(
                "INSERT INTO workspaces (name, sort_order, created_at, updated_at) VALUES (?, 0, ?, ?)",
                ("デフォルト", now, now),
            )


# ── Workspaces ────────────────────────────────────────────

def list_workspaces() -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM workspaces WHERE scope = 'general' ORDER BY sort_order, created_at"
        )]


def create_workspace(name: str = "新しいワークスペース") -> dict:
    now = _now()
    with _connect() as conn:
        sort_order = conn.execute(
            "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM workspaces WHERE scope = 'general'"
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO workspaces (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (name, sort_order, now, now),
        )
        return {"id": cur.lastrowid, "name": name, "sort_order": sort_order, "created_at": now, "updated_at": now}


def rename_workspace(id: int, name: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?", (name, _now(), id))


def delete_workspace(id: int) -> None:
    with _connect() as conn:
        delete_workspace_memory(id, conn)
        conn.execute("DELETE FROM workspaces WHERE id = ?", (id,))


def reorder_workspaces(ids: list[int]) -> None:
    with _connect() as conn:
        for index, workspace_id in enumerate(ids):
            conn.execute(
                "UPDATE workspaces SET sort_order = ? WHERE id = ?",
                (index, workspace_id),
            )


# ── Documents ─────────────────────────────────────────────

def normalize_stock_ticker(ticker: str) -> str:
    return str(ticker or "").strip().upper()


def _stock_dir_name(ticker: str) -> str:
    safe = re.sub(r"[^A-Z0-9._-]+", "_", normalize_stock_ticker(ticker))
    return safe.strip("._-") or "UNKNOWN"


def get_or_create_stock_workspace(ticker: str, name: str | None = None) -> dict:
    normalized = normalize_stock_ticker(ticker)
    if not normalized:
        raise ValueError("Ticker is required")

    now = _now()
    label = name or f"Stock: {normalized}"
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM workspaces WHERE scope = 'stock' AND ticker = ? LIMIT 1",
            (normalized,),
        ).fetchone()
        if row:
            return dict(row)

        cur = conn.execute(
            """
            INSERT INTO workspaces (name, scope, ticker, sort_order, created_at, updated_at)
            VALUES (?, 'stock', ?, 0, ?, ?)
            """,
            (label, normalized, now, now),
        )
        return {
            "id": cur.lastrowid,
            "name": label,
            "scope": "stock",
            "ticker": normalized,
            "sort_order": 0,
            "created_at": now,
            "updated_at": now,
        }


def list_stock_sessions(ticker: str) -> list[dict]:
    workspace = get_or_create_stock_workspace(ticker)
    return list_sessions(int(workspace["id"]))


def create_stock_session(ticker: str, title: str = "New chat") -> dict:
    workspace = get_or_create_stock_workspace(ticker)
    return create_session(int(workspace["id"]), title)


def stock_notes_path(ticker: str) -> Path:
    return STOCKS_DIR / _stock_dir_name(ticker) / "notes.md"


def get_stock_notes(ticker: str) -> dict:
    normalized = normalize_stock_ticker(ticker)
    path = stock_notes_path(normalized)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("", encoding="utf-8")
    content = path.read_text(encoding="utf-8") if path.exists() else ""
    return {
        "ticker": normalized,
        "content": content,
        "path": str(path),
        "relative_path": str(path.relative_to(DATA_DIR)),
    }


def save_stock_notes(ticker: str, content: str) -> dict:
    normalized = normalize_stock_ticker(ticker)
    path = stock_notes_path(normalized)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, content or "")
    return get_stock_notes(normalized)


def list_documents(workspace_id: int) -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            """
            SELECT id, workspace_id, title, sort_order, created_at, updated_at
            FROM workspace_documents
            WHERE workspace_id = ?
            ORDER BY updated_at DESC
            """,
            (workspace_id,),
        )]


def get_document(id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM workspace_documents WHERE id = ?",
            (id,),
        ).fetchone()
        return dict(row) if row else None


def create_document(workspace_id: int, title: str = "Untitled", content: str = "") -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO workspace_documents (workspace_id, title, content, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
            """,
            (workspace_id, title, content, now, now),
        )
        doc = {
            "id": cur.lastrowid,
            "workspace_id": workspace_id,
            "title": title,
            "content": content,
            "sort_order": 0,
            "created_at": now,
            "updated_at": now,
        }
    index_document(doc["id"])
    return doc


def update_document(id: int, title: str, content: str) -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE workspace_documents SET title = ?, content = ?, updated_at = ? WHERE id = ?",
            (title, content, now, id),
        )
        if cur.rowcount == 0:
            raise ValueError("Document not found")
    doc = get_document(id)
    if doc is None:
        raise ValueError("Document not found")
    index_document(id)
    return doc


def delete_document(id: int) -> None:
    with _connect() as conn:
        delete_document_index(id, conn)
        conn.execute("DELETE FROM workspace_documents WHERE id = ?", (id,))


def split_document_text(text: str, target_chars: int = 800, max_chars: int = 1000, overlap: int = 100) -> list[str]:
    text = (text or "").strip()
    if not text:
        return []

    chunks: list[str] = []
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    current = ""
    for para in paragraphs or [text]:
        candidate = f"{current}\n\n{para}".strip() if current else para
        if len(candidate) <= target_chars:
            current = candidate
            continue
        if current:
            chunks.extend(_split_long_document_chunk(current, max_chars, overlap))
        current = para
    if current:
        chunks.extend(_split_long_document_chunk(current, max_chars, overlap))
    return chunks


def _split_long_document_chunk(text: str, max_chars: int, overlap: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        split_at = max(text.rfind("\n", start, end), text.rfind("。", start, end), text.rfind(". ", start, end))
        if split_at <= start + max_chars // 2:
            split_at = end
        else:
            split_at += 1
        chunk = text[start:split_at].strip()
        if chunk:
            chunks.append(chunk)
        if split_at >= len(text):
            break
        start = max(0, split_at - overlap)
    return chunks


def delete_document_index(document_id: int, conn: sqlite3.Connection | None = None) -> None:
    owns_conn = conn is None
    if conn is None:
        conn = _connect()
    try:
        chunk_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM document_chunks WHERE document_id = ?", (document_id,))
        ]
        if chunk_ids:
            placeholders = ",".join("?" * len(chunk_ids))
            conn.execute(f"DELETE FROM document_fts WHERE id IN ({placeholders})", chunk_ids)
            try:
                conn.execute(f"DELETE FROM document_vec WHERE chunk_id IN ({placeholders})", chunk_ids)
            except sqlite3.OperationalError:
                pass
            conn.execute(f"DELETE FROM document_chunks WHERE id IN ({placeholders})", chunk_ids)
    finally:
        if owns_conn:
            conn.close()


def index_document(document_id: int) -> int:
    from chat_embedder import embed

    doc = get_document(document_id)
    if doc is None:
        return 0
    chunks = split_document_text(doc.get("content", ""))
    now = _now()
    with _connect() as conn:
        delete_document_index(document_id, conn)
        for index, text in enumerate(chunks):
            chunk_id = _new_document_chunk_id()
            conn.execute(
                """
                INSERT INTO document_chunks (id, document_id, workspace_id, chunk_index, content, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (chunk_id, document_id, doc["workspace_id"], index, text, now),
            )
            conn.execute("INSERT INTO document_fts (id, content) VALUES (?, ?)", (chunk_id, text))
            try:
                vector = embed(text)
                vec_bytes = struct.pack(f"{len(vector)}f", *vector)
                conn.execute(
                    "INSERT INTO document_vec (chunk_id, embedding) VALUES (?, ?)",
                    (chunk_id, vec_bytes),
                )
            except Exception as e:
                logger.warning("Document vector index failed: %s", e)
    return len(chunks)


# ── Sessions ──────────────────────────────────────────────

def list_sessions(workspace_id: int) -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY sort_order ASC, updated_at DESC",
            (workspace_id,),
        )]


def create_session(workspace_id: int, title: str = "新しい会話") -> dict:
    now = _now()
    with _connect() as conn:
        sort_order = conn.execute(
            "SELECT COALESCE(MIN(sort_order), 0) - 1 FROM sessions WHERE workspace_id = ?",
            (workspace_id,),
        ).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO sessions (workspace_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (workspace_id, title, sort_order, now, now),
        )
        return {
            "id": cur.lastrowid, "workspace_id": workspace_id,
            "title": title, "sort_order": sort_order, "created_at": now, "updated_at": now,
        }


def rename_session(id: int, title: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, _now(), id))


def delete_session(id: int) -> None:
    with _connect() as conn:
        delete_session_memory(id, conn)
        conn.execute("DELETE FROM sessions WHERE id = ?", (id,))


def reorder_sessions(workspace_id: int, ids: list[int]) -> None:
    with _connect() as conn:
        for index, session_id in enumerate(ids):
            conn.execute(
                """
                UPDATE sessions
                SET workspace_id = ?, sort_order = ?
                WHERE id = ?
                """,
                (workspace_id, index, session_id),
            )


# ── Messages ──────────────────────────────────────────────

def list_messages(session_id: int) -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at, id",
            (session_id,),
        )]


def append_message(session_id: int, role: str, content: str) -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, now),
        )
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
        return {"id": cur.lastrowid, "created_at": now}


def get_message(id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE id = ?",
            (id,),
        ).fetchone()
        return dict(row) if row else None


def update_message(id: int, content: str) -> dict:
    now = _now()
    with _connect() as conn:
        row = conn.execute(
            "SELECT session_id, role, created_at FROM messages WHERE id = ?",
            (id,),
        ).fetchone()
        if not row:
            raise ValueError("Message not found")
        conn.execute("UPDATE messages SET content = ? WHERE id = ?", (content, id))
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, row["session_id"]))
        return {
            "id": id,
            "session_id": row["session_id"],
            "role": row["role"],
            "content": content,
            "created_at": row["created_at"],
        }


def delete_message(id: int) -> int | None:
    now = _now()
    with _connect() as conn:
        row = conn.execute("SELECT session_id FROM messages WHERE id = ?", (id,)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM messages WHERE id = ?", (id,))
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, row["session_id"]))
        return int(row["session_id"])


def delete_messages_from(id: int) -> int | None:
    now = _now()
    with _connect() as conn:
        row = conn.execute(
            "SELECT session_id, created_at FROM messages WHERE id = ?",
            (id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            """
            DELETE FROM messages
            WHERE session_id = ?
              AND (created_at > ? OR (created_at = ? AND id >= ?))
            """,
            (row["session_id"], row["created_at"], row["created_at"], id),
        )
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, row["session_id"]))
        return int(row["session_id"])


def delete_messages_after(id: int) -> int | None:
    now = _now()
    with _connect() as conn:
        row = conn.execute(
            "SELECT session_id, created_at FROM messages WHERE id = ?",
            (id,),
        ).fetchone()
        if not row:
            return None
        conn.execute(
            """
            DELETE FROM messages
            WHERE session_id = ?
              AND (created_at > ? OR (created_at = ? AND id > ?))
            """,
            (row["session_id"], row["created_at"], row["created_at"], id),
        )
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, row["session_id"]))
        return int(row["session_id"])


# ── Memory ────────────────────────────────────────────────

def _get_session_workspace(conn: sqlite3.Connection, session_id: int) -> int | None:
    row = conn.execute("SELECT workspace_id FROM sessions WHERE id = ?", (session_id,)).fetchone()
    return int(row["workspace_id"]) if row else None


def get_session_workspace(session_id: int) -> int | None:
    with _connect() as conn:
        return _get_session_workspace(conn, session_id)


def _delete_memory_ids(conn: sqlite3.Connection, chunk_ids: list[str]) -> None:
    if not chunk_ids:
        return
    placeholders = ",".join("?" * len(chunk_ids))
    conn.execute(f"DELETE FROM memory_fts WHERE id IN ({placeholders})", chunk_ids)
    try:
        conn.execute(f"DELETE FROM memory_vec WHERE chunk_id IN ({placeholders})", chunk_ids)
    except sqlite3.OperationalError:
        pass


def delete_session_memory(session_id: int, conn: sqlite3.Connection | None = None) -> int:
    owns_conn = conn is None
    if conn is None:
        conn = _connect()
    try:
        chunk_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM memory_chunks WHERE session_id = ?", (session_id,))
        ]
        _delete_memory_ids(conn, chunk_ids)
        cur = conn.execute("DELETE FROM memory_chunks WHERE session_id = ?", (session_id,))
        return cur.rowcount
    finally:
        if owns_conn:
            conn.close()


def delete_workspace_memory(workspace_id: int, conn: sqlite3.Connection | None = None) -> int:
    owns_conn = conn is None
    if conn is None:
        conn = _connect()
    try:
        chunk_ids = [
            row["id"]
            for row in conn.execute("SELECT id FROM memory_chunks WHERE workspace_id = ?", (workspace_id,))
        ]
        _delete_memory_ids(conn, chunk_ids)
        cur = conn.execute("DELETE FROM memory_chunks WHERE workspace_id = ?", (workspace_id,))
        return cur.rowcount
    finally:
        if owns_conn:
            conn.close()


def save_turn_memory(session_id: int, user_content: str, assistant_content: str) -> dict | None:
    content = f"Q: {user_content.strip()}\nA: {assistant_content.strip()}".strip()
    if not content:
        return None

    from chat_embedder import embed

    now = _now()
    chunk_id = _new_memory_id()
    with _connect() as conn:
        workspace_id = _get_session_workspace(conn, session_id)
        if workspace_id is None:
            return None

        conn.execute(
            """
            INSERT INTO memory_chunks (id, workspace_id, session_id, chunk_type, content, created_at)
            VALUES (?, ?, ?, 'qa', ?, ?)
            """,
            (chunk_id, workspace_id, session_id, content, now),
        )
        conn.execute("INSERT INTO memory_fts (id, content) VALUES (?, ?)", (chunk_id, content))

        try:
            vector = embed(content)
            vec_bytes = struct.pack(f"{len(vector)}f", *vector)
            conn.execute(
                "INSERT INTO memory_vec (chunk_id, embedding) VALUES (?, ?)",
                (chunk_id, vec_bytes),
            )
        except Exception as e:
            logger.warning("Memory vector index failed: %s", e)

    return {"id": chunk_id, "created_at": now}


def search_memory(
    workspace_id: int,
    query: str,
    top_k: int = 5,
    exclude_session_id: int | None = None,
    half_life_days: int = 30,
) -> list[dict]:
    query = query.strip()
    if not query or top_k <= 0:
        return []

    rrf_k = 60
    half_life_days = max(0, int(half_life_days))
    scores: dict[str, float] = {}

    with _connect() as conn:
        session_filter = ""
        session_params: list[int] = []
        if exclude_session_id is not None:
            session_filter = " AND mc.session_id != ?"
            session_params.append(exclude_session_id)

        safe_query = '"' + query.replace('"', ' ') + '"'
        try:
            rows = conn.execute(
                """
                SELECT mc.id FROM memory_fts mf
                JOIN memory_chunks mc ON mc.id = mf.id
                WHERE mf.content MATCH ? AND mc.workspace_id = ?
                """ + session_filter + """
                ORDER BY mf.rank
                LIMIT ?
                """,
                (safe_query, workspace_id, *session_params, top_k * 4),
            ).fetchall()
            for rank, row in enumerate(rows):
                scores[row["id"]] = scores.get(row["id"], 0.0) + 1.0 / (rrf_k + rank + 1)
        except Exception as e:
            logger.warning("FTS5 memory search failed: %s", e)

        try:
            from chat_embedder import embed
            query_vec = embed(query)
            vec_bytes = struct.pack(f"{len(query_vec)}f", *query_vec)
            vec_rows = conn.execute(
                "SELECT chunk_id, distance FROM memory_vec WHERE embedding MATCH ? AND k = ?",
                (vec_bytes, top_k * 4),
            ).fetchall()
            if vec_rows:
                vec_ids = [row["chunk_id"] for row in vec_rows]
                placeholders = ",".join("?" * len(vec_ids))
                allowed = {
                    row["id"]
                    for row in conn.execute(
                        f"""
                        SELECT mc.id FROM memory_chunks mc
                        WHERE mc.id IN ({placeholders}) AND mc.workspace_id = ?
                        """ + session_filter,
                        (*vec_ids, workspace_id, *session_params),
                    )
                }
                for rank, row in enumerate(vec_rows):
                    if row["chunk_id"] in allowed:
                        scores[row["chunk_id"]] = scores.get(row["chunk_id"], 0.0) + 1.0 / (rrf_k + rank + 1)
        except Exception as e:
            logger.warning("Vector memory search failed: %s", e)

        if not scores:
            return []

        ids = list(scores.keys())
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"""
            SELECT id, workspace_id, session_id, chunk_type, content, created_at
            FROM memory_chunks
            WHERE id IN ({placeholders})
            """,
            ids,
        ).fetchall()

    now = _now()
    chunks = {row["id"]: dict(row) for row in rows}

    def decayed_score(chunk_id: str) -> float:
        row = chunks.get(chunk_id)
        if not row:
            return 0.0
        if half_life_days <= 0:
            decay = 1.0
        else:
            days_elapsed = max(0.0, (now - int(row["created_at"])) / 86_400_000)
            decay = math.pow(0.5, days_elapsed / half_life_days)
        row["score"] = scores[chunk_id] * decay
        row["base_score"] = scores[chunk_id]
        row["decay"] = decay
        return row["score"]

    ranked_ids = sorted(scores.keys(), key=decayed_score, reverse=True)[:top_k]
    return [chunks[cid] for cid in ranked_ids if cid in chunks]


def search_memory_for_session(
    session_id: int,
    query: str,
    top_k: int = 5,
    half_life_days: int = 30,
) -> list[dict]:
    workspace_id = get_session_workspace(session_id)
    if workspace_id is None:
        return []
    return search_memory(
        workspace_id,
        query,
        top_k=top_k,
        exclude_session_id=session_id,
        half_life_days=half_life_days,
    )


def memory_stats() -> dict:
    with _connect() as conn:
        return {
            "memory_chunk_count": conn.execute("SELECT COUNT(*) FROM memory_chunks").fetchone()[0],
            "memory_fts_count": conn.execute("SELECT COUNT(*) FROM memory_fts").fetchone()[0],
            "memory_vec_count": _safe_count(conn, "memory_vec"),
            "document_count": conn.execute("SELECT COUNT(*) FROM workspace_documents").fetchone()[0],
            "document_chunk_count": conn.execute("SELECT COUNT(*) FROM document_chunks").fetchone()[0],
            "document_fts_count": conn.execute("SELECT COUNT(*) FROM document_fts").fetchone()[0],
            "document_vec_count": _safe_count(conn, "document_vec"),
        }


def _safe_count(conn: sqlite3.Connection, table: str) -> int:
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    except sqlite3.OperationalError:
        return 0


def build_memory_context(
    session_id: int,
    query: str,
    top_k: int = 5,
    max_chars: int = 1500,
    half_life_days: int = 30,
) -> str:
    with _connect() as conn:
        workspace_id = _get_session_workspace(conn, session_id)
    if workspace_id is None:
        return ""

    items = search_memory(
        workspace_id,
        query,
        top_k=top_k,
        exclude_session_id=session_id,
        half_life_days=half_life_days,
    )
    if not items:
        return ""

    lines = [
        "## 過去の会話から検索された関連記憶",
        "以下は同じワークスペース内の過去会話から自動検索された情報です。",
        "回答に役立つ場合だけ自然に参照してください。",
        "",
    ]
    for i, item in enumerate(items, 1):
        lines.append(f"[記憶 {i}]")
        lines.append(item["content"])
        lines.append("")

    context = "\n".join(lines).strip()
    return context[:max_chars] if max_chars > 0 else context


def search_documents(
    workspace_id: int,
    query: str,
    top_k: int = 3,
) -> list[dict]:
    query = query.strip()
    if not query or top_k <= 0:
        return []

    rrf_k = 60
    scores: dict[str, float] = {}
    with _connect() as conn:
        safe_query = '"' + query.replace('"', ' ') + '"'
        try:
            rows = conn.execute(
                """
                SELECT dc.id FROM document_fts df
                JOIN document_chunks dc ON dc.id = df.id
                WHERE df.content MATCH ? AND dc.workspace_id = ?
                ORDER BY df.rank
                LIMIT ?
                """,
                (safe_query, workspace_id, top_k * 4),
            ).fetchall()
            for rank, row in enumerate(rows):
                scores[row["id"]] = scores.get(row["id"], 0.0) + 1.0 / (rrf_k + rank + 1)
        except Exception as e:
            logger.warning("FTS5 document search failed: %s", e)

        try:
            from chat_embedder import embed
            query_vec = embed(query)
            vec_bytes = struct.pack(f"{len(query_vec)}f", *query_vec)
            vec_rows = conn.execute(
                "SELECT chunk_id, distance FROM document_vec WHERE embedding MATCH ? AND k = ?",
                (vec_bytes, top_k * 4),
            ).fetchall()
            if vec_rows:
                vec_ids = [row["chunk_id"] for row in vec_rows]
                placeholders = ",".join("?" * len(vec_ids))
                allowed = {
                    row["id"]
                    for row in conn.execute(
                        f"SELECT id FROM document_chunks WHERE id IN ({placeholders}) AND workspace_id = ?",
                        (*vec_ids, workspace_id),
                    )
                }
                for rank, row in enumerate(vec_rows):
                    if row["chunk_id"] in allowed:
                        scores[row["chunk_id"]] = scores.get(row["chunk_id"], 0.0) + 1.0 / (rrf_k + rank + 1)
        except Exception as e:
            logger.warning("Vector document search failed: %s", e)

        if not scores:
            return []

        ids = list(scores.keys())
        placeholders = ",".join("?" * len(ids))
        rows = conn.execute(
            f"""
            SELECT dc.id, dc.document_id, dc.workspace_id, dc.chunk_index, dc.content, dc.created_at,
                   wd.title AS document_title
            FROM document_chunks dc
            JOIN workspace_documents wd ON wd.id = dc.document_id
            WHERE dc.id IN ({placeholders})
            """,
            ids,
        ).fetchall()

    chunks = {row["id"]: dict(row) for row in rows}
    for chunk_id, row in chunks.items():
        row["score"] = scores.get(chunk_id, 0.0)
    ranked_ids = sorted(scores.keys(), key=lambda cid: scores[cid], reverse=True)[:top_k]
    return [chunks[cid] for cid in ranked_ids if cid in chunks]


def search_documents_for_session(
    session_id: int,
    query: str,
    top_k: int = 3,
) -> list[dict]:
    workspace_id = get_session_workspace(session_id)
    if workspace_id is None:
        return []
    return search_documents(workspace_id, query, top_k=top_k)


def build_document_context(
    session_id: int,
    query: str,
    top_k: int = 3,
    max_chars: int = 2000,
) -> str:
    workspace_id = get_session_workspace(session_id)
    if workspace_id is None:
        return ""
    items = search_documents(workspace_id, query, top_k=top_k)
    if not items:
        return ""

    lines = [
        "## ワークスペース DOCUMENTS から検索された関連情報",
        "以下はワークスペース内の DOCUMENTS から自動検索された情報です。",
        "回答に役立つ場合だけ自然に参照してください。",
        "",
    ]
    for item in items:
        lines.append(f"[DOCUMENT: {item.get('document_title') or 'Untitled'}]")
        lines.append(item["content"])
        lines.append("")

    context = "\n".join(lines).strip()
    return context[:max_chars] if max_chars > 0 else context


def build_combined_context(session_id: int, query: str) -> str:
    doc_context = build_document_context(session_id, query, top_k=3, max_chars=2000)
    memory_context = build_memory_context(session_id, query, top_k=5, max_chars=1500, half_life_days=30)
    return "\n\n".join(part for part in (doc_context, memory_context) if part)
