import json
import sys

import yfinance as yf


def main():
    payload = json.loads(sys.stdin.read() or "{}")
    tickers = payload.get("tickers", [])
    results = {}
    errors = {}

    seen = set()
    for raw_ticker in tickers:
        ticker = str(raw_ticker or "").strip()
        if not ticker or ticker in seen:
            continue
        seen.add(ticker)
        try:
            info = yf.Ticker(ticker).info
            results[ticker] = {
                "sector": str(info.get("sector") or "").strip(),
                "industry": str(info.get("industry") or "").strip(),
            }
        except Exception as exc:
            errors[ticker] = str(exc)

    print(json.dumps({"sectors": results, "errors": errors}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
