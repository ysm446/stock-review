from __future__ import annotations

import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "chat.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def _now() -> int:
    return int(time.time() * 1000)


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
            CREATE TABLE IF NOT EXISTS messages (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                role       TEXT    NOT NULL,
                content    TEXT    NOT NULL,
                created_at INTEGER NOT NULL
            );
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
