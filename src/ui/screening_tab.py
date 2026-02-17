"""Screening tab UI."""
import logging

import gradio as gr
import pandas as pd

from src.core.screener import QueryScreener, ValueScreener, results_to_dataframe

logger = logging.getLogger(__name__)


def build_screening_tab(yahoo_client, presets: dict, exchanges: dict) -> None:
    """Build the screening tab UI within an active gr.Blocks context.

    Args:
        yahoo_client: YahooClient instance.
        presets: Presets dict from config/presets.yaml.
        exchanges: Exchanges dict from config/exchanges.yaml.
    """
    query_screener = QueryScreener(yahoo_client, presets)
    value_screener = ValueScreener(yahoo_client, presets)

    # Choices for dropdowns
    region_choices = [(v["name"], k) for k, v in exchanges.items()]
    preset_choices = [(v.get("description", k), k) for k, v in presets.items()]

    with gr.Row():
        # ── Left panel: controls ──────────────────────────────────────────
        with gr.Column(scale=1, min_width=260):
            gr.Markdown("### 検索条件")

            mode_radio = gr.Radio(
                choices=["銘柄スクリーニング", "個別リスト指定"],
                value="銘柄スクリーニング",
                label="モード",
            )

            region_dd = gr.Dropdown(
                choices=region_choices,
                value="japan",
                label="地域",
                visible=True,
            )

            preset_radio = gr.Radio(
                choices=preset_choices,
                value="value",
                label="プリセット",
            )

            ticker_box = gr.Textbox(
                label="ティッカーリスト (カンマ区切り)",
                placeholder="例: 7203.T, 6758.T, 9984.T",
                visible=False,
            )

            preset_for_list = gr.Dropdown(
                choices=preset_choices,
                value="value",
                label="適用プリセット (スコア計算用)",
                visible=False,
            )

            limit_slider = gr.Slider(
                minimum=5,
                maximum=50,
                value=20,
                step=5,
                label="表示件数",
                visible=True,
            )

            run_btn = gr.Button("スクリーニング実行", variant="primary", size="lg")
            status_md = gr.Markdown("")

        # ── Right panel: results ──────────────────────────────────────────
        with gr.Column(scale=3):
            gr.Markdown("### スクリーニング結果")
            result_df = gr.DataFrame(
                label="",
                interactive=False,
                wrap=False,
            )
            gr.Markdown(
                "*スコアは 0–100 点満点。判定: 優秀(70+)・良好(50+)・普通(30+)・要注意*",
                elem_classes=["caption"],
            )

    # ── Event handlers ────────────────────────────────────────────────────

    def on_mode_change(mode: str):
        is_list = mode == "個別リスト指定"
        return (
            gr.update(visible=not is_list),   # region_dd
            gr.update(visible=not is_list),   # preset_radio
            gr.update(visible=not is_list),   # limit_slider
            gr.update(visible=is_list),       # ticker_box
            gr.update(visible=is_list),       # preset_for_list
        )

    mode_radio.change(
        on_mode_change,
        inputs=[mode_radio],
        outputs=[region_dd, preset_radio, limit_slider, ticker_box, preset_for_list],
    )

    def run_screening(mode: str, region: str, preset: str, tickers_raw: str, preset_list: str, limit: float):
        try:
            if mode == "個別リスト指定":
                tickers = [t.strip() for t in tickers_raw.split(",") if t.strip()]
                if not tickers:
                    return pd.DataFrame(), "ティッカーを入力してください。"
                results = value_screener.screen(tickers, preset=preset_list)
                df = results_to_dataframe(results)
                return df, f"{len(results)} 件の銘柄を分析しました。"
            else:
                results = query_screener.screen(region, preset, limit=int(limit))
                df = results_to_dataframe(results)
                if df.empty:
                    return df, "条件に一致する銘柄が見つかりませんでした。フィルターを緩めてみてください。"
                return df, f"{len(results)} 件の銘柄が見つかりました。"
        except Exception as e:
            logger.exception("Screening failed")
            return pd.DataFrame(), f"エラー: {e}"

    run_btn.click(
        run_screening,
        inputs=[mode_radio, region_dd, preset_radio, ticker_box, preset_for_list, limit_slider],
        outputs=[result_df, status_md],
    )
