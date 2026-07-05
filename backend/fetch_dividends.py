import json
import sys
from datetime import timedelta

import yfinance as yf

from shared import to_float, convert_to_jpy, normalize_price_currency


def estimate_annual_dividend(ticker_symbol: str) -> dict:
    ticker = yf.Ticker(ticker_symbol)
    info = ticker.info
    raw_currency = info.get("currency")
    if not raw_currency:
        raise ValueError(f"{ticker_symbol}: currency unavailable from Yahoo")
    _, currency = normalize_price_currency(None, raw_currency)

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

    if annual_per_share is not None and annual_per_share > 0:
        annual_per_share, _ = normalize_price_currency(annual_per_share, raw_currency)

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

    # 同一銘柄の複数ロットは合算してから見積もる（上書きで過少計上しない）。
    shares_by_ticker: dict[str, float] = {}
    ticker_order: list[str] = []
    for holding in holdings:
        ticker = str(holding.get("ticker") or "").strip()
        shares = to_float(holding.get("shares")) or 0
        if not ticker or shares <= 0:
            continue
        if ticker not in shares_by_ticker:
            ticker_order.append(ticker)
            shares_by_ticker[ticker] = 0.0
        shares_by_ticker[ticker] += float(shares)

    for ticker in ticker_order:
        shares = shares_by_ticker[ticker]
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
