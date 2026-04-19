import json
import sys
from datetime import datetime, timedelta

import yfinance as yf


FX_TICKERS = {
    "USD": "USDJPY=X",
    "EUR": "EURJPY=X",
    "GBP": "GBPJPY=X",
    "AUD": "AUDJPY=X",
    "CAD": "CADJPY=X",
    "HKD": "HKDJPY=X",
}


def to_float(value):
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def get_last_price(ticker: str):
    stock = yf.Ticker(ticker)
    info = stock.fast_info
    price = info.get("lastPrice") or info.get("regularMarketPrice") or info.get("previousClose")
    currency = info.get("currency")

    if price is None:
        history = stock.history(period="5d", interval="1d", auto_adjust=False)
        if history.empty:
            raise ValueError("No market data returned")
        price = float(history["Close"].dropna().iloc[-1])

    return float(price), (currency or "USD").upper()


def convert_to_jpy(value: float, currency: str):
    normalized = (currency or "JPY").upper()
    if normalized == "JPY":
        return float(value), 1.0
    fx_ticker = FX_TICKERS.get(normalized)
    if not fx_ticker:
        raise ValueError(f"Unsupported currency: {normalized}")
    fx_price, _ = get_last_price(fx_ticker)
    return float(value) * float(fx_price), float(fx_price)


def estimate_annual_dividend(ticker_symbol: str):
    ticker = yf.Ticker(ticker_symbol)
    info = ticker.info
    currency = (info.get("currency") or "JPY").upper()

    annual_per_share = to_float(info.get("trailingAnnualDividendRate"))
    if annual_per_share is None or annual_per_share <= 0:
        annual_per_share = to_float(info.get("dividendRate"))

    if annual_per_share is None or annual_per_share <= 0:
        dividends = ticker.dividends
        if dividends is not None and not dividends.empty:
            cutoff = dividends.index.max() - timedelta(days=366)
            recent = dividends[dividends.index >= cutoff]
            if not recent.empty:
                annual_per_share = float(recent.sum())

    if annual_per_share is None or annual_per_share <= 0:
        return {
            "annualDividendPerShare": None,
            "annualDividendPerShareJpy": None,
            "currency": currency,
            "fxRateJpy": None,
        }

    annual_per_share_jpy, fx_rate = convert_to_jpy(annual_per_share, currency)
    return {
        "annualDividendPerShare": float(annual_per_share),
        "annualDividendPerShareJpy": float(annual_per_share_jpy),
        "currency": currency,
        "fxRateJpy": float(fx_rate),
    }


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    holdings = payload.get("holdings", [])

    summary = {
        "totalAnnualDividendJpy": 0,
        "positions": {},
        "errors": {},
    }

    for holding in holdings:
        ticker = str(holding.get("ticker") or "").strip()
        shares = to_float(holding.get("shares")) or 0
        if not ticker or shares <= 0:
            continue

        try:
            estimate = estimate_annual_dividend(ticker)
            annual_per_share_jpy = estimate.get("annualDividendPerShareJpy")
            total_jpy = float(annual_per_share_jpy) * float(shares) if annual_per_share_jpy else 0.0
            summary["positions"][ticker] = {
                **estimate,
                "shares": int(round(shares)),
                "totalAnnualDividendJpy": float(total_jpy),
            }
            summary["totalAnnualDividendJpy"] += float(total_jpy)
        except Exception as exc:
            summary["errors"][ticker] = str(exc)

    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
