"""Model management tab for loading/unloading Hugging Face Transformers models."""
import os
import threading
from typing import TYPE_CHECKING

import gradio as gr

if TYPE_CHECKING:
    from src.data.llm_client import LLMClient


_OFFICIAL_WEIGHT_BYTES = {
    "Qwen/Qwen3-4B": 8044936192,
    "Qwen/Qwen3-8B": 16381470720,
    "Qwen/Qwen3-14B": 29536614400,
    "Qwen/Qwen3-32B": 65524246528,
}


def _model_cache_size_bytes(cache_dir: str, model_id: str) -> int:
    """Return exact cached size in bytes for one Hugging Face model repo."""
    repo_dir = os.path.join(cache_dir, f"models--{model_id.replace('/', '--')}")
    if not os.path.isdir(repo_dir):
        return 0

    total = 0
    for root, _, files in os.walk(repo_dir):
        for name in files:
            path = os.path.join(root, name)
            try:
                total += os.path.getsize(path)
            except OSError:
                continue
    return total


def _get_model_size_table(llm_client: "LLMClient", models: dict[str, str]) -> str:
    """Return markdown table for local model cache sizes."""
    cache_dir = getattr(llm_client, "_cache_dir", "models")
    lines = [
        "| Model | Local Size (Measured) | Official Weights Size |",
        "|-------|------------------------|-----------------------|",
    ]

    for model_name, model_id in models.items():
        local_bytes = _model_cache_size_bytes(cache_dir, model_id)
        if local_bytes <= 0:
            local_text = "Not downloaded"
        else:
            local_gib = local_bytes / (1024 ** 3)
            local_text = f"{local_gib:.2f} GiB ({local_bytes:,} bytes)"

        official_bytes = _OFFICIAL_WEIGHT_BYTES.get(model_id)
        if official_bytes is None:
            official_text = "-"
        else:
            official_gib = official_bytes / (1024 ** 3)
            official_text = f"{official_gib:.2f} GiB ({official_bytes:,} bytes)"

        lines.append(f"| {model_name} | {local_text} | {official_text} |")

    return "\n".join(lines)


def _get_status_text(llm_client: "LLMClient") -> str:
    """Return a human-readable status string for the model."""
    status = llm_client.get_status()
    if status["loading"]:
        model_id = status["current_model_id"] or "..."
        return f"Loading: {model_id}"
    if status["available"]:
        vram_alloc = status["vram_allocated_gb"]
        vram_total = status["vram_total_gb"]
        lines = [f"Loaded: {status['current_model_id']}"]
        if vram_total > 0:
            lines.append(f"VRAM: {vram_alloc:.1f} GB / {vram_total:.1f} GB")
        return "\n".join(lines)
    if status["load_error"]:
        return f"Error: {status['load_error']}"
    return "No model loaded. Click 'Load'."


def _get_vram_bar(llm_client: "LLMClient") -> str:
    """Return a Markdown VRAM usage bar."""
    status = llm_client.get_status()
    total = status["vram_total_gb"]
    if total <= 0:
        return "GPU: Not detected (running on CPU mode)"

    alloc = status["vram_allocated_gb"]
    pct = min(alloc / total, 1.0)
    filled = int(round(pct * 20))
    bar = "#" * filled + "-" * (20 - filled)
    return f"VRAM `{bar}` {alloc:.1f} / {total:.1f} GB ({pct * 100:.0f}%)"


def build_model_tab(llm_client: "LLMClient") -> None:
    """Build the model management tab UI.

    Args:
        llm_client: The shared LLMClient instance (mutable, owned by app.py).
    """
    from src.data.llm_client import LLMClient  # noqa: PLC0415

    gr.Markdown("## Model Management")
    gr.Markdown(
        "Load Hugging Face Transformers models locally.  \n"
        "Model files are cached under `models/`.  \n"
        "The table shows measured local size and official weights size."
    )

    last_model_id = llm_client.get_last_persisted_model()
    initial_model_name = "Qwen3-8B"
    if last_model_id:
        for name, mid in LLMClient.SUPPORTED_MODELS.items():
            if mid == last_model_id:
                initial_model_name = name
                break

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
            gr.Markdown("### Select Model")
            model_size_md = gr.Markdown(
                _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS)
            )
            with gr.Row():
                model_dd = gr.Dropdown(
                    choices=list(LLMClient.SUPPORTED_MODELS.keys()),
                    value=initial_model_name,
                    label="Model",
                    scale=3,
                )
                load_btn = gr.Button("Load", variant="primary", scale=1)
                unload_btn = gr.Button("Unload", scale=1)

            log_box = gr.Textbox(
                label="Log",
                value="",
                interactive=False,
                lines=6,
                max_lines=6,
            )

    # Disabled by default to prevent periodic blinking while idle.
    timer = gr.Timer(value=2.0, active=False)

    def on_load(model_name: str):
        model_id = LLMClient.SUPPORTED_MODELS.get(model_name)
        if not model_id:
            return (
                f"Unknown model name: {model_name}",
                _get_status_text(llm_client),
                _get_vram_bar(llm_client),
                _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS),
                gr.update(active=False),
            )
        if llm_client.is_loading():
            return (
                "Model loading is already in progress. Please wait.",
                _get_status_text(llm_client),
                _get_vram_bar(llm_client),
                _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS),
                gr.update(active=True),
            )

        def progress_callback(msg: str) -> None:
            llm_client._load_log = msg

        thread = threading.Thread(
            target=llm_client.load_model,
            args=(model_id,),
            kwargs={"on_progress": progress_callback},
            daemon=True,
        )
        thread.start()

        initial_log = f"Started loading: {model_id}"
        llm_client._load_log = initial_log
        return (
            initial_log,
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS),
            gr.update(active=True),
        )

    load_btn.click(
        on_load,
        inputs=[model_dd],
        outputs=[log_box, status_box, vram_md, model_size_md, timer],
    )

    def on_unload():
        llm_client.unload_model()
        msg = "Model unloaded."
        llm_client._load_log = msg
        return (
            msg,
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS),
            gr.update(active=False),
        )

    unload_btn.click(
        on_unload,
        outputs=[log_box, status_box, vram_md, model_size_md, timer],
    )

    def poll_status():
        status = llm_client.get_status()
        loading = status["loading"]
        return (
            llm_client._load_log or "",
            _get_status_text(llm_client),
            _get_vram_bar(llm_client),
            _get_model_size_table(llm_client, LLMClient.SUPPORTED_MODELS),
            gr.update(active=loading),
        )

    timer.tick(poll_status, outputs=[log_box, status_box, vram_md, model_size_md, timer])
