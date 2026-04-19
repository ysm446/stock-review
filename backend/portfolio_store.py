import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import yfinance as yf


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
DB_FILE = DATA_DIR / "app.db"
PORTFOLIO_FILE = DATA_DIR / "portfolio.json"
STOCK_MASTER_FILE = DATA_DIR / "stock_master.json"

FX_TICKERS = {
    "USD": "USDJPY=X",
    "EUR": "EURJPY=X",
    "GBP": "GBPJPY=X",
    "AUD": "AUDJPY=X",
    "CAD": "CADJPY=X",
    "HKD": "HKDJPY=X",
}


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
            ticker TEXT PRIMARY KEY,
            shares INTEGER NOT NULL DEFAULT 0,
            buy_price INTEGER NOT NULL DEFAULT 0,
            note TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticker) REFERENCES stocks(ticker) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS watchlist (
            ticker TEXT PRIMARY KEY,
            rating TEXT NOT NULL DEFAULT 'B',
            thesis TEXT NOT NULL DEFAULT '',
            risk TEXT NOT NULL DEFAULT '',
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
        """
    )
    conn.commit()


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
                str(holding.get("note") or ""),
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

    for item in watchlist:
        ticker = str(item.get("ticker") or "").strip()
        if not ticker:
            continue
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO watchlist (ticker, rating, thesis, risk, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                ticker,
                str(item.get("rating") or "B"),
                str(item.get("thesis") or ""),
                str(item.get("risk") or ""),
                now,
            ),
        )

    conn.commit()


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


def get_latest_quote(ticker: str) -> dict[str, object]:
    stock = yf.Ticker(ticker)
    info = stock.fast_info
    price = info.get("lastPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    currency = (info.get("currency") or "USD").upper()
    if price is None:
        history = stock.history(period="5d", interval="1d", auto_adjust=False)
        if history.empty:
            raise ValueError("No market data returned")
        price = float(history["Close"].dropna().iloc[-1])
    return {"price": float(price), "currency": currency}


def convert_price_to_jpy(price: float, currency: str, fx_map: dict[str, float] | None = None, trade_date: str | None = None):
    normalized = (currency or "JPY").upper()
    if normalized == "JPY":
        return float(price), 1.0
    if fx_map and trade_date and trade_date in fx_map:
        fx_rate = fx_map[trade_date]
        return float(price) * float(fx_rate), float(fx_rate)

    latest_fx = get_latest_quote(FX_TICKERS[normalized])
    fx_rate = float(latest_fx["price"])
    return float(price) * fx_rate, fx_rate


def store_price_history(conn: sqlite3.Connection, ticker: str, period: str = "1y") -> int:
    normalized = str(ticker or "").strip()
    if not normalized:
        return 0
    ensure_stock(conn, normalized)
    stock = yf.Ticker(normalized)
    history = stock.history(period=period, interval="1d", auto_adjust=False)
    if history.empty:
        raise ValueError("No historical data returned")

    info = stock.fast_info
    currency = (info.get("currency") or "JPY").upper()
    fx_map = get_fx_history(currency, period=period) if currency != "JPY" else {}
    inserted = 0

    for index, row in history.iterrows():
        close_price = row.get("Close")
        if close_price is None:
            continue
        trade_date = index.date().isoformat()
        price_jpy, _ = convert_price_to_jpy(float(close_price), currency, fx_map, trade_date)
        conn.execute(
            """
            INSERT OR REPLACE INTO price_history (ticker, trade_date, close_price_jpy, source_close, currency)
            VALUES (?, ?, ?, ?, ?)
            """,
            (normalized, trade_date, int(round(price_jpy)), float(close_price), currency),
        )
        inserted += 1

    conn.commit()
    return inserted


def build_portfolio_history_for_holdings(conn: sqlite3.Connection, holdings: list[dict[str, object]]) -> list[dict[str, object]]:
    normalized_holdings = []
    tickers = []
    for holding in holdings:
        ticker = str(holding.get("ticker") or "").strip()
        shares = parse_number(holding.get("shares"))
        if not ticker or shares <= 0:
            continue
        normalized_holdings.append({"ticker": ticker, "shares": shares})
        tickers.append(ticker)

    if not normalized_holdings:
        return []

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

    if not rows:
        return []

    history_by_ticker = {}
    all_dates = set()
    for row in rows:
        trade_date = row["trade_date"]
        ticker = row["ticker"]
        history_by_ticker.setdefault(ticker, {})[trade_date] = int(row["close_price_jpy"])
        all_dates.add(trade_date)

    running_prices = {}
    result = []
    for trade_date in sorted(all_dates):
        for holding in normalized_holdings:
            price = history_by_ticker.get(holding["ticker"], {}).get(trade_date)
            if price is not None:
                running_prices[holding["ticker"]] = price

        total_value = 0
        complete = True
        for holding in normalized_holdings:
            ticker = holding["ticker"]
            price = running_prices.get(ticker)
            if price is None:
                complete = False
                break
            total_value += holding["shares"] * price

        if complete:
            result.append({"date": trade_date, "value": total_value})

    return result


def store_latest_quote(conn: sqlite3.Connection, ticker: str) -> dict[str, object]:
    normalized = str(ticker or "").strip()
    if not normalized:
        raise ValueError("Ticker is empty")
    ensure_stock(conn, normalized)
    latest = get_latest_quote(normalized)
    price_jpy, fx_rate = convert_price_to_jpy(latest["price"], latest["currency"])
    now = utc_now()
    quote_date = today_iso()
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
        (
            normalized,
            int(round(price_jpy)),
            float(latest["price"]),
            latest["currency"],
            float(fx_rate),
            quote_date,
            now,
        ),
    )
    conn.commit()
    return {
        "price": float(latest["price"]),
        "currency": latest["currency"],
        "price_jpy": float(price_jpy),
        "fx_rate_jpy": float(fx_rate),
        "quote_date": quote_date,
    }


def build_portfolio_history(conn: sqlite3.Connection) -> list[dict[str, object]]:
    holdings = conn.execute(
        """
        SELECT ticker, shares
        FROM holdings
        WHERE shares > 0
        ORDER BY sort_order, ticker
        """
    ).fetchall()
    if not holdings:
        return []

    rows = conn.execute(
        """
        SELECT trade_date, ticker, close_price_jpy
        FROM price_history
        WHERE ticker IN (SELECT ticker FROM holdings WHERE shares > 0)
        ORDER BY trade_date ASC, ticker ASC
        """
    ).fetchall()

    history_by_ticker = {}
    dates = set()
    for row in rows:
        history_by_ticker.setdefault(row["ticker"], {})[row["trade_date"]] = int(row["close_price_jpy"])
        dates.add(row["trade_date"])

    if not dates:
        return []

    running_prices = {}
    result = []
    for trade_date in sorted(dates):
        for holding in holdings:
            ticker = holding["ticker"]
            price = history_by_ticker.get(ticker, {}).get(trade_date)
            if price is not None:
                running_prices[ticker] = price

        total_value = 0
        complete = True
        for holding in holdings:
            ticker = holding["ticker"]
            if ticker not in running_prices:
                complete = False
                break
            total_value += int(holding["shares"]) * int(running_prices[ticker])

        if complete:
            result.append({"date": trade_date, "value": total_value})

    return result


def load_state(conn: sqlite3.Connection) -> dict[str, object]:
    holdings_rows = conn.execute(
        """
        SELECT h.ticker, h.shares, h.buy_price, h.note, h.sort_order,
               q.price_jpy, q.source_price, q.currency
        FROM holdings h
        LEFT JOIN latest_quotes q ON q.ticker = h.ticker
        ORDER BY h.sort_order ASC, h.ticker ASC
        """
    ).fetchall()
    watchlist_rows = conn.execute(
        """
        SELECT ticker, rating, thesis, risk
        FROM watchlist
        ORDER BY ticker ASC
        """
    ).fetchall()

    holdings = [
        {
            "ticker": row["ticker"],
            "shares": str(row["shares"] or 0),
            "buyPrice": str(row["buy_price"] or 0),
            "price": str(row["price_jpy"] or 0) if row["price_jpy"] else "",
            "note": row["note"] or "",
            "sourcePrice": row["source_price"],
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
        "trendHistory": build_portfolio_history(conn),
    }


def save_state(conn: sqlite3.Connection, payload: dict[str, object]) -> dict[str, object]:
    holdings = payload.get("holdings", [])
    watchlist = payload.get("watchlist", [])
    now = utc_now()

    incoming_holding_tickers = []
    for index, holding in enumerate(holdings):
        ticker = str(holding.get("ticker") or "").strip()
        if not ticker:
            continue
        incoming_holding_tickers.append(ticker)
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO holdings (ticker, shares, buy_price, note, sort_order, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                shares = excluded.shares,
                buy_price = excluded.buy_price,
                note = excluded.note,
                sort_order = excluded.sort_order,
                updated_at = excluded.updated_at
            """,
            (
                ticker,
                parse_number(holding.get("shares")),
                parse_number(holding.get("buyPrice")),
                str(holding.get("note") or ""),
                index,
                now,
            ),
        )

        price_jpy = parse_number(holding.get("price"))
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
                (
                    ticker,
                    price_jpy,
                    holding.get("sourcePrice"),
                    str(holding.get("currency") or "JPY").upper(),
                    None,
                    today_iso(),
                    now,
                ),
            )

    if incoming_holding_tickers:
        placeholders = ",".join("?" for _ in incoming_holding_tickers)
        conn.execute(
            f"DELETE FROM holdings WHERE ticker NOT IN ({placeholders})",
            incoming_holding_tickers,
        )
    else:
        conn.execute("DELETE FROM holdings")

    incoming_watchlist_tickers = []
    for item in watchlist:
        ticker = str(item.get("ticker") or "").strip()
        if not ticker:
            continue
        incoming_watchlist_tickers.append(ticker)
        ensure_stock(conn, ticker)
        conn.execute(
            """
            INSERT INTO watchlist (ticker, rating, thesis, risk, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(ticker) DO UPDATE SET
                rating = excluded.rating,
                thesis = excluded.thesis,
                risk = excluded.risk,
                updated_at = excluded.updated_at
            """,
            (
                ticker,
                str(item.get("rating") or "B"),
                str(item.get("thesis") or ""),
                str(item.get("risk") or ""),
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
    return load_state(conn)


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
