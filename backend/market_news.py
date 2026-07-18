"""マーケットページのニュース収集。

ddgs のニュース検索を市況クエリ数本で束ね、`app.db` の `market_news` テーブルへ
蓄積する（URL主キーでupsert）。再検索のたびに一覧が入れ替わるのではなく、
新着が既存の蓄積へ追加され、古いものから RETENTION_ITEMS 件を超えた分だけ削除される。
アプリ再起動後も蓄積は残る。検索の実行間隔はメモリ上のTTLで制御する。
LLM は使わない（まとめ生成は chat_server 側の /market/summary が担当）。
"""
from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timezone

from paths import DB_FILE
from search_web import search_news

QUERIES = ["株式市場", "日経平均", "米国株", "為替 ドル円"]
MAX_PER_QUERY = 8
RETENTION_ITEMS = 100  # DBに残す最大件数（古い日付から削除）
RESPONSE_ITEMS = 40    # APIが返す最大件数
CACHE_TTL_SECONDS = 15 * 60

_lock = threading.Lock()
_state = {"fetchedAt": None, "fetched_monotonic": 0.0}


def _connect() -> sqlite3.Connection:
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS market_news (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        snippet TEXT,
        source TEXT,
        image TEXT,
        published_at TEXT,
        query TEXT,
        fetched_at TEXT NOT NULL)""")
    return conn


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fetch_items() -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()
    for query in QUERIES:
        for item in search_news(query, max_results=MAX_PER_QUERY, include_image=True):
            url = str(item.get("url") or "")
            if not url or url in seen:
                continue
            seen.add(url)
            items.append({**item, "query": query})
    return items


def _store_items(items: list[dict]) -> None:
    """新着をupsertし、日付の古いものからRETENTION_ITEMS件を超えた分を削除する。"""
    if not items:
        return
    conn = _connect()
    try:
        now = _now_iso()
        conn.executemany(
            """INSERT INTO market_news (url, title, snippet, source, image, published_at, query, fetched_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(url) DO UPDATE SET
                 title=excluded.title, snippet=excluded.snippet, source=excluded.source,
                 image=excluded.image, published_at=excluded.published_at""",
            [(item["url"], item["title"], item.get("snippet") or "", item.get("source") or "",
              item.get("image") or "", item.get("date") or "", item.get("query") or "", now)
             for item in items],
        )
        conn.execute(
            """DELETE FROM market_news WHERE url NOT IN (
                 SELECT url FROM market_news
                 ORDER BY COALESCE(NULLIF(published_at, ''), fetched_at) DESC, fetched_at DESC
                 LIMIT ?)""",
            (RETENTION_ITEMS,),
        )
        conn.commit()
    finally:
        conn.close()


def _load_items(limit: int = RESPONSE_ITEMS) -> list[dict]:
    conn = _connect()
    try:
        rows = conn.execute(
            """SELECT url, title, snippet, source, image, published_at, query
               FROM market_news
               ORDER BY COALESCE(NULLIF(published_at, ''), fetched_at) DESC, fetched_at DESC
               LIMIT ?""",
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"url": row[0], "title": row[1], "snippet": row[2], "source": row[3],
         "image": row[4], "date": row[5], "query": row[6]}
        for row in rows
    ]


def get_news(force: bool = False) -> dict:
    """蓄積済みニュースを返す。TTLが切れていれば再検索して蓄積に追加する。

    検索が全滅（通信断・レート制限）しても蓄積済みの一覧をそのまま返すため、
    表示中のニュースが消えることはない。
    """
    with _lock:
        age = time.monotonic() - _state["fetched_monotonic"]
        if force or not _state["fetchedAt"] or age >= CACHE_TTL_SECONDS:
            items = _fetch_items()
            if items:
                _store_items(items)
                _state["fetchedAt"] = _now_iso()
                _state["fetched_monotonic"] = time.monotonic()
        return {
            "items": _load_items(),
            "fetchedAt": _state["fetchedAt"],
            "cached": not force and age < CACHE_TTL_SECONDS,
        }
