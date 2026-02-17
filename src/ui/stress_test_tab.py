"""Stress test tab UI. (Phase 4)"""
import gradio as gr


def build_stress_test_tab(yahoo_client, scenarios: dict) -> None:
    """Build the stress test tab. Fully implemented in Phase 4."""
    gr.Markdown("## ⚡ ストレステスト")
    gr.Markdown(
        "ポートフォリオに対してシナリオ別のショック感応度・VaR を分析します。\n\n"
        "> *Phase 4 で実装予定です。*"
    )
    scenario_names = [v.get("name", k) for k, v in scenarios.items()]
    with gr.Row():
        gr.Textbox(
            label="ティッカー (カンマ区切り)",
            placeholder="例: 7203.T, AAPL, 1306.T",
            scale=3,
        )
        gr.Dropdown(
            choices=scenario_names,
            value=scenario_names[0] if scenario_names else None,
            label="シナリオ",
            scale=1,
        )
    gr.Button("⚡ テスト実行", variant="primary")
    gr.Markdown("*機能は Phase 4 で実装されます。*")
