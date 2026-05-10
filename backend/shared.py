"""Shared utilities for backend scripts."""
from __future__ import annotations

import yfinance as yf


FX_TICKERS = {
    "USD": "USDJPY=X",
    "EUR": "EURJPY=X",
    "GBP": "GBPJPY=X",
    "AUD": "AUDJPY=X",
    "CAD": "CADJPY=X",
    "HKD": "HKDJPY=X",
}


def to_float(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def get_yf_price(ticker: str) -> tuple[float, float, str]:
    """Return (price, previous_close, currency) for any ticker."""
    stock = yf.Ticker(ticker)
    info = stock.fast_info
    price = info.get("lastPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    previous_close = info.get("previousClose")
    currency = (info.get("currency") or "USD").upper()

    if price is None or previous_close is None:
        history = stock.history(period="5d", interval="1d", auto_adjust=False)
        if history.empty:
            raise ValueError("No market data returned")
        closes = history["Close"].dropna()
        if price is None:
            price = float(closes.iloc[-1])
        if previous_close is None:
            previous_close = float(closes.iloc[-2]) if len(closes) >= 2 else float(closes.iloc[-1])

    return float(price), float(previous_close), currency


def convert_to_jpy(price: float, currency: str) -> tuple[float, float]:
    """Convert price from currency to JPY. Returns (price_jpy, fx_rate)."""
    normalized = (currency or "JPY").upper()
    if normalized == "JPY":
        return float(price), 1.0
    fx_ticker = FX_TICKERS.get(normalized)
    if not fx_ticker:
        raise ValueError(f"Unsupported currency: {normalized}")
    fx_price, _, _ = get_yf_price(fx_ticker)
    return float(price) * fx_price, fx_price
