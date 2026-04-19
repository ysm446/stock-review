import json
import sys

import yfinance as yf


FX_TICKERS = {
    "USD": "USDJPY=X",
    "EUR": "EURJPY=X",
    "GBP": "GBPJPY=X",
    "AUD": "AUDJPY=X",
    "CAD": "CADJPY=X",
    "HKD": "HKDJPY=X",
}


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

    return float(price), (currency or "USD")


def convert_to_jpy(price: float, currency: str):
    normalized = (currency or "JPY").upper()
    if normalized == "JPY":
        return float(price), 1.0

    fx_ticker = FX_TICKERS.get(normalized)
    if not fx_ticker:
        raise ValueError(f"Unsupported currency: {normalized}")

    fx_price, _ = get_last_price(fx_ticker)
    return float(price) * float(fx_price), float(fx_price)


def fetch_quote(ticker: str):
    normalized = ticker.strip()
    if not normalized:
        raise ValueError("Ticker is empty")

    price, currency = get_last_price(normalized)
    price_jpy, fx_rate = convert_to_jpy(price, currency)

    return {
        "price": float(price),
        "currency": currency.upper(),
        "price_jpy": float(price_jpy),
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
