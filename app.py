"""Stock Review — Gradio web application entry point."""
import logging
import threading
from pathlib import Path

import gradio as gr
import yaml

from src.data.cache_manager import CacheManager
from src.data.llm_client import LLMClient
from src.data.yahoo_client import YahooClient
from src.ui.chat_tab import build_chat_tab
from src.ui.model_tab import build_model_tab
from src.ui.portfolio_tab import build_portfolio_tab
from src.ui.report_tab import build_report_tab
from src.ui.screening_tab import build_screening_tab
from src.ui.stress_test_tab import build_stress_test_tab

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent
_APP_CSS = """
    /* Report tab: flex-wrap card grid */
    .rpt-cards { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
    .rpt-card  { flex: 1 1 180px; min-width: 180px; }
    .rpt-card.rpt-wide { flex: 2 1 300px; min-width: 280px; }
    .rpt-h3 { margin: 0 0 6px 0; font-size: 0.95em; font-weight: 700;
              border-bottom: 1px solid #444; padding-bottom: 3px; }
    .rpt-tbl { border-collapse: collapse; width: 100%; font-size: 0.85em; }
    .rpt-tbl th, .rpt-tbl td { border: 1px solid #3d3d3d; padding: 3px 8px; white-space: nowrap; }
    .rpt-tbl thead th { background: #252525; color: #aaa; font-weight: 600; }
"""


def _build_theme() -> gr.themes.Base:
    """Build a dark mode theme with orange primary accents."""
    return gr.themes.Base(
        primary_hue="orange",
        secondary_hue="orange",
        neutral_hue="zinc",
    ).set(
        # ── Body ──────────────────────────────────────────────
        body_background_fill="#141414",
        body_text_color="#e0e0e0",
        body_text_color_subdued="#999999",
        body_text_size="*text_md",
        # ── Block / Card ──────────────────────────────────────
        block_background_fill="#1e1e1e",
        block_border_color="#333333",
        block_border_width="1px",
        block_label_background_fill="#1e1e1e",
        block_label_text_color="#aaaaaa",
        block_label_text_size="*text_sm",
        block_title_text_color="#e0e0e0",
        block_title_text_weight="600",
        block_shadow="none",
        # ── Input fields ──────────────────────────────────────
        input_background_fill="#2a2a2a",
        input_border_color="#3d3d3d",
        input_border_width="1px",
        input_text_size="*text_md",
        input_placeholder_color="#666666",
        # ── Primary button (orange) ───────────────────────────
        button_primary_background_fill="#f97316",
        button_primary_background_fill_hover="#fb923c",
        button_primary_text_color="#ffffff",
        button_primary_border_color="transparent",
        button_primary_shadow="none",
        # ── Secondary button ──────────────────────────────────
        button_secondary_background_fill="#2d2d2d",
        button_secondary_background_fill_hover="#3a3a3a",
        button_secondary_text_color="#e0e0e0",
        button_secondary_border_color="#444444",
        button_secondary_shadow="none",
        # ── Table ─────────────────────────────────────────────
        table_even_background_fill="#1e1e1e",
        table_odd_background_fill="#252525",
        table_border_color="#333333",
        # ── Code / Chatbot ────────────────────────────────────
        code_background_fill="#2a2a2a",
        # ── Tab ───────────────────────────────────────────────
        border_color_primary="#3d3d3d",
    )


def load_config() -> tuple[dict, dict, dict]:
    """Load YAML config files.

    Returns:
        (presets, exchanges, scenarios)
    """
    with open(BASE_DIR / "config" / "presets.yaml", encoding="utf-8") as f:
        presets = yaml.safe_load(f)
    with open(BASE_DIR / "config" / "exchanges.yaml", encoding="utf-8") as f:
        exchanges = yaml.safe_load(f)
    with open(BASE_DIR / "config" / "scenarios.yaml", encoding="utf-8") as f:
        scenarios = yaml.safe_load(f)
    return presets, exchanges, scenarios


def build_app() -> gr.Blocks:
    """Construct and return the Gradio Blocks app."""
    presets, exchanges, scenarios = load_config()

    cache = CacheManager(cache_dir=str(BASE_DIR / "data" / "cache"))
    yahoo = YahooClient(cache_manager=cache)
    llm = LLMClient(
        model_id="Qwen/Qwen3-8B",
        cache_dir=str(BASE_DIR / "models"),
        load_on_init=False,
        persist_file=str(BASE_DIR / "data" / "last_model.json"),
    )

    # Auto-load the last used model in the background
    last_model_id = llm.get_last_persisted_model()
    if last_model_id:
        logger.info("Auto-loading last used model: %s", last_model_id)
        threading.Thread(
            target=llm.load_model, args=(last_model_id,), daemon=True
        ).start()
    else:
        logger.info("No persisted model found — load a model from the モデル管理 tab.")

    with gr.Blocks(title="Stock Review") as app:
        gr.Markdown("# Stock Review")
        report_ticker_state = gr.State("")

        with gr.Tabs(selected="screening") as main_tabs:
            with gr.Tab("スクリーニング", id="screening"):
                build_screening_tab(
                    yahoo,
                    presets,
                    exchanges,
                    report_ticker_state=report_ticker_state,
                    main_tabs=main_tabs,
                )

            with gr.Tab("銘柄レポート", id="report"):
                build_report_tab(yahoo, llm, report_ticker_state=report_ticker_state)

            with gr.Tab("ポートフォリオ", id="portfolio"):
                build_portfolio_tab(yahoo)

            with gr.Tab("ストレステスト", id="stress"):
                build_stress_test_tab(yahoo, scenarios)

            with gr.Tab("AI アシスタント", id="chat"):
                build_chat_tab(yahoo, llm)

            with gr.Tab("モデル管理", id="models"):
                build_model_tab(llm)

    return app


def main() -> None:
    app = build_app()
    app.launch(
        server_name="0.0.0.0",
        share=False,
        show_error=True,
        inbrowser=True,
        css=_APP_CSS,
        theme=_build_theme(),
    )


if __name__ == "__main__":
    main()
