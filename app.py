"""Stock Advisor — Gradio web application entry point."""
import logging
from pathlib import Path

import gradio as gr
import yaml

from src.data.cache_manager import CacheManager
from src.data.llm_client import LLMClient
from src.data.yahoo_client import YahooClient
from src.ui.chat_tab import build_chat_tab
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
    llm = LLMClient()

    llm_status = "🟢 LLM 接続中" if llm.is_available() else "🔴 LLM 未接続"
    logger.info("LLM status: %s (model=%s)", llm_status, llm.model)

    with gr.Blocks(title="Stock Advisor") as app:
        gr.Markdown("# 📊 Stock Advisor")
        gr.Markdown(
            f"{llm_status} | "
            "**投資は自己責任です。本システムの出力は投資助言ではありません。**"
        )

        with gr.Tabs():
            with gr.Tab("🔍 スクリーニング"):
                build_screening_tab(yahoo, presets, exchanges)

            with gr.Tab("📋 銘柄レポート"):
                build_report_tab(yahoo, llm)

            with gr.Tab("💼 ポートフォリオ"):
                build_portfolio_tab(yahoo)

            with gr.Tab("⚡ ストレステスト"):
                build_stress_test_tab(yahoo, scenarios)

            with gr.Tab("💬 AI アシスタント"):
                build_chat_tab(yahoo, llm)

    return app


def main() -> None:
    app = build_app()
    app.launch(
        server_name="0.0.0.0",
        share=False,
        show_error=True,
        inbrowser=True,
        theme=gr.themes.Soft(),
    )


if __name__ == "__main__":
    main()
