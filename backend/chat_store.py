from __future__ import annotations

import logging
import math
import sqlite3
import struct
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "chat.db"
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
        _ensure_messages_schema(conn)
        _ensure_memory_schema(conn)
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
            "SELECT * FROM workspaces ORDER BY sort_order, created_at"
        )]


def create_workspace(name: str = "新しいワークスペース") -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO workspaces (name, sort_order, created_at, updated_at) VALUES (?, 0, ?, ?)",
            (name, now, now),
        )
        return {"id": cur.lastrowid, "name": name, "sort_order": 0, "created_at": now, "updated_at": now}


def rename_workspace(id: int, name: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?", (name, _now(), id))


def delete_workspace(id: int) -> None:
    with _connect() as conn:
        delete_workspace_memory(id, conn)
        conn.execute("DELETE FROM workspaces WHERE id = ?", (id,))


# ── Sessions ──────────────────────────────────────────────

def list_sessions(workspace_id: int) -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC",
            (workspace_id,),
        )]


def create_session(workspace_id: int, title: str = "新しい会話") -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (workspace_id, title, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
            (workspace_id, title, now, now),
        )
        return {
            "id": cur.lastrowid, "workspace_id": workspace_id,
            "title": title, "sort_order": 0, "created_at": now, "updated_at": now,
        }


def rename_session(id: int, title: str) -> None:
    with _connect() as conn:
        conn.execute("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", (title, _now(), id))


def delete_session(id: int) -> None:
    with _connect() as conn:
        delete_session_memory(id, conn)
        conn.execute("DELETE FROM sessions WHERE id = ?", (id,))


# ── Messages ──────────────────────────────────────────────

def list_messages(session_id: int) -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at",
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
