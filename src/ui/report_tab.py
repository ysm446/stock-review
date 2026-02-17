"""Individual stock report tab UI. (Phase 2)"""
import gradio as gr


def build_report_tab(yahoo_client, llm_client) -> None:
    """Build the stock report tab. Fully implemented in Phase 2."""
    gr.Markdown("## 📋 銘柄レポート")
    gr.Markdown(
        "ティッカーを入力して個別銘柄の財務分析レポートを生成します。\n\n"
        "> *Phase 2 で実装予定です。*"
    )
    with gr.Row():
        ticker_input = gr.Textbox(
            label="ティッカー",
            placeholder="例: 7203.T または AAPL",
            scale=3,
        )
        run_btn = gr.Button("📋 レポート生成", variant="primary", scale=1)
    report_output = gr.Markdown("*ティッカーを入力して実行してください。*")

    def generate_report(ticker: str) -> str:
        if not ticker.strip():
            return "⚠️ ティッカーを入力してください。"
        return f"*{ticker.strip()} のレポート生成は Phase 2 で実装されます。*"

    run_btn.click(generate_report, inputs=[ticker_input], outputs=[report_output])
    ticker_input.submit(generate_report, inputs=[ticker_input], outputs=[report_output])
