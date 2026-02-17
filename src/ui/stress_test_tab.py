"""Stress test tab UI."""
import logging

import gradio as gr

from src.core.portfolio_manager import PortfolioManager
from src.core.recommender import generate_recommendations
from src.core.scenario_analysis import run_scenario
from src.utils.formatter import fmt_pct, markdown_table

logger = logging.getLogger(__name__)

_PORTFOLIO_CSV = "data/portfolio.csv"


def build_stress_test_tab(yahoo_client, scenarios: dict) -> None:
    """Build the stress test tab UI."""
    gr.Markdown("## ストレステスト")
    gr.Markdown(
        "銘柄リストとシナリオを選択して、ショック感応度・VaR・推奨アクションを分析します。"
    )

    # scenario_key → name mapping (for display)
    scenario_choices = [(v.get("name", k), k) for k, v in scenarios.items()]
    default_scenario = scenario_choices[0][1] if scenario_choices else None

    manager = PortfolioManager(_PORTFOLIO_CSV)

    with gr.Row():
        ticker_input = gr.Textbox(
            label="ティッカー (カンマ区切り)",
            placeholder="例: 7203.T, AAPL, 1306.T",
            scale=3,
        )
        load_portfolio_btn = gr.Button("ポートフォリオから読込", scale=1)

    with gr.Row():
        scenario_dd = gr.Dropdown(
            choices=scenario_choices,
            value=default_scenario,
            label="シナリオ",
            scale=2,
        )
        run_btn = gr.Button("テスト実行", variant="primary", scale=1)

    result_out = gr.Markdown("*ティッカーとシナリオを選択して実行してください。*")

    # Load tickers from portfolio.csv
    def load_from_portfolio():
        positions = manager.get_positions()
        if not positions:
            return "ポートフォリオに銘柄がありません。"
        return ", ".join(positions.keys())

    load_portfolio_btn.click(load_from_portfolio, outputs=[ticker_input])

    def run_stress_test(tickers_raw: str, scenario_key: str):
        yield "分析中..."
        tickers = [t.strip() for t in tickers_raw.split(",") if t.strip()]
        if not tickers:
            yield "ティッカーを入力してください。"
            return
        if not scenario_key:
            yield "シナリオを選択してください。"
            return

        try:
            result = run_scenario(tickers, scenario_key, scenarios, yahoo_client)
        except Exception as e:
            logger.exception("run_scenario failed")
            yield f"エラー: {e}"
            return

        if result.get("error"):
            yield f"{result['error']}"
            return

        yield _format_result(result)

    run_btn.click(run_stress_test, inputs=[ticker_input, scenario_dd], outputs=[result_out])


def _format_result(result: dict) -> str:
    """Format scenario analysis result as Markdown."""
    lines: list[str] = []

    # Header
    lines.append(f"## {result['scenario_name']}")
    if result.get("scenario_description"):
        lines.append(f"*{result['scenario_description']}*")
    lines.append("")

    # Summary metrics
    hhi = result["hhi"]
    p_impact = result["portfolio_impact"]
    var_95 = result["var_95"]
    var_99 = result["var_99"]

    summary_rows = [
        ["HHI 集中度", f"{hhi:.4f} — {result['hhi_label']}"],
        ["ポートフォリオ推定インパクト", fmt_pct(p_impact)],
        ["VaR (95%)", fmt_pct(var_95)],
        ["VaR (99%)", fmt_pct(var_99)],
    ]
    lines.append("### サマリー")
    lines.append(markdown_table(["指標", "値"], summary_rows))
    lines.append("")

    if result.get("correlation_summary"):
        lines.append(f"**相関:** {result['correlation_summary']}")
        lines.append("")

    # Per-ticker impacts
    lines.append("### 銘柄別インパクト")
    impact_rows = [
        [
            f"{item['name']} ({item['ticker']})",
            "ETF"if item["is_etf"] else item["sector"],
            item["shock_applied"],
            fmt_pct(item["impact_pct"]),
        ]
        for item in result["ticker_impacts"]
    ]
    lines.append(markdown_table(["銘柄", "セクター/種別", "適用ショック", "推定インパクト"], impact_rows))
    lines.append("")

    # Recommendations
    recs = generate_recommendations(result)
    lines.append("### 推奨アクション")
    for rec in recs:
        lines.append(f"- {rec}")
    lines.append("")

    lines.append(
        "> *本分析は参考情報であり、投資助言ではありません。実際の投資判断はご自身でご判断ください。*"
    )

    return "\n".join(lines)
