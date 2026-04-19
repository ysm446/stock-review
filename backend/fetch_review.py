import json
import sys
from datetime import datetime

import yfinance as yf


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


def to_float(value):
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


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
    for column in table.columns[:2]:
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
    info = ticker.info

    overview = {key: info.get(field) for key, field in OVERVIEW_FIELDS.items()}
    valuation = {key: info.get(field) for key, field in VALUATION_FIELDS.items()}
    profitability = {key: info.get(field) for key, field in PROFITABILITY_FIELDS.items()}
    analyst = {key: info.get(field) for key, field in ANALYST_FIELDS.items()}

    free_cashflow = to_float(info.get("freeCashflow"))
    total_revenue = to_float(info.get("totalRevenue"))
    profitability["fcfMargin"] = (free_cashflow / total_revenue) if free_cashflow and total_revenue else None

    return {
        "ticker": symbol,
        "name": normalize_text(info.get("longName") or info.get("shortName") or symbol),
        "currency": normalize_text(info.get("currency") or "JPY").upper(),
        "overview": overview,
        "valuation": valuation,
        "profitability": profitability,
        "analyst": analyst,
        "financialSummary": extract_financial_summary(ticker),
        "news": extract_news(ticker),
    }


def main():
    symbol = normalize_text(sys.argv[1] if len(sys.argv) > 1 else "")
    if not symbol:
        raise SystemExit("Ticker is required")

    print(json.dumps(build_payload(symbol), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
