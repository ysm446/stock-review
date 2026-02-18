"""Individual stock report generation."""
import logging
from typing import Optional

from src.core.indicators import calculate_value_score, get_score_label
from src.utils.formatter import (
    fmt_float,
    fmt_market_cap,
    fmt_pct,
    fmt_price,
    markdown_table,
)

logger = logging.getLogger(__name__)

# Recommendation key → Japanese label
_REC_LABELS: dict[str, str] = {
    "strongBuy": "強気買い",
    "buy": "買い",
    "hold": "中立",
    "sell": "売り",
    "strongSell": "強気売り",
}


class ReportGenerator:
    """Generate individual stock reports combining fundamental data and LLM analysis."""

    def __init__(self, yahoo_client, llm_client) -> None:
        """
        Args:
            yahoo_client: YahooClient instance.
            llm_client: LLMClient instance (may be unavailable).
        """
        self.yahoo = yahoo_client
        self.llm = llm_client

    def generate(self, ticker: str) -> dict:
        """Fetch data and build a structured report dict.

        Args:
            ticker: Ticker symbol (e.g. "7203.T", "AAPL").

        Returns:
            Report dict. On critical failure, returns dict with "error" key set.
        """
        ticker = ticker.strip().upper()
        info = self.yahoo.get_ticker_info(ticker)

        if not info:
            return {"ticker": ticker, "error": f"ティッカー '{ticker}' のデータが取得できませんでした。"}

        financials = self.yahoo.get_financials(ticker)
        analyst = self.yahoo.get_analyst_data(ticker)
        news = self.yahoo.get_news(ticker)

        currency = info.get("currency")
        value_score = calculate_value_score(info)
        score_label = get_score_label(value_score)

        # LLM analysis — only pass lightweight numeric data to reduce token usage
        llm_analysis = ""
        if self.llm and self.llm.is_available():
            stock_data = {
                "ticker": ticker,
                "name": info.get("longName") or info.get("shortName") or ticker,
                "sector": info.get("sector"),
                "per": info.get("trailingPE") or info.get("forwardPE"),
                "pbr": info.get("priceToBook"),
                "dividend_yield_pct": (info.get("dividendYield") or 0) * 100,
                "roe_pct": (info.get("returnOnEquity") or 0) * 100,
                "revenue_growth_pct": (info.get("revenueGrowth") or 0) * 100,
                "value_score": value_score,
                "score_label": score_label,
                "analyst_recommendation": analyst.get("recommendation"),
                "analyst_count": analyst.get("analyst_count"),
                "target_mean": analyst.get("target_mean"),
                "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
            }
            try:
                llm_analysis = self.llm.analyze_stock(stock_data) or ""
            except Exception as e:
                logger.warning("LLM analysis failed: %s", e)

        return {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or ticker,
            "sector": info.get("sector") or "-",
            "industry": info.get("industry") or "-",
            "currency": currency,
            "market_cap": info.get("marketCap"),
            "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
            "week52_high": info.get("fiftyTwoWeekHigh"),
            "week52_low": info.get("fiftyTwoWeekLow"),
            # Valuation
            "per": info.get("trailingPE") or info.get("forwardPE"),
            "pbr": info.get("priceToBook"),
            "ev_ebitda": info.get("enterpriseToEbitda"),
            "dividend_yield": info.get("dividendYield"),
            # Financials (up to 3 periods)
            "financials": {
                "revenue": dict(list(financials.get("revenue", {}).items())[:3]),
                "operating_income": dict(list(financials.get("operating_income", {}).items())[:3]),
                "net_income": dict(list(financials.get("net_income", {}).items())[:3]),
            },
            # Profitability
            "roe": info.get("returnOnEquity"),
            "roa": info.get("returnOnAssets"),
            "operating_margin": info.get("operatingMargins"),
            "fcf_margin": info.get("freeCashflow") and info.get("totalRevenue") and (
                info["freeCashflow"] / info["totalRevenue"]
                if info.get("totalRevenue") else None
            ),
            # Analyst
            "analyst": {
                "target_high": analyst.get("target_high"),
                "target_mean": analyst.get("target_mean"),
                "target_low": analyst.get("target_low"),
                "recommendation": analyst.get("recommendation"),
                "analyst_count": analyst.get("analyst_count"),
            },
            # Score
            "value_score": value_score,
            "score_label": score_label,
            # News
            "news": news[:5],
            # LLM
            "llm_analysis": llm_analysis,
            # No error
            "error": None,
        }

    def format_markdown(self, data: dict) -> str:
        """Format report dict as a Markdown string.

        Args:
            data: Report dict from generate().

        Returns:
            Markdown-formatted report string.
        """
        if data.get("error"):
            return f"## エラー\n\n{data['error']}"

        currency = data.get("currency")
        lines: list[str] = []

        # --- Header ---
        ticker = data["ticker"]
        name = data["name"]
        lines.append(f"## {name}  `{ticker}`")
        lines.append("")
        lines.append(f"**セクター:** {data['sector']}　｜　**業種:** {data['industry']}")
        lines.append("")

        # --- 基本情報 ---
        lines.append("### 基本情報")
        basic_rows = [
            ["時価総額", fmt_market_cap(data.get("market_cap"), currency)],
            ["現在株価", fmt_price(data.get("current_price"), currency)],
            ["52週高値", fmt_price(data.get("week52_high"), currency)],
            ["52週安値", fmt_price(data.get("week52_low"), currency)],
        ]
        lines.append(markdown_table(["項目", "値"], basic_rows))
        lines.append("")

        # --- バリュエーション ---
        lines.append("### バリュエーション")
        val_rows = [
            ["PER (実績)", fmt_float(data.get("per"), 1) + "倍" if data.get("per") else "-"],
            ["PBR", fmt_float(data.get("pbr"), 2) + "倍" if data.get("pbr") else "-"],
            ["EV/EBITDA", fmt_float(data.get("ev_ebitda"), 1) + "倍" if data.get("ev_ebitda") else "-"],
            ["配当利回り", fmt_pct(data.get("dividend_yield"))],
        ]
        lines.append(markdown_table(["指標", "値"], val_rows))
        lines.append("")

        # --- 財務サマリー ---
        financials = data.get("financials", {})
        revenue = financials.get("revenue", {})
        op_income = financials.get("operating_income", {})
        net_income = financials.get("net_income", {})

        if revenue:
            lines.append("### 財務サマリー")
            dates = sorted(revenue.keys(), reverse=True)[:3]

            def _fmt_fin(val: Optional[float]) -> str:
                if val is None:
                    return "-"
                if currency == "JPY":
                    return f"¥{val / 1e8:.0f}億"
                return f"${val / 1e9:.2f}B"

            fin_headers = ["期間"] + dates
            fin_rows = [
                ["売上高"] + [_fmt_fin(revenue.get(d)) for d in dates],
                ["営業利益"] + [_fmt_fin(op_income.get(d)) for d in dates],
                ["純利益"] + [_fmt_fin(net_income.get(d)) for d in dates],
            ]
            lines.append(markdown_table(fin_headers, fin_rows))
            lines.append("")

        # --- 収益性 ---
        lines.append("### 収益性")
        prof_rows = [
            ["ROE", fmt_pct(data.get("roe"))],
            ["ROA", fmt_pct(data.get("roa"))],
            ["営業利益率", fmt_pct(data.get("operating_margin"))],
            ["FCF マージン", fmt_pct(data.get("fcf_margin"))],
        ]
        lines.append(markdown_table(["指標", "値"], prof_rows))
        lines.append("")

        # --- アナリストコンセンサス ---
        analyst = data.get("analyst", {})
        if any(v is not None for v in analyst.values()):
            lines.append("### アナリストコンセンサス")
            rec_key = analyst.get("recommendation") or ""
            rec_label = _REC_LABELS.get(rec_key, rec_key or "-")
            count = analyst.get("analyst_count")
            count_str = f"{count}名" if count else "-"
            ana_rows = [
                ["目標株価 (高値)", fmt_price(analyst.get("target_high"), currency)],
                ["目標株価 (平均)", fmt_price(analyst.get("target_mean"), currency)],
                ["目標株価 (安値)", fmt_price(analyst.get("target_low"), currency)],
                ["レーティング", rec_label],
                ["アナリスト数", count_str],
            ]
            lines.append(markdown_table(["項目", "値"], ana_rows))
            lines.append("")

        # --- バリュースコア ---
        score = data.get("value_score", 0.0)
        label = data.get("score_label", "-")
        score_bar = _score_bar(score)
        lines.append("### バリュースコア")
        lines.append(f"**{score:.1f} / 100** — {label}")
        lines.append("")
        lines.append(score_bar)
        lines.append("")

        # --- LLM 分析 ---
        llm = data.get("llm_analysis", "")
        if llm:
            lines.append("### AI アシスタントの分析")
            lines.append("> *以下は AI による情報提供です。投資助言ではありません。*")
            lines.append("")
            lines.append(llm)
            lines.append("")

        # --- ニュース ---
        news = data.get("news", [])
        if news:
            lines.append("### 最新ニュース")
            for n in news:
                title = n.get("title") or ""
                link = n.get("link") or ""
                publisher = n.get("publisher") or ""
                if link:
                    lines.append(f"- [{title}]({link})　_{publisher}_")
                else:
                    lines.append(f"- {title}　_{publisher}_")
            lines.append("")

        return "\n".join(lines)

    def format_columns(self, data: dict) -> tuple[str, str]:
        """Format report dict as two Markdown strings for a two-column layout.

        Returns:
            (left_md, right_md) where:
              left  — header, 基本情報, バリュエーション, 財務サマリー, 収益性
              right — バリュースコア, アナリストコンセンサス, AI分析, ニュース
        """
        if data.get("error"):
            err = f"## エラー\n\n{data['error']}"
            return err, ""

        currency = data.get("currency")
        left: list[str] = []
        right: list[str] = []

        # --- ヘッダー (左) ---
        ticker = data["ticker"]
        name = data["name"]
        left.append(f"## {name}  `{ticker}`")
        left.append("")
        left.append(f"**セクター:** {data['sector']}　｜　**業種:** {data['industry']}")
        left.append("")

        # --- 基本情報 (左) ---
        left.append("### 基本情報")
        basic_rows = [
            ["時価総額", fmt_market_cap(data.get("market_cap"), currency)],
            ["現在株価", fmt_price(data.get("current_price"), currency)],
            ["52週高値", fmt_price(data.get("week52_high"), currency)],
            ["52週安値", fmt_price(data.get("week52_low"), currency)],
        ]
        left.append(markdown_table(["項目", "値"], basic_rows))
        left.append("")

        # --- バリュエーション (左) ---
        left.append("### バリュエーション")
        val_rows = [
            ["PER (実績)", fmt_float(data.get("per"), 1) + "倍" if data.get("per") else "-"],
            ["PBR", fmt_float(data.get("pbr"), 2) + "倍" if data.get("pbr") else "-"],
            ["EV/EBITDA", fmt_float(data.get("ev_ebitda"), 1) + "倍" if data.get("ev_ebitda") else "-"],
            ["配当利回り", fmt_pct(data.get("dividend_yield"))],
        ]
        left.append(markdown_table(["指標", "値"], val_rows))
        left.append("")

        # --- 財務サマリー (左) ---
        financials = data.get("financials", {})
        revenue = financials.get("revenue", {})
        op_income = financials.get("operating_income", {})
        net_income = financials.get("net_income", {})

        if revenue:
            left.append("### 財務サマリー")
            dates = sorted(revenue.keys(), reverse=True)[:3]

            def _fmt_fin(val: Optional[float]) -> str:
                if val is None:
                    return "-"
                if currency == "JPY":
                    return f"¥{val / 1e8:.0f}億"
                return f"${val / 1e9:.2f}B"

            fin_headers = ["期間"] + dates
            fin_rows = [
                ["売上高"] + [_fmt_fin(revenue.get(d)) for d in dates],
                ["営業利益"] + [_fmt_fin(op_income.get(d)) for d in dates],
                ["純利益"] + [_fmt_fin(net_income.get(d)) for d in dates],
            ]
            left.append(markdown_table(fin_headers, fin_rows))
            left.append("")

        # --- 収益性 (左) ---
        left.append("### 収益性")
        prof_rows = [
            ["ROE", fmt_pct(data.get("roe"))],
            ["ROA", fmt_pct(data.get("roa"))],
            ["営業利益率", fmt_pct(data.get("operating_margin"))],
            ["FCF マージン", fmt_pct(data.get("fcf_margin"))],
        ]
        left.append(markdown_table(["指標", "値"], prof_rows))
        left.append("")

        # --- バリュースコア (右) ---
        score = data.get("value_score", 0.0)
        label = data.get("score_label", "-")
        right.append("### バリュースコア")
        right.append(f"**{score:.1f} / 100** — {label}")
        right.append("")
        right.append(_score_bar(score))
        right.append("")

        # --- アナリストコンセンサス (右) ---
        analyst = data.get("analyst", {})
        if any(v is not None for v in analyst.values()):
            right.append("### アナリストコンセンサス")
            rec_key = analyst.get("recommendation") or ""
            rec_label = _REC_LABELS.get(rec_key, rec_key or "-")
            count = analyst.get("analyst_count")
            count_str = f"{count}名" if count else "-"
            ana_rows = [
                ["目標株価 (高値)", fmt_price(analyst.get("target_high"), currency)],
                ["目標株価 (平均)", fmt_price(analyst.get("target_mean"), currency)],
                ["目標株価 (安値)", fmt_price(analyst.get("target_low"), currency)],
                ["レーティング", rec_label],
                ["アナリスト数", count_str],
            ]
            right.append(markdown_table(["項目", "値"], ana_rows))
            right.append("")

        # --- AI 分析 (右) ---
        llm = data.get("llm_analysis", "")
        if llm:
            right.append("### AI アシスタントの分析")
            right.append("> *以下は AI による情報提供です。投資助言ではありません。*")
            right.append("")
            right.append(llm)
            right.append("")

        # --- ニュース (右) ---
        news = data.get("news", [])
        if news:
            right.append("### 最新ニュース")
            for n in news:
                title = n.get("title") or ""
                link = n.get("link") or ""
                publisher = n.get("publisher") or ""
                if link:
                    right.append(f"- [{title}]({link})　_{publisher}_")
                else:
                    right.append(f"- {title}　_{publisher}_")
            right.append("")

        return "\n".join(left), "\n".join(right)


def _score_bar(score: float, width: int = 20) -> str:
    """Return a simple text progress bar for the score."""
    filled = int(round(score / 100 * width))
    bar = "█" * filled + "░" * (width - filled)
    return f"`{bar}` {score:.0f}%"
