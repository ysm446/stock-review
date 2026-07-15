import json
import sqlite3
import sys
from datetime import datetime, timezone

import yfinance as yf

from shared import to_float
from paths import DB_FILE

MAX_FINANCIAL_SUMMARY_PERIODS = 4


OVERVIEW_FIELDS = {
    "sector": "sector",
    "industry": "industry",
    "currentPrice": "currentPrice",
    "marketCap": "marketCap",
    "fiftyTwoWeekHigh": "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow": "fiftyTwoWeekLow",
}

VALUATION_FIELDS = {
    "trailingPE": "trailingPE",
    "priceToBook": "priceToBook",
    "enterpriseToEbitda": "enterpriseToEbitda",
    "dividendYield": "dividendYield",
    "dividendRate": "dividendRate",
    "trailingAnnualDividendRate": "trailingAnnualDividendRate",
}

PROFITABILITY_FIELDS = {
    "returnOnEquity": "returnOnEquity",
    "returnOnAssets": "returnOnAssets",
    "operatingMargins": "operatingMargins",
}

ANALYST_FIELDS = {
    "numberOfAnalystOpinions": "numberOfAnalystOpinions",
    "targetMeanPrice": "targetMeanPrice",
    "targetHighPrice": "targetHighPrice",
    "targetLowPrice": "targetLowPrice",
    "recommendationKey": "recommendationKey",
}


def to_int(value):
    try:
        if value is None:
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def format_month_day(value):
    if value is None:
        return ""
    if hasattr(value, "strftime"):
        return f"{value.month}/{value.day}"
    text = normalize_text(value)
    if not text:
        return ""
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return f"{dt.month}/{dt.day}"
    except ValueError:
        return text


def load_info_safe(ticker):
    try:
        info = ticker.info
        return info if isinstance(info, dict) else {}
    except Exception:
        return {}


def load_fast_info_safe(ticker):
    try:
        fast_info = ticker.fast_info
        return dict(fast_info) if fast_info is not None else {}
    except Exception:
        return {}


def load_price_history(ticker):
    try:
        history = ticker.history(period="1y", interval="1d", auto_adjust=False)
    except Exception:
        return None
    if history is None or getattr(history, "empty", True):
        return None
    return history


def refresh_price_history(symbol):
    """日足だけを再取得し、既存の蓄積データへ上書き保存する。"""
    ticker = yf.Ticker(symbol)
    try:
        history = ticker.history(period="1y", interval="1d", auto_adjust=False)
    except Exception as error:
        raise RuntimeError(f"日足を取得できませんでした: {error}") from error
    if history is None or getattr(history, "empty", True):
        raise RuntimeError("日足を取得できませんでした（データが空です）")
    price_history = store_and_load_candles(symbol, history)
    return {
        "ticker": symbol,
        "fetchedCount": len(history.index),
        "priceHistory": price_history,
    }


