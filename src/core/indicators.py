"""Value score and utility scoring functions."""
from typing import Optional


def calculate_value_score(info: dict, weights: Optional[dict] = None) -> float:
    """Calculate value score (0–100) from a ticker info dict.

    Scoring logic:
        PER           (default 25pts): lower is better, range 0–30
        PBR           (default 25pts): lower is better, range 0.5–4.0
        Dividend yield (default 20pts): higher is better, 5% = max
        ROE           (default 15pts): higher is better, 20% = max
        Revenue growth (default 15pts): higher is better, range −10%–20%

    Args:
        info: Ticker info dict from YahooClient or yfinance screener result.
        weights: Custom score weights dict. Keys: per, pbr, dividend_yield,
                 roe, revenue_growth. Weights need not sum to 100.

    Returns:
        Float score 0.0–100.0 (rounded to 1 decimal).
    """
    if weights is None:
        weights = {
            "per": 25,
            "pbr": 25,
            "dividend_yield": 20,
            "roe": 15,
            "revenue_growth": 15,
        }

    score = 0.0

    # PER: lower is better. Full score at PER≤5, zero at PER≥30.
    per = info.get("trailingPE") or info.get("forwardPE")
    if per is not None and 0 < per < 200:
        pct = max(0.0, min(1.0, (30.0 - per) / 25.0))
        score += pct * weights.get("per", 25)

    # PBR: lower is better. Full score at PBR≤0.5, zero at PBR≥4.0.
    pbr = info.get("priceToBook")
    if pbr is not None and pbr > 0:
        pct = max(0.0, min(1.0, (4.0 - pbr) / 3.5))
        score += pct * weights.get("pbr", 25)

    # Dividend yield: higher is better. Full score at ≥5%.
    div = info.get("dividendYield")
    if div is not None and div > 0:
        pct = min(1.0, div / 0.05)
        score += pct * weights.get("dividend_yield", 20)

    # ROE: higher is better. Full score at ≥20%.
    roe = info.get("returnOnEquity")
    if roe is not None:
        pct = max(0.0, min(1.0, roe / 0.20))
        score += pct * weights.get("roe", 15)

    # Revenue growth: range −10% → 20% mapped to 0 → 1.
    rev_growth = info.get("revenueGrowth")
    if rev_growth is not None:
        pct = max(0.0, min(1.0, (rev_growth + 0.10) / 0.30))
        score += pct * weights.get("revenue_growth", 15)

    return round(score, 1)


def get_score_label(score: float) -> str:
    """Return a Japanese label for a value score.

    Args:
        score: Float 0–100.

    Returns:
        One of: "優秀", "良好", "普通", "要注意".
    """
    if score >= 70:
        return "優秀"
    if score >= 50:
        return "良好"
    if score >= 30:
        return "普通"
    return "要注意"
