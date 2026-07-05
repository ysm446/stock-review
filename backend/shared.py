"""Shared utilities for backend scripts."""
from __future__ import annotations

import os
from pathlib import Path


def atomic_write_text(path: Path, text: str, encoding: str = "utf-8") -> None:
    """一時ファイル + rename で書き込み、クラッシュ時のファイル破損（途中書き）を防ぐ。"""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding=encoding)
    os.replace(tmp, path)


FX_TICKERS = {
    "USD": "USDJPY=X",
    "EUR": "EURJPY=X",
    "GBP": "GBPJPY=X",
    "AUD": "AUDJPY=X",
    "CAD": "CADJPY=X",
    "HKD": "HKDJPY=X",
}

# Yahoo は一部市場で補助単位の通貨コードを返す（例: ロンドン市場の GBp = ペンス）。
# 大文字化すると GBp と GBP の区別が消えるため、大文字化前にここで主要通貨へ正規化する。
MINOR_UNIT_CURRENCIES = {
    "GBp": ("GBP", 100.0),
    "GBX": ("GBP", 100.0),
    "ZAc": ("ZAR", 100.0),
    "ILA": ("ILS", 100.0),
}


def normalize_price_currency(price, currency) -> tuple[float | None, str]:
    """(価格, Yahoo通貨コード) を補助単位換算済みの (価格, ISO主要通貨) にして返す。"""
    raw = str(currency or "").strip()
    if raw in MINOR_UNIT_CURRENCIES:
        major, scale = MINOR_UNIT_CURRENCIES[raw]
        return (float(price) / scale if price is not None else None), major
    return (float(price) if price is not None else None), raw.upper()


def to_float(value) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def get_yf_price(ticker: str, *, require_currency: bool = False) -> tuple[float, float, str]:
    """Return (price, previous_close, currency) for any ticker.

    require_currency=True のとき、Yahoo が通貨を返さなければ推測せずにエラーにする
    （評価額・履歴など永続データの経路では誤った通貨での換算を防ぐ）。
    """
    import yfinance as yf  # 重い依存のため遅延 import（chat サーバー等の起動を遅らせない）

    stock = yf.Ticker(ticker)
    info = stock.fast_info
    price = info.get("lastPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    previous_close = info.get("previousClose")
    raw_currency = info.get("currency")
    if not raw_currency:
        if require_currency:
            raise ValueError(f"{ticker}: currency unavailable from Yahoo")
        raw_currency = "USD"

    if price is None or previous_close is None:
        history = stock.history(period="5d", interval="1d", auto_adjust=False)
        if history.empty:
            raise ValueError("No market data returned")
        closes = history["Close"].dropna()
        if price is None:
            price = float(closes.iloc[-1])
        if previous_close is None:
            previous_close = float(closes.iloc[-2]) if len(closes) >= 2 else float(closes.iloc[-1])

    price, currency = normalize_price_currency(price, raw_currency)
    previous_close, _ = normalize_price_currency(previous_close, raw_currency)
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
