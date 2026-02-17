"""Shared Gradio UI components."""
import gradio as gr


def llm_status_badge(is_available: bool) -> str:
    """Return a Markdown badge string indicating LLM connection status."""
    if is_available:
        return "**LLM 接続中**"
    return "**LLM 未接続** — Ollama が起動していません。`ollama serve` を実行してください。"


def error_markdown(message: str) -> str:
    """Wrap an error message in Markdown."""
    return f"**エラー:** {message}"


def info_markdown(message: str) -> str:
    """Wrap an info message in Markdown."""
    return f"{message}"


def build_llm_status_row(llm_client) -> gr.Markdown:
    """Build a Markdown component showing current LLM status."""
    status = llm_status_badge(llm_client.is_available())
    return gr.Markdown(status)
