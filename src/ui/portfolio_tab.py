"""Portfolio management tab UI. (Phase 3)"""
import gradio as gr


def build_portfolio_tab(yahoo_client) -> None:
    """Build the portfolio tab. Fully implemented in Phase 3."""
    gr.Markdown("## 💼 ポートフォリオ管理")
    gr.Markdown(
        "売買記録・評価額・ヘルスチェック・推定利回りを管理します。\n\n"
        "> *Phase 3 で実装予定です。*"
    )
    with gr.Row():
        gr.Button("売買記録", variant="secondary")
        gr.Button("スナップショット", variant="secondary")
        gr.Button("構造分析", variant="secondary")
        gr.Button("ヘルスチェック", variant="secondary")
        gr.Button("推定利回り", variant="secondary")
    gr.Markdown("*機能は Phase 3 で実装されます。*")
