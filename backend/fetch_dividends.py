import json
import sys
from datetime import timedelta

import yfinance as yf

from shared import to_float, convert_to_jpy


def estimate_annual_dividend(ticker_symbol: str) -> dict:
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
