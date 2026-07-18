"""個別銘柄レビューのローカルキャッシュを高速に読み出す。"""

import json
import sqlite3
import sys

from paths import DB_FILE


def load_cached_review(symbol: str):
    if not DB_FILE.exists():
        return None
    conn = sqlite3.connect(DB_FILE)
    try:
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_snapshots'"
        ).fetchone()
        if not table:
            return None
        row = conn.execute(
            "SELECT payload_json, updated_at FROM review_snapshots WHERE ticker = ?",
            (symbol,),
        ).fetchone()
        if not row:
            return None
        payload = json.loads(row[0])
        payload["cachedAt"] = row[1]
        history_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_price_history'"
        ).fetchone()
        history = []
        if history_table:
            history = conn.execute(
                """SELECT trade_date, open, high, low, close, volume
                   FROM review_price_history
                   WHERE ticker = ? AND open > 0 AND high > 0 AND low > 0 AND close > 0
                   ORDER BY trade_date""",
                (symbol,),
            ).fetchall()
        payload["priceHistory"] = [
            {"date": item[0], "open": item[1], "high": item[2], "low": item[3],
             "close": item[4], "volume": item[5]}
            for item in history
        ]
        return payload
    finally:
        conn.close()


def load_price_history_only(symbol: str):
    """スナップショットの有無に関わらず、蓄積済みの日足だけを返す（指数・為替用）。"""
    if not DB_FILE.exists():
        return []
    conn = sqlite3.connect(DB_FILE)
    try:
        history_table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='review_price_history'"
        ).fetchone()
        if not history_table:
            return []
        history = conn.execute(
            """SELECT trade_date, open, high, low, close, volume
               FROM review_price_history
               WHERE ticker = ? AND open > 0 AND high > 0 AND low > 0 AND close > 0
               ORDER BY trade_date""",
            (symbol,),
        ).fetchall()
        return [
            {"date": item[0], "open": item[1], "high": item[2], "low": item[3],
             "close": item[4], "volume": item[5]}
            for item in history
        ]
    finally:
        conn.close()


def main():
    symbol = str(sys.argv[1] if len(sys.argv) > 1 else "").strip().upper()
    if not symbol:
        raise SystemExit("Ticker is required")
    history_only = len(sys.argv) > 2 and sys.argv[2] == "--history-only"
    result = load_price_history_only(symbol) if history_only else load_cached_review(symbol)
    output = json.dumps(result, ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))


if __name__ == "__main__":
    main()
