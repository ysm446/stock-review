import bisect
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import yfinance as yf

from shared import FX_TICKERS, convert_to_jpy, get_yf_price, normalize_price_currency
from paths import DATA_DIR, DB_FILE, PORTFOLIO_FILE, STOCK_MASTER_FILE


def utc_now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def today_iso() -> str:
    return datetime.utcnow().date().isoformat()


def parse_number(value) -> int:
    text = str(value or "").strip().replace(",", "")
    if not text:
        return 0
    try:
        return int(round(float(text)))
    except ValueError:
        return 0


def sanitize_text(value) -> str:
    text = str(value or "")
    return "".join(ch for ch in text if not 0xD800 <= ord(ch) <= 0xDFFF)


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def connect_db() -> sqlite3.Connection:
    ensure_data_dir()
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # save / refresh / history は別プロセスとして並行実行されるため、
    # WAL とロック待ちで "database is locked" による保存の取りこぼしを防ぐ。
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS stocks (
            ticker TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            market TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS holdings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticker TEXT NOT NULL,
            shares INTEGER NOT NULL DEFAULT 0,
            buy_price INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_holdings_ticker
            ON holdings(ticker);

        CREATE TABLE IF NOT EXISTS watchlist (
            ticker TEXT PRIMARY KEY,
            rating TEXT NOT NULL DEFAULT 'B',
            thesis TEXT NOT NULL DEFAULT '',
            risk TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS latest_quotes (
            ticker TEXT PRIMARY KEY,
            price_jpy INTEGER NOT NULL DEFAULT 0,
            source_price REAL,
            currency TEXT NOT NULL DEFAULT 'JPY',
            fx_rate_jpy REAL,
            quote_date TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS price_history (
            ticker TEXT NOT NULL,
            trade_date TEXT NOT NULL,
            close_price_jpy INTEGER NOT NULL,
            source_close REAL,
            currency TEXT NOT NULL DEFAULT 'JPY',
            PRIMARY KEY (ticker, trade_date),
            FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_price_history_date
            ON price_history(trade_date);

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT ''
        );
        """
    )
    _migrate_holdings_to_lots(conn)
    columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(latest_quotes)").fetchall()
    }
    if "previous_close_jpy" not in columns:
        conn.execute("ALTER TABLE latest_quotes ADD COLUMN previous_close_jpy INTEGER")
    if "previous_close_source" not in columns:
        conn.execute("ALTER TABLE latest_quotes ADD COLUMN previous_close_source REAL")
    watchlist_columns = {
        row["name"]
        for row in conn.execute("PRAGMA table_info(watchlist)").fetchall()
    }
    if "sort_order" not in watchlist_columns:
        conn.execute("ALTER TABLE watchlist ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    conn.commit()


def _migrate_holdings_to_lots(conn: sqlite3.Connection) -> None:
    """旧スキーマ（ticker PRIMARY KEY）の holdings をロット単位（id 主キー）へ移行する。

    旧スキーマでは同一銘柄の複数ロットが1行に潰れて保存されていたため、
    ロットを行として保持できる形に作り直す。
    """
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(holdings)").fetchall()}
    if "id" in columns:
        return
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.executescript(
            """
            CREATE TABLE holdings_lots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker TEXT NOT NULL,
                shares INTEGER NOT NULL DEFAULT 0,
                buy_price INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
            );
            INSERT INTO holdings_lots (ticker, shares, buy_price, note, sort_order, updated_at)
                SELECT ticker, shares, buy_price, note, sort_order, updated_at FROM holdings;
            DROP TABLE holdings;
            ALTER TABLE holdings_lots RENAME TO holdings;
            CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON holdings(ticker);
            """
        )
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def seed_stocks_from_master(conn: sqlite3.Connection) -> None:
    now = utc_now()
    master = load_json(STOCK_MASTER_FILE, {})
    rows = [
        (ticker, str(name or "").strip(), now, now)
        for ticker, name in master.items()
        if str(ticker or "").strip()
    ]
    if not rows:
        return
    conn.executemany(
        """
        INSERT INTO stocks (ticker, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            name = CASE
                WHEN excluded.name <> '' THEN excluded.name
                ELSE stocks.name
            END,
            updated_at = excluded.updated_at
        """,
        rows,
    )
    conn.commit()


def ensure_stock(conn: sqlite3.Connection, ticker: str) -> None:
    normalized = str(ticker or "").strip()
    if not normalized:
        return
    name = load_json(STOCK_MASTER_FILE, {}).get(normalized, normalized)
    now = utc_now()
    conn.execute(
        """
        INSERT INTO stocks (ticker, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET updated_at = excluded.updated_at
        """,
        (normalized, name, now, now),
    )


def migrate_legacy_json(conn: sqlite3.Connection) -> None:
    has_holdings = conn.execute("SELECT 1 FROM holdings LIMIT 1").fetchone()
    has_watchlist = conn.execute("SELECT 1 FROM watchlist LIMIT 1").fetchone()
    if has_holdings or has_watchlist:
        return

    legacy = load_json(PORTFOLIO_FILE, {"holdings": [], "watchlist": []})
    holdings = legacy.get("holdings", [])
    watchlist = legacy.get("watchlist", [])
    now = utc_now()
    today = today_iso()

    for index, holding in enumerate(holdings):
        ticker = str(holding.get("ticker") or "").strip()
        if not ticker:
            continue
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO holdings (ticker, shares, buy_price, note, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                ticker,
                parse_number(holding.get("shares")),
                parse_number(holding.get("buyPrice")),
                sanitize_text(holding.get("note")),
                index,
                now,
            ),
        )

        price_jpy = parse_number(holding.get("price"))
        source_price = holding.get("sourcePrice")
        currency = str(holding.get("currency") or "JPY").upper()
        if price_jpy > 0:
            conn.execute(
                """
                INSERT INTO latest_quotes (ticker, price_jpy, source_price, currency, fx_rate_jpy, quote_date, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    price_jpy = excluded.price_jpy,
                    source_price = excluded.source_price,
                    currency = excluded.currency,
                    fx_rate_jpy = excluded.fx_rate_jpy,
                    quote_date = excluded.quote_date,
                    updated_at = excluded.updated_at
                """,
                (ticker, price_jpy, source_price, currency, None, today, now),
            )
            conn.execute(
                """
                INSERT OR REPLACE INTO price_history (ticker, trade_date, close_price_jpy, source_close, currency)
                VALUES (?, ?, ?, ?, ?)
                """,
                (ticker, today, price_jpy, source_price, currency),
            )

    for index, item in enumerate(watchlist):
        ticker = str(item.get("ticker") or "").strip()
        if not ticker:
            continue
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO watchlist (ticker, rating, thesis, risk, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                rating = excluded.rating,
                thesis = excluded.thesis,
                risk = excluded.risk,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
            """,
            (
                ticker,
                str(item.get("rating") or "B"),
                str(item.get("thesis") or ""),
                str(item.get("risk") or ""),
                index,
                now,
            ),
        )

    conn.commit()


def get_setting(conn: sqlite3.Connection, key: str, fallback: str = "") -> str:
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return fallback
    return row["value"]


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (key, value, utc_now()),
    )


def get_cash_jpy(conn: sqlite3.Connection) -> int:
    return parse_number(get_setting(conn, "cash_jpy", "0"))


def set_cash_jpy(conn: sqlite3.Connection, value) -> None:
    set_setting(conn, "cash_jpy", str(parse_number(value)))


def initialize() -> sqlite3.Connection:
    conn = connect_db()
    ensure_schema(conn)
    seed_stocks_from_master(conn)
    migrate_legacy_json(conn)
    return conn


def get_fx_history(currency: str, period: str = "1y") -> dict[str, float]:
    normalized = (currency or "JPY").upper()
    if normalized == "JPY":
        return {}
    fx_ticker = FX_TICKERS.get(normalized)
    if not fx_ticker:
        raise ValueError(f"Unsupported currency: {normalized}")

    history = yf.Ticker(fx_ticker).history(period=period, interval="1d", auto_adjust=False)
    if history.empty:
        raise ValueError(f"No FX history for {normalized}")

    fx_map = {}
    for index, row in history.iterrows():
        close_price = row.get("Close")
        if close_price is None:
            continue
        fx_map[index.date().isoformat()] = float(close_price)
    return fx_map


def _fx_rate_for_date(fx_map: dict[str, float], sorted_dates: list[str], trade_date: str) -> float:
    """trade_date のレートを返す。無い日は直近過去のレートで埋める（当日のスポットレートは使わない）。"""
    if trade_date in fx_map:
        return float(fx_map[trade_date])
    pos = bisect.bisect_right(sorted_dates, trade_date)
    if pos > 0:
        return float(fx_map[sorted_dates[pos - 1]])
    return float(fx_map[sorted_dates[0]])


def store_price_history(conn: sqlite3.Connection, ticker: str, period: str = "1y") -> int:
    normalized = str(ticker or "").strip()
    if not normalized:
        return 0
    ensure_stock(conn, normalized)
    stock = yf.Ticker(normalized)
    history = stock.history(period=period, interval="1d", auto_adjust=False)
    if history.empty:
        raise ValueError("No historical data returned")

    raw_currency = stock.fast_info.get("currency")
    if not raw_currency:
        # 通貨を推測して換算すると履歴が桁ごと壊れるため、明示的にエラーにする。
        raise ValueError(f"{normalized}: currency unavailable from Yahoo")
    _, currency = normalize_price_currency(None, raw_currency)
    fx_map = get_fx_history(currency, period=period) if currency != "JPY" else {}
    fx_dates = sorted(fx_map)
    inserted = 0

    for index, row in history.iterrows():
        raw_close = row.get("Close")
        if raw_close is None:
            continue
        close_price, _ = normalize_price_currency(float(raw_close), raw_currency)
        trade_date = index.date().isoformat()
        if currency == "JPY":
            price_jpy = close_price
        else:
            price_jpy = close_price * _fx_rate_for_date(fx_map, fx_dates, trade_date)
        conn.execute(
            """
            INSERT OR REPLACE INTO price_history (ticker, trade_date, close_price_jpy, source_close, currency)
            VALUES (?, ?, ?, ?, ?)
            """,
            (normalized, trade_date, int(round(price_jpy)), close_price, currency),
        )
        inserted += 1

    conn.commit()
    return inserted


def _build_history_from_rows(holdings: list[dict[str, object]], rows) -> list[dict[str, object]]:
    """Compute portfolio value time series from normalized holdings and price_history rows."""
    history_by_ticker: dict[str, dict[str, int]] = {}
    all_dates: set[str] = set()
    for row in rows:
        trade_date = row["trade_date"]
        history_by_ticker.setdefault(row["ticker"], {})[trade_date] = int(row["close_price_jpy"])
        all_dates.add(trade_date)

    if not all_dates:
        return []

    running_prices: dict[str, int] = {}
    result = []
    for trade_date in sorted(all_dates):
        for h in holdings:
            price = history_by_ticker.get(h["ticker"], {}).get(trade_date)
            if price is not None:
                running_prices[h["ticker"]] = price

        total_value = 0
        complete = True
        for h in holdings:
            price = running_prices.get(h["ticker"])
            if price is None:
                complete = False
                break
            total_value += h["shares"] * price

        if complete:
            result.append({"date": trade_date, "value": total_value})

    return result


def build_portfolio_history_for_holdings(conn: sqlite3.Connection, holdings: list[dict[str, object]]) -> list[dict[str, object]]:
    normalized = [
        {"ticker": str(h.get("ticker") or "").strip(), "shares": parse_number(h.get("shares"))}
        for h in holdings
        if str(h.get("ticker") or "").strip() and parse_number(h.get("shares")) > 0
    ]
    if not normalized:
        return []

    tickers = [h["ticker"] for h in normalized]
    placeholders = ",".join("?" for _ in tickers)
    rows = conn.execute(
        f"""
        SELECT trade_date, ticker, close_price_jpy
        FROM price_history
        WHERE ticker IN ({placeholders})
        ORDER BY trade_date ASC, ticker ASC
        """,
        tickers,
    ).fetchall()

    return _build_history_from_rows(normalized, rows)


def store_latest_quote(conn: sqlite3.Connection, ticker: str) -> dict[str, object]:
    normalized = str(ticker or "").strip()
    if not normalized:
        raise ValueError("Ticker is empty")
    ensure_stock(conn, normalized)
    price, previous_close, currency = get_yf_price(normalized, require_currency=True)
    if currency == "JPY":
        fx_rate = 1.0
    else:
        fx_ticker = FX_TICKERS.get(currency)
        if not fx_ticker:
            raise ValueError(f"Unsupported currency: {currency}")
        fx_rate, _, _ = get_yf_price(fx_ticker)
    price_jpy = price * fx_rate
    previous_close_jpy = previous_close * fx_rate
    now = utc_now()
    quote_date = today_iso()
    conn.execute(
        """
        INSERT INTO latest_quotes (
            ticker, price_jpy, source_price, currency, fx_rate_jpy,
            previous_close_jpy, previous_close_source, quote_date, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            price_jpy = excluded.price_jpy,
            source_price = excluded.source_price,
            currency = excluded.currency,
            fx_rate_jpy = excluded.fx_rate_jpy,
            previous_close_jpy = excluded.previous_close_jpy,
            previous_close_source = excluded.previous_close_source,
            quote_date = excluded.quote_date,
            updated_at = excluded.updated_at
        """,
        (
            normalized,
            int(round(price_jpy)),
            float(price),
            currency,
            float(fx_rate),
            int(round(previous_close_jpy)),
            float(previous_close),
            quote_date,
            now,
        ),
    )
    conn.commit()
    return {
        "price": float(price),
        "previous_close": float(previous_close),
        "currency": currency,
        "price_jpy": float(price_jpy),
        "previous_close_jpy": float(previous_close_jpy),
        "fx_rate_jpy": float(fx_rate),
        "quote_date": quote_date,
    }


def build_portfolio_history(conn: sqlite3.Connection) -> list[dict[str, object]]:
    holding_rows = conn.execute(
        """
        SELECT ticker, shares
        FROM holdings
        WHERE shares > 0
        ORDER BY sort_order, ticker
        """
    ).fetchall()
    if not holding_rows:
        return []

    holdings = [{"ticker": r["ticker"], "shares": int(r["shares"])} for r in holding_rows]
    rows = conn.execute(
        """
        SELECT trade_date, ticker, close_price_jpy
        FROM price_history
        WHERE ticker IN (SELECT ticker FROM holdings WHERE shares > 0)
        ORDER BY trade_date ASC, ticker ASC
        """
    ).fetchall()

    return _build_history_from_rows(holdings, rows)


def load_state(conn: sqlite3.Connection) -> dict[str, object]:
    holdings_rows = conn.execute(
        """
        SELECT h.ticker, h.shares, h.buy_price, h.note, h.sort_order,
               q.price_jpy, q.source_price, q.currency, q.previous_close_jpy, q.previous_close_source
        FROM holdings h
        LEFT JOIN latest_quotes q ON q.ticker = h.ticker
        ORDER BY h.sort_order ASC, h.ticker ASC
        """
    ).fetchall()
    watchlist_rows = conn.execute(
        """
        SELECT ticker, rating, thesis, risk
        FROM watchlist
        ORDER BY sort_order ASC, ticker ASC
        """
    ).fetchall()

    holdings = [
        {
            "ticker": row["ticker"],
            "shares": str(row["shares"] or 0),
            "buyPrice": str(row["buy_price"] or 0),
            "price": str(row["price_jpy"] or 0) if row["price_jpy"] else "",
            "previousClose": str(row["previous_close_jpy"] or 0) if row["previous_close_jpy"] else "",
            "note": row["note"] or "",
            "sourcePrice": row["source_price"],
            "sourcePreviousClose": row["previous_close_source"],
            "currency": row["currency"] or "JPY",
        }
        for row in holdings_rows
    ]
    watchlist = [
        {
            "ticker": row["ticker"],
            "rating": row["rating"] or "B",
            "thesis": row["thesis"] or "",
            "risk": row["risk"] or "",
        }
        for row in watchlist_rows
    ]
    return {
        "holdings": holdings,
        "watchlist": watchlist,
        "cashJpy": get_cash_jpy(conn),
        "trendHistory": build_portfolio_history(conn),
    }


def save_state(conn: sqlite3.Connection, payload: dict[str, object]) -> dict[str, object]:
    holdings = payload.get("holdings", [])
    watchlist = payload.get("watchlist", [])
    now = utc_now()

    if "cash" in payload or "cashJpy" in payload:
        set_cash_jpy(conn, payload.get("cash", payload.get("cashJpy")))

    # 保存は全量置き換え。同一銘柄の複数ロットを行単位で保持する。
    conn.execute("DELETE FROM holdings")
    for index, holding in enumerate(holdings):
        ticker = str(holding.get("ticker") or "").strip()
        if not ticker:
            continue
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO holdings (ticker, shares, buy_price, note, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                ticker,
                parse_number(holding.get("shares")),
                parse_number(holding.get("buyPrice")),
                sanitize_text(holding.get("note")),
                index,
                now,
            ),
        )

        price_jpy = parse_number(holding.get("price"))
        if price_jpy > 0:
            conn.execute(
                """
                INSERT INTO latest_quotes (
                    ticker, price_jpy, source_price, currency, fx_rate_jpy,
                    previous_close_jpy, previous_close_source, quote_date, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(ticker) DO UPDATE SET
                    price_jpy = excluded.price_jpy,
                    source_price = excluded.source_price,
                    currency = excluded.currency,
                    fx_rate_jpy = excluded.fx_rate_jpy,
                    previous_close_jpy = excluded.previous_close_jpy,
                    previous_close_source = excluded.previous_close_source,
                    quote_date = excluded.quote_date,
                    updated_at = excluded.updated_at
                """,
                (
                    ticker,
                    price_jpy,
                    holding.get("sourcePrice"),
                    sanitize_text(holding.get("currency") or "JPY").upper(),
                    None,
                    parse_number(holding.get("previousClose")),
                    holding.get("sourcePreviousClose"),
                    today_iso(),
                    now,
                ),
            )

    incoming_watchlist_tickers = []
    for index, item in enumerate(watchlist):
        ticker = str(item.get("ticker") or "").strip()
        if not ticker:
            continue
        incoming_watchlist_tickers.append(ticker)
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO watchlist (ticker, rating, thesis, risk, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                rating = excluded.rating,
                thesis = excluded.thesis,
                risk = excluded.risk,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
            """,
            (
                ticker,
                sanitize_text(item.get("rating") or "B"),
                sanitize_text(item.get("thesis")),
                sanitize_text(item.get("risk")),
                index,
                now,
            ),
        )

    if incoming_watchlist_tickers:
        placeholders = ",".join("?" for _ in incoming_watchlist_tickers)
        conn.execute(
            f"DELETE FROM watchlist WHERE ticker NOT IN ({placeholders})",
            incoming_watchlist_tickers,
        )
    else:
        conn.execute("DELETE FROM watchlist")

    conn.commit()
    state = load_state(conn)
    state["trendHistory"] = build_portfolio_history_for_holdings(conn, holdings)
    return state


def refresh_prices(conn: sqlite3.Connection, tickers: list[str]) -> dict[str, object]:
    normalized_tickers = []
    seen = set()
    for ticker in tickers:
        normalized = str(ticker or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            normalized_tickers.append(normalized)

    quotes = {}
    errors = {}
    history_updates = {}
    for ticker in normalized_tickers:
        try:
            quote = store_latest_quote(conn, ticker)
            try:
                history_updates[ticker] = store_price_history(conn, ticker, period="1y")
            except Exception as history_error:
                errors[f"{ticker}:history"] = str(history_error)
            quotes[ticker] = quote
        except Exception as exc:
            errors[ticker] = str(exc)

    return {
        "quotes": quotes,
        "errors": errors,
        "historyUpdates": history_updates,
        "portfolio": load_state(conn),
    }


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "load"
    conn = initialize()

    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if command == "load":
            result = load_state(conn)
        elif command == "save":
            result = save_state(conn, payload)
        elif command == "refresh":
            result = refresh_prices(conn, payload.get("tickers", []))
        elif command == "history":
            result = {"trendHistory": build_portfolio_history_for_holdings(conn, payload.get("holdings", []))}
        else:
            raise ValueError(f"Unsupported command: {command}")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
