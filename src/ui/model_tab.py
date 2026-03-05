"""Model management tab for loading/unloading local GGUF models via llama-cpp-python."""
import os
import threading
from pathlib import Path
from typing import TYPE_CHECKING

import gradio as gr

if TYPE_CHECKING:
    from src.data.llm_client import LLMClient


def _get_gguf_files(models_dir: str) -> dict[str, str]:
    """Return {stem: path} for all .gguf files in models_dir."""
    base = Path(models_dir)
    if not base.is_dir():
        return {}
    return {p.stem: str(p) for p in sorted(base.glob("*.gguf"))}


def _get_status_text(llm_client: "LLMClient") -> str:
    status = llm_client.get_status()
    if status["loading"]:
        return f"読み込み中: {status['current_model_id'] or '...'}"
    if status["available"]:
        vram_alloc = status["vram_allocated_gb"]
        vram_total = status["vram_total_gb"]
        lines = [f"Loaded: {status['current_model_id']}"]
        if vram_total > 0:
            lines.append(f"VRAM: {vram_alloc:.1f} GB / {vram_total:.1f} GB")
        return "\n".join(lines)
    if status["load_error"]:
        return f"Error: {status['load_error']}"
    return "モデル未読み込み。「Load」を押してください。"


def _get_vram_bar(llm_client: "LLMClient") -> str:
    status = llm_client.get_status()
    total = status["vram_total_gb"]
    if total <= 0:
        return "GPU: Not detected (CPU mode)"
    alloc = status["vram_allocated_gb"]
    pct = min(alloc / total, 1.0)
    filled = int(round(pct * 20))
    bar = "#" * filled + "-" * (20 - filled)
    return f"VRAM `{bar}` {alloc:.1f} / {total:.1f} GB ({pct * 100:.0f}%)"


def build_model_tab(llm_client: "LLMClient") -> None:
    """Build the model management tab UI."""
    models_dir = getattr(llm_client, "_models_dir", "models")

    gr.Markdown("## モデル管理")
    gr.Markdown(
        "ローカル GGUF モデルを読み込みます。  \n"
        f"モデルファイルは `{models_dir}/` に配置してください (`.gguf` 形式)。"
    )

    gguf_files = _get_gguf_files(models_dir)
    model_choices = list(gguf_files.keys())

    # Pre-select: last persisted > first available
    last_path = llm_client.get_last_persisted_model()
    initial_choice = None
    if last_path:
        last_stem = Path(last_path).stem
        if last_stem in gguf_files:
            initial_choice = last_stem
    if initial_choice is None and model_choices:
        initial_choice = model_choices[0]

    with gr.Row():
        with gr.Column(scale=1):
            gr.Markdown("### Status")
            status_box = gr.Textbox(
                label="Model Status",
                value=_get_status_text(llm_client),
                interactive=False,
                lines=3,
            )
            vram_md = gr.Markdown(_get_vram_bar(llm_client))

        with gr.Column(scale=2):
            gr.Markdown("### モデル選択")
            model_dd = gr.Dropdown(
                choices=model_choices,
                value=initial_choice,
                label="GGUF モデル",
                scale=3,
            )
            with gr.Row():
                load_btn = gr.Button("Load", variant="primary", scale=1)
                unload_btn = gr.Button("Unload", scale=1)
                refresh_files_btn = gr.Button("ファイル一覧を更新", scale=1)

            log_box = gr.Textbox(
                label="Log",
                value="",
                interactive=False,
                lines=6,
                max_lines=6,
            )

    timer = gr.Timer(value=2.0, active=False)

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def on_load(model_name: str):
        gguf = _get_gguf_files(models_dir)
        model_path = gguf.get(model_name)
        if not model_path:
            return (
                f"モデルが見つかりません: {model_name}",
                _get_status_text(llm_client),
                _get_vram_bar(llm_client),
                gr.update(active=False),
            )
        if llm_client.is_loading():
            return (
                "読み込み中です。しばらくお待ちください。",
                _get_status_text(llm_client),
                _get_vram_bar(llm_client),
                gr.update(active=True),
            )

        def progress_callback(msg: str) -> None:
            llm_client._load_log = msg

        thread = threading.Thread(
            target=llm_client.load_model,
            args=(model_path,),
            kwargs={"on_progress": progress_callback},
            daemon=True,
        )
        thread.start()

        initial_log = f"Started loading: {model_path}"
        llm_client._load_log = initial_log
        return (
            initial_log,
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            gr.update(active=True),
        )

    load_btn.click(
        on_load,
        inputs=[model_dd],
        outputs=[log_box, status_box, vram_md, timer],
    )

    def on_unload():
        llm_client.unload_model()
        msg = "Model unloaded."
        llm_client._load_log = msg
        return (
            msg,
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            gr.update(active=False),
        )

    unload_btn.click(
        on_unload,
        outputs=[log_box, status_box, vram_md, timer],
    )

    def on_refresh_files():
        gguf = _get_gguf_files(models_dir)
        choices = list(gguf.keys())
        return gr.update(choices=choices, value=choices[0] if choices else None)

    refresh_files_btn.click(on_refresh_files, outputs=[model_dd])

    def poll_status():
        loading = llm_client.is_loading()
        return (
            llm_client._load_log or "",
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            gr.update(active=loading),
        )

    timer.tick(poll_status, outputs=[log_box, status_box, vram_md, timer])
