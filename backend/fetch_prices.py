import json
import sys

from shared import get_yf_price, convert_to_jpy


def fetch_quote(ticker: str) -> dict:
    normalized = ticker.strip()
    if not normalized:
        raise ValueError("Ticker is empty")

    price, previous_close, currency = get_yf_price(normalized)
    price_jpy, fx_rate = convert_to_jpy(price, currency)
    previous_close_jpy, _ = convert_to_jpy(previous_close, currency)

    return {
        "price": float(price),
        "previous_close": float(previous_close),
        "currency": currency.upper(),
        "price_jpy": float(price_jpy),
        "previous_close_jpy": float(previous_close_jpy),
        "fx_rate_jpy": float(fx_rate),
    }


def main():
    tickers = []
    seen = set()
    for ticker in sys.argv[1:]:
        normalized = ticker.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            tickers.append(normalized)

    quotes = {}
    errors = {}

    for ticker in tickers:
        try:
            quotes[ticker] = fetch_quote(ticker)
        except Exception as exc:  # pragma: no cover - network/API errors vary
            errors[ticker] = str(exc)

    print(json.dumps({"quotes": quotes, "errors": errors}, ensure_ascii=False))
    return 0 if quotes or not tickers else 1


if __name__ == "__main__":
    raise SystemExit(main())
