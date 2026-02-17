"""Input validation utilities."""
import re
from typing import Optional


def validate_ticker(ticker: str) -> tuple[bool, str]:
    """Validate a single ticker symbol.

    Args:
        ticker: Ticker string to validate.

    Returns:
        (is_valid, error_message). error_message is empty string on success.
    """
    ticker = ticker.strip().upper()
    if not ticker:
        return False, "ティッカーが空です。"
    # Allow alphanumeric, dots, hyphens (e.g. 7203.T, BRK-B, 005930.KS)
    if not re.match(r"^[A-Z0-9.\-]{1,20}$", ticker):
        return False, f"無効なティッカー形式: '{ticker}'"
    return True, ""


def validate_ticker_list(raw: str) -> tuple[list[str], list[str]]:
    """Parse and validate a comma-separated ticker list.

    Args:
        raw: Comma-separated string of ticker symbols.

    Returns:
        (valid_tickers, errors). Both are lists of strings.
    """
    valid: list[str] = []
    errors: list[str] = []
    for part in raw.split(","):
        ticker = part.strip().upper()
        if not ticker:
            continue
        ok, msg = validate_ticker(ticker)
        if ok:
            valid.append(ticker)
        else:
            errors.append(msg)
    return valid, errors


def validate_quantity(value: str) -> tuple[Optional[float], str]:
    """Validate a quantity input (must be positive number).

    Returns:
        (quantity, error_message). quantity is None on error.
    """
    try:
        q = float(value)
        if q <= 0:
            return None, "数量は正の数を入力してください。"
        return q, ""
    except (ValueError, TypeError):
        return None, f"数値を入力してください: '{value}'"


def validate_price(value: str) -> tuple[Optional[float], str]:
    """Validate a price input (must be positive number).

    Returns:
        (price, error_message). price is None on error.
    """
    try:
        p = float(value)
        if p <= 0:
            return None, "価格は正の数を入力してください。"
        return p, ""
    except (ValueError, TypeError):
        return None, f"数値を入力してください: '{value}'"
