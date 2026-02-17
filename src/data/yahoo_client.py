"""yfinance wrapper with caching, rate limiting, and data sanitization."""
import hashlib
import logging
import time
from typing import Optional

import pandas as pd
import yfinance as yf

from src.data.cache_manager import CacheManager

logger = logging.getLogger(__name__)

# Maps region key → yfinance EquityQuery region code
_REGION_CODE: dict[str, str] = {
    "japan": "jp",
    "us": "us",
    "europe": "gb",
    "hongkong": "hk",
    "asean": "sg",
    "china": "cn",
    "korea": "kr",
    "australia": "au",
    "india": "in",
    "canada": "ca",
}


class YahooClient:
    """yfinance wrapper with caching, rate limiting, and sanitization."""

    def __init__(self, cache_manager: Optional[CacheManager] = None):
        """
        Args:
            cache_manager: CacheManager instance. Creates a default one if None.
        """
        self.cache = cache_manager or CacheManager()
        self._last_call: float = 0.0

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _rate_limit(self) -> None:
        """Ensure at least 1 second between API calls."""
        elapsed = time.time() - self._last_call
        if elapsed < 1.0:
            time.sleep(1.0 - elapsed)
        self._last_call = time.time()

    def _sanitize_info(self, info: dict) -> dict:
        """Normalize and filter unreasonable values from ticker info."""
        info = dict(info)
        # yfinance sometimes returns dividend yield as percentage (e.g. 3.5 instead of 0.035)
        div_yield = info.get("dividendYield")
        if div_yield is not None and div_yield > 1.0:
            info["dividendYield"] = div_yield / 100.0
        # Remove unreasonable dividend yields (> 15%)
        if (info.get("dividendYield") or 0.0) > 0.15:
            info["dividendYield"] = None
        # Remove near-zero or negative PBR (data error)
        pbr = info.get("priceToBook")
        if pbr is not None and pbr < 0.1:
            info["priceToBook"] = None
        return info

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_ticker_info(self, ticker: str) -> dict:
        """Get ticker info dict, with 24h caching.

        Args:
            ticker: Ticker symbol (e.g. "7203.T", "AAPL").

        Returns:
            Info dict. Empty dict on failure.
        """
        key = f"info_{ticker}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        self._rate_limit()
        try:
            info = yf.Ticker(ticker).info or {}
            result = self._sanitize_info(info)
            self.cache.set(key, result)
            return result
        except Exception as e:
            logger.warning("get_ticker_info(%s) failed: %s", ticker, e)
            return {}

    def get_financials(self, ticker: str) -> dict:
        """Get annual income statement data.

        Returns:
            Dict with keys: revenue, operating_income, net_income.
            Each value is a {date_str: amount} dict (latest year first).
        """
        key = f"financials_{ticker}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        self._rate_limit()
        result: dict = {}
        try:
            t = yf.Ticker(ticker)
            income = t.income_stmt
            if income is not None and not income.empty:
                for label, result_key in [
                    ("Total Revenue", "revenue"),
                    ("Operating Income", "operating_income"),
                    ("Net Income", "net_income"),
                ]:
                    if label in income.index:
                        row = income.loc[label].dropna()
                        result[result_key] = {
                            str(k.date()): float(v) for k, v in row.items()
                        }
            self.cache.set(key, result)
        except Exception as e:
            logger.warning("get_financials(%s) failed: %s", ticker, e)
        return result

    def get_history(self, ticker: str, period: str = "2y") -> pd.DataFrame:
        """Get OHLCV price history.

        Args:
            ticker: Ticker symbol.
            period: yfinance period string (e.g. "2y", "1y", "6mo").

        Returns:
            DataFrame with DatetimeIndex. Empty DataFrame on failure.
        """
        key = f"history_{ticker}_{period}"
        cached = self.cache.get(key)
        if cached is not None:
            df = pd.DataFrame(cached)
            if "Date" in df.columns:
                df["Date"] = pd.to_datetime(df["Date"])
                df = df.set_index("Date")
            return df
        self._rate_limit()
        try:
            hist = yf.Ticker(ticker).history(period=period)
            if not hist.empty:
                serializable = hist.reset_index()
                serializable["Date"] = serializable["Date"].astype(str)
                self.cache.set(key, serializable.to_dict(orient="list"))
            return hist
        except Exception as e:
            logger.warning("get_history(%s) failed: %s", ticker, e)
            return pd.DataFrame()

    def get_analyst_data(self, ticker: str) -> dict:
        """Get analyst price targets and recommendation.

        Returns:
            Dict with keys: target_high, target_mean, target_low,
            recommendation, analyst_count.
        """
        key = f"analyst_{ticker}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        self._rate_limit()
        try:
            info = yf.Ticker(ticker).info or {}
            result = {
                "target_high": info.get("targetHighPrice"),
                "target_mean": info.get("targetMeanPrice"),
                "target_low": info.get("targetLowPrice"),
                "recommendation": info.get("recommendationKey"),
                "analyst_count": info.get("numberOfAnalystOpinions"),
            }
            self.cache.set(key, result)
            return result
        except Exception as e:
            logger.warning("get_analyst_data(%s) failed: %s", ticker, e)
            return {}

    def get_news(self, ticker: str) -> list[dict]:
        """Get latest news for a ticker (up to 10 items).

        Returns:
            List of dicts with keys: title, link, publisher.
        """
        key = f"news_{ticker}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        self._rate_limit()
        try:
            raw_news = yf.Ticker(ticker).news or []
            result = []
            for n in raw_news[:10]:
                # Handle both old and new yfinance news formats
                content = n.get("content", {})
                if content:
                    title = content.get("title", "")
                    link = content.get("canonicalUrl", {}).get("url", "")
                    publisher = content.get("provider", {}).get("displayName", "")
                else:
                    title = n.get("title", "")
                    link = n.get("link", "")
                    publisher = n.get("publisher", "")
                result.append({"title": title, "link": link, "publisher": publisher})
            self.cache.set(key, result)
            return result
        except Exception as e:
            logger.warning("get_news(%s) failed: %s", ticker, e)
            return []

    def screen_equities(self, region: str, filters: dict) -> list[dict]:
        """Screen equities via yfinance EquityQuery.

        Args:
            region: Region key (e.g. "japan", "us").
            filters: Filter dict from preset config.

        Returns:
            List of sanitized ticker info dicts.
        """
        filter_hash = hashlib.md5(
            str(sorted(filters.items())).encode()
        ).hexdigest()[:8]
        key = f"screen_{region}_{filter_hash}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached

        from yfinance import EquityQuery

        region_code = _REGION_CODE.get(region, region)
        queries = self._build_equity_queries(filters, region_code)

        if len(queries) > 1:
            eq = EquityQuery("and", queries)
        elif len(queries) == 1:
            eq = queries[0]
        else:
            eq = EquityQuery("and", [
                EquityQuery("eq", ["region", region_code]),
                EquityQuery("gte", ["intradayprice", 1]),
            ])

        try:
            self._rate_limit()
            # yfinance 1.x: use yf.screen() function instead of Screener class
            resp = yf.screen(eq, size=100, sortField="intradaymarketcap", sortAsc=False)
            quotes = resp.get("quotes", [])
            result = [self._sanitize_info(q) for q in quotes]
            self.cache.set(key, result)
            return result
        except Exception as e:
            logger.warning("screen_equities(region=%s) failed: %s", region, e)
            return []

    def _build_equity_queries(self, filters: dict, region_code: str) -> list:
        """Build EquityQuery list from preset filters.

        Field names valid in yfinance 1.x (from EQUITY_SCREENER_FIELDS):
          peratio.lasttwelvemonths, pricebookratio.quarterly,
          forward_dividend_yield, returnonequity.lasttwelvemonths,
          totalrevenues1yrgrowth.lasttwelvemonths, intradaymarketcap
        """
        from yfinance import EquityQuery

        queries: list = [EquityQuery("eq", ["region", region_code])]

        # PER: use btwn [0, max] to exclude negative PE
        if "per_max" in filters and filters["per_max"] is not None:
            queries.append(
                EquityQuery("btwn", ["peratio.lasttwelvemonths", 0, filters["per_max"]])
            )

        # PBR: pricebookratio.quarterly is the valid field in yfinance 1.x
        if "pbr_max" in filters and filters["pbr_max"] is not None:
            queries.append(
                EquityQuery("btwn", ["pricebookratio.quarterly", 0, filters["pbr_max"]])
            )

        # Dividend yield: forward_dividend_yield field (value in %, e.g. 3.5 = 3.5%)
        if "dividend_yield_min" in filters and filters["dividend_yield_min"] is not None:
            queries.append(
                EquityQuery("gte", ["forward_dividend_yield", filters["dividend_yield_min"]])
            )

        # Market cap
        if "market_cap_min" in filters and filters["market_cap_min"] is not None:
            queries.append(
                EquityQuery("gte", ["intradaymarketcap", filters["market_cap_min"]])
            )

        return queries

    def get_localized_names(
        self,
        tickers: list[str],
        lang: str = "ja-JP",
        region: str = "JP",
    ) -> dict[str, str]:
        """Batch-fetch localized (e.g. Japanese) display names for a list of tickers.

        Uses Yahoo Finance v7/finance/quote with the specified locale.
        The `longName` field returns the localized name (e.g. 'トヨタ自動車').

        Args:
            tickers: List of ticker symbols.
            lang: BCP-47 language tag (e.g. 'ja-JP').
            region: Yahoo Finance region code (e.g. 'JP').

        Returns:
            Dict mapping ticker → localized name. Missing tickers are omitted.
        """
        if not tickers:
            return {}
        key = f"names_{lang}_{hashlib.md5(','.join(sorted(tickers)).encode()).hexdigest()[:12]}"
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        try:
            import yfinance.data as yfdata
            session = yfdata.YfData(session=None)
            resp = session.get(
                url="https://query2.finance.yahoo.com/v7/finance/quote",
                params={
                    "symbols": ",".join(tickers),
                    "lang": lang,
                    "region": region,
                    "corsDomain": "finance.yahoo.com",
                },
            )
            if resp.status_code != 200:
                return {}
            result = {
                q["symbol"]: q.get("longName") or q.get("shortName") or q["symbol"]
                for q in resp.json().get("quoteResponse", {}).get("result", [])
                if "symbol" in q
            }
            self.cache.set(key, result)
            return result
        except Exception as e:
            logger.warning("get_localized_names failed: %s", e)
            return {}

    def is_etf(self, ticker: str) -> bool:
        """Return True if the ticker is an ETF.

        Checks quoteType field first, then falls back to revenue history check
        (ETFs have no revenue history).
        """
        info = self.get_ticker_info(ticker)
        if info.get("quoteType") == "ETF":
            return True
        fin = self.get_financials(ticker)
        return not bool(fin.get("revenue"))
