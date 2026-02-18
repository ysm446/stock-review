"""AI assistant chat tab UI."""
import json
import logging
import re

import gradio as gr

from src.core.portfolio_manager import PortfolioManager
from src.ui.components import llm_status_badge

logger = logging.getLogger(__name__)

_PORTFOLIO_CSV = "data/portfolio.csv"
_MAX_HISTORY_TURNS = 20  # Maximum number of turns kept in LLM context

# Ticker pattern: e.g. 7203.T, AAPL, 9984.T, BRK.B
_TICKER_RE = re.compile(r"\b([A-Z0-9]{1,6}(?:\.[A-Z]{1,2})?)\b")

# Keywords that suggest the user is asking about their portfolio
_PORTFOLIO_KEYWORDS = [
    "ポートフォリオ", "portfolio", "保有", "持ち株", "保持",
    "holdings", "わたし", "私", "my", "リバランス",
]

_SYSTEM_PROMPT_TEMPLATE = """\
あなたは株式投資のアシスタントです。
提供されたデータや会話履歴を参照しながら、投資家の質問に日本語で回答してください。

ルール:
- 提供されたデータのみに基づいて分析すること
- 投資助言ではなく、情報提供であることを明示すること
- データが不足している場合はその旨を伝えること
- 計算が必要な場合は提供されたデータの数値を使うこと
{context_section}"""


def _extract_tickers(text: str) -> list[str]:
    """Extract potential ticker symbols from user text.

    Returns deduplicated list preserving order of first appearance.
    """
    found = _TICKER_RE.findall(text.upper())
    seen: set[str] = set()
    result = []
    for t in found:
        if t not in seen:
            seen.add(t)
            result.append(t)
    return result


def _has_portfolio_intent(text: str) -> bool:
    """Return True if the message seems to be asking about the user's portfolio."""
    lower = text.lower()
    return any(kw.lower() in lower for kw in _PORTFOLIO_KEYWORDS)


def _build_context(message: str, yahoo_client, manager: PortfolioManager) -> str:
    """Fetch relevant data based on the user's message and return a context string.

    Args:
        message: Raw user message.
        yahoo_client: YahooClient instance.
        manager: PortfolioManager instance.

    Returns:
        Context string to append to the system prompt, or empty string.
    """
    sections: list[str] = []

    # Portfolio data
    if _has_portfolio_intent(message):
        try:
            positions = manager.get_positions()
            if positions:
                portfolio_summary = {
                    ticker: {
                        "quantity": pos["quantity"],
                        "avg_price": round(pos["avg_price"], 2),
                        "currency": pos["currency"],
                    }
                    for ticker, pos in positions.items()
                }
                sections.append(
                    "## 保有ポジション\n"
                    + json.dumps(portfolio_summary, ensure_ascii=False, indent=2)
                )
        except Exception as e:
            logger.warning("Portfolio context fetch failed: %s", e)

    # Stock data for mentioned tickers
    tickers = _extract_tickers(message)
    if not tickers:
        # Fallback: search by company name when no ticker symbol found in message
        try:
            tickers = yahoo_client.search_tickers(message, max_results=2)
        except Exception as e:
            logger.warning("Ticker search fallback failed: %s", e)

    for ticker in tickers[:3]:  # Limit to 3 tickers to avoid token explosion
        try:
            info = yahoo_client.get_ticker_info(ticker)
            if not info:
                continue
            stock_summary = {
                "ticker": ticker,
                "name": info.get("longName") or info.get("shortName"),
                "sector": info.get("sector"),
                "currency": info.get("currency"),
                "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
                "market_cap": info.get("marketCap"),
                "per": info.get("trailingPE") or info.get("forwardPE"),
                "pbr": info.get("priceToBook"),
                "dividend_yield_pct": round((info.get("dividendYield") or 0) * 100, 2),
                "roe_pct": round((info.get("returnOnEquity") or 0) * 100, 2),
                "revenue_growth_pct": round((info.get("revenueGrowth") or 0) * 100, 2),
                "operating_margin_pct": round((info.get("operatingMargins") or 0) * 100, 2),
                "week52_high": info.get("fiftyTwoWeekHigh"),
                "week52_low": info.get("fiftyTwoWeekLow"),
                "analyst_recommendation": info.get("recommendationKey"),
                "target_mean_price": info.get("targetMeanPrice"),
                "analyst_count": info.get("numberOfAnalystOpinions"),
            }
            sections.append(
                f"## {ticker} の財務データ\n"
                + json.dumps(stock_summary, ensure_ascii=False, indent=2)
            )
        except Exception as e:
            logger.warning("Stock context fetch for %s failed: %s", ticker, e)

    if not sections:
        return ""

    return "\n\n## 参照データ (自動取得)\n\n"+ "\n\n".join(sections)


