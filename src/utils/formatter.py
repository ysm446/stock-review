"""Formatting utilities for Markdown tables and display strings."""
from typing import Optional


def fmt_pct(value: Optional[float], decimals: int = 1) -> str:
    """Format a decimal ratio as a percentage string (e.g. 0.035 → '3.5%')."""
    if value is None:
        return "-"
    return f"{value * 100:.{decimals}f}%"


def fmt_float(value: Optional[float], decimals: int = 1) -> str:
    """Format a float with fixed decimal places."""
    if value is None:
        return "-"
    return f"{value:.{decimals}f}"


def fmt_market_cap(cap: Optional[float], currency: Optional[str] = None) -> str:
    """Format a market cap value with currency-aware units."""
    if cap is None:
        return "-"
    if currency == "JPY":
        return f"¥{cap / 1e8:.0f}億"
    if cap >= 1e12:
        return f"${cap / 1e12:.1f}T"
    if cap >= 1e9:
        return f"${cap / 1e9:.1f}B"
    return f"${cap / 1e6:.0f}M"


def fmt_price(price: Optional[float], currency: Optional[str] = None) -> str:
    """Format a price value."""
    if price is None:
        return "-"
    symbol = "¥" if currency == "JPY" else "$"
    return f"{symbol}{price:,.2f}"


def markdown_table(headers: list[str], rows: list[list]) -> str:
    """Build a simple Markdown table.

    Args:
        headers: Column header strings.
        rows: List of row value lists (converted to str automatically).

    Returns:
        Markdown-formatted table string.
    """
    sep = " | ".join(["---"] * len(headers))
    header_row = " | ".join(headers)
    body_rows = "\n".join(
        " | ".join(str(cell) for cell in row) for row in rows
    )
    return f"| {header_row} |\n| {sep} |\n" + "\n".join(
        f"| {' | '.join(str(c) for c in row)} |" for row in rows
    )