def store_and_load_candles(symbol, history):
    """取得した日足を追記し、これまで蓄積した全OHLCVを返す。"""
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS review_price_history (
        ticker TEXT NOT NULL, trade_date TEXT NOT NULL, open REAL, high REAL,
        low REAL, close REAL, volume INTEGER, updated_at TEXT NOT NULL,
        PRIMARY KEY (ticker, trade_date))""")
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    if history is not None:
        rows = []
        for index, row in history.iterrows():
            open_price = to_float(row.get("Open"))
            high = to_float(row.get("High"))
            low = to_float(row.get("Low"))
            close = to_float(row.get("Close"))
            if any(value is None or value <= 0 for value in (open_price, high, low, close)):
                continue
            volume = to_float(row.get("Volume"))
            rows.append((symbol, index.strftime("%Y-%m-%d"), open_price,
                high, low, close,
                int(volume) if volume is not None else None, now))
        conn.executemany("""INSERT INTO review_price_history
            (ticker, trade_date, open, high, low, close, volume, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, trade_date) DO UPDATE SET open=excluded.open,
            high=excluded.high, low=excluded.low, close=excluded.close,
            volume=excluded.volume, updated_at=excluded.updated_at""", rows)
        conn.commit()
    stored = conn.execute("""SELECT trade_date, open, high, low, close, volume
        FROM review_price_history
        WHERE ticker = ? AND open > 0 AND high > 0 AND low > 0 AND close > 0
        ORDER BY trade_date""", (symbol,)).fetchall()
    conn.close()
    return [{"date": r[0], "open": r[1], "high": r[2], "low": r[3],
             "close": r[4], "volume": r[5]} for r in stored]


def store_review_snapshot(symbol, payload):
    snapshot = {key: value for key, value in payload.items() if key != "priceHistory"}
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS review_snapshots (
        ticker TEXT PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    conn.execute(
        """INSERT INTO review_snapshots (ticker, payload_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(ticker) DO UPDATE SET
             payload_json=excluded.payload_json, updated_at=excluded.updated_at""",
        (symbol, json.dumps(snapshot, ensure_ascii=False), now),
    )
    conn.commit()
    conn.close()


def get_history_fallback_prices(history):
    if history is None or getattr(history, "empty", True):
        return {}

    closes = history["Close"].dropna() if "Close" in history else []
    if len(closes) == 0:
        return {}

    high_date = None
    low_date = None
    if "High" in history:
        highs = history["High"].dropna()
        if len(highs):
            high_date = format_month_day(highs.idxmax())
    if "Low" in history:
        lows = history["Low"].dropna()
        if len(lows):
            low_date = format_month_day(lows.idxmin())

    result = {
        "currentPrice": to_float(closes.iloc[-1]),
        "previousClose": to_float(closes.iloc[-2]) if len(closes) >= 2 else None,
        "fiftyTwoWeekHigh": to_float(history["High"].max()) if "High" in history else None,
        "fiftyTwoWeekLow": to_float(history["Low"].min()) if "Low" in history else None,
        "fiftyTwoWeekHighDate": high_date,
        "fiftyTwoWeekLowDate": low_date,
    }
    return result


def build_overview(info, fast_info, history_fallback):
    overview = {key: info.get(field) for key, field in OVERVIEW_FIELDS.items()}
    overview["currentPrice"] = (
        overview.get("currentPrice")
        or fast_info.get("lastPrice")
        or fast_info.get("regularMarketPrice")
        or history_fallback.get("currentPrice")
    )
    overview["previousClose"] = (
        info.get("previousClose")
        or fast_info.get("previousClose")
        or history_fallback.get("previousClose")
    )
    overview["fiftyTwoWeekHigh"] = (
        overview.get("fiftyTwoWeekHigh")
        or fast_info.get("yearHigh")
        or history_fallback.get("fiftyTwoWeekHigh")
    )
    overview["fiftyTwoWeekLow"] = (
        overview.get("fiftyTwoWeekLow")
        or fast_info.get("yearLow")
        or history_fallback.get("fiftyTwoWeekLow")
    )
    overview["fiftyTwoWeekHighDate"] = history_fallback.get("fiftyTwoWeekHighDate") or ""
    overview["fiftyTwoWeekLowDate"] = history_fallback.get("fiftyTwoWeekLowDate") or ""
    return overview


def extract_financial_summary(ticker):
    table = getattr(ticker, "income_stmt", None)
    if table is None or getattr(table, "empty", True):
        return []

    row_candidates = {
        "revenue": ["Total Revenue", "Operating Revenue"],
        "operatingIncome": ["Operating Income"],
        "netIncome": ["Net Income", "Net Income Common Stockholders"],
    }

    def get_row_value(names, column):
        for name in names:
            if name in table.index:
                return to_int(table.loc[name, column])
        return None

    items = []
    for column in table.columns[:MAX_FINANCIAL_SUMMARY_PERIODS]:
        label = column.strftime("%Y-%m") if hasattr(column, "strftime") else str(column)
        items.append(
            {
                "period": label,
                "revenue": get_row_value(row_candidates["revenue"], column),
                "operatingIncome": get_row_value(row_candidates["operatingIncome"], column),
                "netIncome": get_row_value(row_candidates["netIncome"], column),
            }
        )
    return items


def extract_news(ticker):
    items = []
    for article in (getattr(ticker, "news", []) or [])[:6]:
        content = article.get("content") if isinstance(article, dict) else None
        source = content if isinstance(content, dict) else article
        title = normalize_text(source.get("title") or source.get("headline"))
        link = normalize_text(source.get("canonicalUrl", {}).get("url") if isinstance(source.get("canonicalUrl"), dict) else source.get("link"))
        publisher = normalize_text(source.get("provider", {}).get("displayName") if isinstance(source.get("provider"), dict) else source.get("publisher"))
        published_at = source.get("pubDate") or source.get("providerPublishTime")

        if published_at and isinstance(published_at, (int, float)):
            published_at = datetime.utcfromtimestamp(published_at).isoformat() + "Z"
        else:
            published_at = normalize_text(published_at)

        if title and link:
            items.append(
                {
                    "title": title,
                    "link": link,
                    "publisher": publisher,
                    "publishedAt": published_at,
                }
            )
    return items


def build_payload(symbol: str):
    ticker = yf.Ticker(symbol)
    info = load_info_safe(ticker)
    fast_info = load_fast_info_safe(ticker)
    history = load_price_history(ticker)
    history_fallback = get_history_fallback_prices(history)
    price_history = store_and_load_candles(symbol, history)

    overview = build_overview(info, fast_info, history_fallback)
    valuation = {key: info.get(field) for key, field in VALUATION_FIELDS.items()}
    profitability = {key: info.get(field) for key, field in PROFITABILITY_FIELDS.items()}
    analyst = {key: info.get(field) for key, field in ANALYST_FIELDS.items()}

    free_cashflow = to_float(info.get("freeCashflow"))
    total_revenue = to_float(info.get("totalRevenue"))
    profitability["fcfMargin"] = (free_cashflow / total_revenue) if free_cashflow and total_revenue else None

    payload = {
        "ticker": symbol,
        "name": normalize_text(info.get("longName") or info.get("shortName") or symbol),
        "currency": normalize_text(info.get("currency") or fast_info.get("currency") or "JPY").upper(),
        "overview": overview,
        "valuation": valuation,
        "profitability": profitability,
        "analyst": analyst,
        "financialSummary": extract_financial_summary(ticker),
        "news": extract_news(ticker),
        "priceHistory": price_history,
    }
    store_review_snapshot(symbol, payload)
    return payload


def main():
    symbol = normalize_text(sys.argv[1] if len(sys.argv) > 1 else "")
    if not symbol:
        raise SystemExit("Ticker is required")

    price_history_only = len(sys.argv) > 2 and sys.argv[2] == "--price-history"
    result = refresh_price_history(symbol) if price_history_only else build_payload(symbol)
    payload = json.dumps(result, ensure_ascii=False)
    sys.stdout.buffer.write(payload.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
