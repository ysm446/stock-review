"""Stock screener engines.

Phase 1: QueryScreener and ValueScreener are fully implemented.
Phase 3+: PullbackScreener and AlphaScreener (stubs).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional

import pandas as pd

from src.core.indicators import calculate_value_score, get_score_label

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ScreenResult:
    """Single screening result for one stock."""

    ticker: str
    name: str
    value_score: float
    per: Optional[float] = None
    pbr: Optional[float] = None
    dividend_yield: Optional[float] = None
    roe: Optional[float] = None
    revenue_growth: Optional[float] = None
    market_cap: Optional[float] = None
    currency: Optional[str] = None
    sector: Optional[str] = None
    score_label: str = field(default="", init=False)

    def __post_init__(self) -> None:
        self.score_label = get_score_label(self.value_score)


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def _fmt_pct(value: Optional[float]) -> str:
    return f"{value * 100:.1f}%" if value is not None else "-"


def _fmt_float(value: Optional[float], decimals: int = 1) -> str:
    return f"{value:.{decimals}f}" if value is not None else "-"


def _fmt_market_cap(cap: Optional[float], currency: Optional[str]) -> str:
    if cap is None:
        return "-"
    if currency == "JPY":
        return f"¥{cap / 1e8:.0f}億"
    return f"${cap / 1e9:.1f}B"


def results_to_dataframe(results: list[ScreenResult]) -> pd.DataFrame:
    """Convert a list of ScreenResult to a display-ready DataFrame."""
    columns = [
        "ティッカー", "銘柄名", "スコア", "判定",
        "PER", "PBR", "配当利回り", "ROE", "売上成長率",
        "セクター", "時価総額",
    ]
    if not results:
        return pd.DataFrame(columns=columns)
    rows = [
        {
            "ティッカー": r.ticker,
            "銘柄名": r.name,
            "スコア": r.value_score,
            "判定": r.score_label,
            "PER": _fmt_float(r.per, 1),
            "PBR": _fmt_float(r.pbr, 2),
            "配当利回り": _fmt_pct(r.dividend_yield),
            "ROE": _fmt_pct(r.roe),
            "売上成長率": _fmt_pct(r.revenue_growth),
            "セクター": r.sector or "-",
            "時価総額": _fmt_market_cap(r.market_cap, r.currency),
        }
        for r in results
    ]
    return pd.DataFrame(rows, columns=columns)


def _build_result(ticker: str, info: dict, weights: dict) -> ScreenResult:
    """Build a ScreenResult from raw info dict and score weights."""
    score = calculate_value_score(info, weights)
    return ScreenResult(
        ticker=ticker or info.get("symbol", ""),
        name=info.get("shortName") or info.get("longName", ""),
        value_score=score,
        per=info.get("trailingPE") or info.get("forwardPE"),
        pbr=info.get("priceToBook"),
        dividend_yield=info.get("dividendYield"),
        roe=info.get("returnOnEquity"),
        revenue_growth=info.get("revenueGrowth"),
        market_cap=info.get("marketCap"),
        currency=info.get("currency"),
        sector=info.get("sector"),
    )


# ---------------------------------------------------------------------------
# QueryScreener
# ---------------------------------------------------------------------------

class QueryScreener:
    """Bulk-fetch equities via yfinance EquityQuery, then rank by value score."""

    def __init__(self, yahoo_client, presets: dict) -> None:
        """
        Args:
            yahoo_client: YahooClient instance.
            presets: Presets dict loaded from config/presets.yaml.
        """
        self.client = yahoo_client
        self.presets = presets

    def screen(
        self,
        region: str,
        preset: str,
        limit: int = 30,
    ) -> list[ScreenResult]:
        """Run screening.

        Args:
            region: Region key (e.g. "japan", "us").
            preset: Preset key (e.g. "value", "high-dividend").
            limit: Maximum number of results to return.

        Returns:
            List of ScreenResult sorted by value_score descending.
        """
        preset_cfg = self.presets.get(preset, {})
        filters = preset_cfg.get("filters", {})
        weights = preset_cfg.get("score_weights", {})

        quotes = self.client.screen_equities(region, filters)
        logger.info("QueryScreener: %d quotes from yfinance for region=%s preset=%s", len(quotes), region, preset)

        results = [
            _build_result(q.get("symbol", ""), q, weights)
            for q in quotes
        ]
        results.sort(key=lambda r: r.value_score, reverse=True)
        results = results[:limit]

        # Fetch localized names for supported regions
        locale_map = {
            "japan": ("ja-JP", "JP"),
            "china": ("zh-TW", "HK"),
            "korea": ("ko-KR", "KR"),
        }
        if region in locale_map and results:
            lang, reg = locale_map[region]
            tickers = [r.ticker for r in results if r.ticker]
            localized = self.client.get_localized_names(tickers, lang=lang, region=reg)
            for r in results:
                if r.ticker in localized:
                    r.name = localized[r.ticker]

        return results


# ---------------------------------------------------------------------------
# ValueScreener
# ---------------------------------------------------------------------------

class ValueScreener:
    """Fetch a user-supplied list of tickers individually, filter, and score."""

    def __init__(self, yahoo_client, presets: dict) -> None:
        self.client = yahoo_client
        self.presets = presets

    def screen(
        self,
        tickers: list[str],
        preset: str = "value",
    ) -> list[ScreenResult]:
        """Screen an explicit list of tickers.

        Args:
            tickers: List of ticker symbols.
            preset: Preset key for filters and weights.

        Returns:
            Filtered and sorted list of ScreenResult.
        """
        preset_cfg = self.presets.get(preset, {})
        filters = preset_cfg.get("filters", {})
        weights = preset_cfg.get("score_weights", {})

        results = []
        for ticker in tickers:
            info = self.client.get_ticker_info(ticker.strip())
            if not info:
                continue
            if not self._passes_filters(info, filters):
                continue
            results.append(_build_result(ticker, info, weights))

        results.sort(key=lambda r: r.value_score, reverse=True)
        return results

    def _passes_filters(self, info: dict, filters: dict) -> bool:
        per = info.get("trailingPE") or info.get("forwardPE")
        if "per_max" in filters and per is not None:
            if per > filters["per_max"]:
                return False
        pbr = info.get("priceToBook")
        if "pbr_max" in filters and pbr is not None:
            if pbr > filters["pbr_max"]:
                return False
        div = (info.get("dividendYield") or 0.0)
        if "dividend_yield_min" in filters:
            if div * 100 < filters["dividend_yield_min"]:
                return False
        return True


# ---------------------------------------------------------------------------
# Stubs for future phases
# ---------------------------------------------------------------------------

class PullbackScreener:
    """Phase 3: EquityQuery → RSI/Bollinger pullback filter → value score."""

    def __init__(self, yahoo_client, presets: dict) -> None:
        self.client = yahoo_client
        self.presets = presets

    def screen(self, region: str, preset: str = "pullback", limit: int = 30) -> list[ScreenResult]:
        raise NotImplementedError("PullbackScreener is implemented in Phase 3.")


class AlphaScreener:
    """Phase 3: 4-stage pipeline – EquityQuery → alpha score → pullback → 2-axis rank."""

    def __init__(self, yahoo_client, presets: dict) -> None:
        self.client = yahoo_client
        self.presets = presets

    def screen(self, region: str, preset: str = "alpha", limit: int = 30) -> list[ScreenResult]:
        raise NotImplementedError("AlphaScreener is implemented in Phase 3.")