def build_chat_tab(yahoo_client, llm_client) -> None:
    """Build the AI assistant chat tab UI."""
    gr.Markdown("## AI アシスタント")

    manager = PortfolioManager(_PORTFOLIO_CSV)

    # LLM status row
    with gr.Row():
        status_md = gr.Markdown(llm_status_badge(llm_client.is_available()))
        reconnect_btn = gr.Button("接続確認", size="sm", scale=0)

    # Chat area
    chatbot = gr.Chatbot(
        label="会話履歴",
        height=480,
    )

    # Input row
    with gr.Row():
        msg_input = gr.Textbox(
            label="質問を入力",
            placeholder="例: トヨタ (7203.T) の投資魅力を教えて",
            scale=5,
            lines=2,
        )
        send_btn = gr.Button("送信", variant="primary", scale=1)

    with gr.Row():
        clear_btn = gr.Button("会話をクリア", scale=1)
        with gr.Column(scale=4):
            gr.Markdown(
                "*使用例: 「7203.T の業績は？」「ポートフォリオのリスクは？」「AAPL と MSFT を比較して」*"
            )

    # Conversation history state (LLM format)
    history_state = gr.State([])

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def check_connection():
        llm_client.reset_availability_cache()
        return llm_status_badge(llm_client.is_available())

    reconnect_btn.click(check_connection, outputs=[status_md])

    def clear_chat():
        return [], []

    clear_btn.click(clear_chat, outputs=[chatbot, history_state])

    def respond(message: str, history: list, llm_history: list):
        message = message.strip()
        if not message:
            return "", history, llm_history

        # Check LLM availability on each turn
        if not llm_client.is_available():
            reply = (
                "**LLM 未接続**\n\n"
                "Ollama が起動していません。`ollama serve` を実行してから「接続確認」ボタンを押してください。\n\n"
                "Ollama なしでも、銘柄レポートタブ・スクリーニングタブなど定量分析機能は引き続きご利用いただけます。"
            )
            history = list(history) + [
                {"role": "user", "content": message},
                {"role": "assistant", "content": reply},
            ]
            return "", history, llm_history

        # Build context from the current message
        context = _build_context(message, yahoo_client, manager)
        system_prompt = _SYSTEM_PROMPT_TEMPLATE.format(
            context_section=context if context else ""
        )

        # Append user message to LLM history
        llm_history = list(llm_history) + [{"role": "user", "content": message}]

        # Trim history to avoid context overflow
        if len(llm_history) > _MAX_HISTORY_TURNS * 2:
            llm_history = llm_history[-(_MAX_HISTORY_TURNS * 2):]

        # Call LLM
        reply = llm_client.chat(llm_history, system=system_prompt)
        if not reply:
            reply = "LLM からの応答が取得できませんでした。時間をおいて再度お試しください。"

        # Append assistant reply to LLM history
        llm_history = llm_history + [{"role": "assistant", "content": reply}]

        # Update chatbot display
        history = list(history) + [
            {"role": "user", "content": message},
            {"role": "assistant", "content": reply},
        ]

        return "", history, llm_history

    send_btn.click(
        respond,
        inputs=[msg_input, chatbot, history_state],
        outputs=[msg_input, chatbot, history_state],
    )
    msg_input.submit(
        respond,
        inputs=[msg_input, chatbot, history_state],
        outputs=[msg_input, chatbot, history_state],
    )
