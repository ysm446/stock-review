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
                   FROM review_price_history WHERE ticker = ? ORDER BY trade_date""",
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


def main():
    symbol = str(sys.argv[1] if len(sys.argv) > 1 else "").strip().upper()
    if not symbol:
        raise SystemExit("Ticker is required")
    output = json.dumps(load_cached_review(symbol), ensure_ascii=False)
    sys.stdout.buffer.write(output.encode("utf-8"))


if __name__ == "__main__":
    main()
