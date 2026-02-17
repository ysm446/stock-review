"""Shared pytest fixtures."""
import pytest


@pytest.fixture
def sample_stock_info() -> dict:
    """Minimal ticker info dict for testing."""
    return {
        "symbol": "7203.T",
        "shortName": "Toyota Motor Corp",
        "quoteType": "EQUITY",
        "sector": "Consumer Cyclical",
        "currency": "JPY",
        "marketCap": 30_000_000_000_000,
        "trailingPE": 8.5,
        "priceToBook": 1.1,
        "dividendYield": 0.028,
        "returnOnEquity": 0.12,
        "revenueGrowth": 0.05,
    }


@pytest.fixture
def sample_etf_info() -> dict:
    """Minimal ETF info dict for testing."""
    return {
        "symbol": "1306.T",
        "shortName": "TOPIX ETF",
        "quoteType": "ETF",
        "currency": "JPY",
        "marketCap": 10_000_000_000_000,
    }


@pytest.fixture
def default_weights() -> dict:
    """Default value score weights."""
    return {
        "per": 25,
        "pbr": 25,
        "dividend_yield": 20,
        "roe": 15,
        "revenue_growth": 15,
    }
