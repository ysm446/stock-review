"""Local LLM client via llama-cpp-python (GGUF)."""
import gc
import json
import logging
import threading
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger(__name__)

_STOCK_SYSTEM_PROMPT = """あなたは株式投資のアナリストです。
提供された財務データに基づいて、投資判断に役立つサマリーを日本語で作成してください。

出力形式（必ず以下の3つの見出しを ### で始めること）:
### 投資判断サマリー
### リスク要因
### 注目ポイント

ルール:
- 提供されたデータのみに基づいて分析すること
- 投資助言ではなく、情報提供であることを明示すること
- ポジティブ/ネガティブ両面をバランスよく記述すること
- 専門用語を使う場合は簡潔な説明を添えること"""

_PORTFOLIO_SYSTEM_PROMPT = """あなたは資産運用の専門家です。
提供されたポートフォリオデータに基づき、リスクと分散の観点からサマリーを日本語で作成してください。
投資助言ではなく情報提供であることを明示してください。"""


def _scan_gguf_files(models_dir: str) -> dict[str, str]:
    """Scan models_dir for .gguf files and return {display_name: path} dict."""
    result: dict[str, str] = {}
    base = Path(models_dir)
    if base.is_dir():
        for p in sorted(base.glob("*.gguf")):
            result[p.stem] = str(p)
    return result


class LLMClient:
    """Client for local LLM inference via llama-cpp-python (GGUF format)."""

    # Default model registry — updated at runtime by scanning models_dir
    SUPPORTED_MODELS: dict[str, str] = {
        "Qwen3-8B-Q4_K_M": "models/Qwen3-8B-Q4_K_M.gguf",
    }

    def __init__(
        self,
        model_path: Optional[str] = None,
        models_dir: str = "models",
        n_gpu_layers: int = -1,
        n_ctx: int = 4096,
        load_on_init: bool = False,
        persist_file: Optional[str] = None,
        # Legacy / vLLM kwargs — silently ignored
        **_,
    ) -> None:
        """
        Args:
            model_path: Path to .gguf model file to load.
            models_dir: Directory to scan for .gguf files.
            n_gpu_layers: Number of layers to offload to GPU (-1 = all).
            n_ctx: Context size (tokens).
            load_on_init: If True, load model_path immediately.
            persist_file: JSON file for saving/restoring last used model path.
        """
        self._models_dir = models_dir
        self._n_gpu_layers = n_gpu_layers
        self._n_ctx = n_ctx
        self._persist_file = Path(persist_file) if persist_file else None

        self._llm = None
        self._current_model_path: Optional[str] = None
        self._available: bool = False
        self._load_error: str = ""
        self._load_log: str = ""

        self._state_lock = threading.Lock()
        self._generation_lock = threading.Lock()
        self._loading = threading.Event()

        # Refresh SUPPORTED_MODELS from disk
        scanned = _scan_gguf_files(models_dir)
        if scanned:
            LLMClient.SUPPORTED_MODELS = scanned

        # Resolve model path: argument > persist file > first available
        resolved = model_path or self._load_persist() or self._first_model()
        if load_on_init and resolved:
            self.load_model(resolved)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        with self._state_lock:
            return self._available

    def reset_availability_cache(self) -> None:
        """No-op — kept for API compatibility."""
        pass

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.3,
    ) -> str:
        if not self.is_available():
            return ""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return self._run_chat(messages, temperature)

    def chat(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        temperature: float = 0.3,
    ) -> str:
        if not self.is_available():
            return ""
        all_messages = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)
        return self._run_chat(all_messages, temperature)

    def analyze_stock(self, stock_data: dict) -> str:
        prompt = (
            "以下の銘柄データを分析し、投資家向けのサマリーを作成してください:\n\n"
            f"{json.dumps(stock_data, ensure_ascii=False, indent=2)}"
        )
        return self.generate(prompt, system=_STOCK_SYSTEM_PROMPT)

    def summarize_portfolio(self, portfolio_data: dict) -> str:
        prompt = (
            "以下のポートフォリオデータを分析し、リスク評価と改善提案を作成してください:\n\n"
            f"{json.dumps(portfolio_data, ensure_ascii=False, indent=2)}"
        )
        return self.generate(prompt, system=_PORTFOLIO_SYSTEM_PROMPT)

    # ------------------------------------------------------------------
    # Streaming generation
    # ------------------------------------------------------------------

    def stream_generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.3,
    ):
        if not self.is_available():
            return
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        yield from self._stream_run(messages, temperature)

    def stream_chat(
        self,
        messages: list[dict],
        system: Optional[str] = None,
        temperature: float = 0.3,
    ):
        if not self.is_available():
            return
        all_messages = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)
        yield from self._stream_run(all_messages, temperature)

    def stream_analyze_stock(self, stock_data: dict):
        prompt = (
            "以下の銘柄データを分析し、投資家向けのサマリーを作成してください:\n\n"
            f"{json.dumps(stock_data, ensure_ascii=False, indent=2)}"
        )
        yield from self.stream_generate(prompt, system=_STOCK_SYSTEM_PROMPT)

    # ------------------------------------------------------------------
    # Model management
    # ------------------------------------------------------------------

    def is_loading(self) -> bool:
        return self._loading.is_set()

    def get_status(self) -> dict:
        vram_alloc = 0.0
        vram_reserved = 0.0
        vram_total = 0.0
        try:
            import torch
            if torch.cuda.is_available():
                vram_alloc = torch.cuda.memory_allocated() / 1024 ** 3
                vram_reserved = torch.cuda.memory_reserved() / 1024 ** 3
                vram_total = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
        except Exception:
            pass

        with self._state_lock:
            return {
                "available": self._available,
                "loading": self._loading.is_set(),
                "current_model_id": (
                    Path(self._current_model_path).stem
                    if self._current_model_path else None
                ),
                "current_model_path": self._current_model_path,
                "load_error": self._load_error,
                "vram_allocated_gb": vram_alloc,
                "vram_reserved_gb": vram_reserved,
                "vram_total_gb": vram_total,
            }

    def get_last_persisted_model(self) -> Optional[str]:
        """Return the last used model path, or None."""
        return self._load_persist()

    def load_model(
        self,
        model_path: str,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> None:
        """Load a GGUF model (thread-safe). Call from a background thread."""
        if self._loading.is_set():
            return

        self._loading.set()

        def _report(msg: str) -> None:
            logger.info("LLM load: %s", msg)
            self._load_log = msg
            if on_progress:
                on_progress(msg)

        try:
            from llama_cpp import Llama

            # Unload existing model first
            with self._generation_lock:
                if self._llm is not None:
                    _report("旧モデルをアンロード中...")
                    with self._state_lock:
                        self._llm = None
                        self._available = False
                    gc.collect()

            _report(f"モデルを読み込み中: {model_path}")
            llm = Llama(
                model_path=model_path,
                n_gpu_layers=self._n_gpu_layers,
                n_ctx=self._n_ctx,
                verbose=False,
            )

            with self._generation_lock:
                with self._state_lock:
                    self._llm = llm
                    self._current_model_path = model_path
                    self._available = True
                    self._load_error = ""

            self._save_persist(model_path)
            _report(f"読み込み完了: {Path(model_path).name}")

        except Exception as e:
            err = str(e)
            with self._state_lock:
                self._load_error = err
                self._available = False
            logger.error("Model load failed: %s", err)
            _report(f"エラー: {err}")
        finally:
            self._loading.clear()

    def unload_model(self) -> None:
        """Unload the current model, freeing VRAM."""
        with self._generation_lock:
            with self._state_lock:
                self._llm = None
                self._current_model_path = None
                self._available = False
                self._load_error = ""
        gc.collect()
        logger.info("Model unloaded.")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _first_model(self) -> Optional[str]:
        """Return the path of the first available GGUF file, or None."""
        for path in LLMClient.SUPPORTED_MODELS.values():
            if Path(path).exists():
                return path
        return None

    def _run_chat(self, messages: list[dict], temperature: float) -> str:
        with self._generation_lock:
            if not self._available:
                return ""
            try:
                resp = self._llm.create_chat_completion(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=1024,
                )
                return resp["choices"][0]["message"]["content"] or ""
            except Exception as e:
                logger.warning("Generation failed: %s", e)
                return ""

    def _stream_run(self, messages: list[dict], temperature: float):
        with self._generation_lock:
            if not self._available:
                return
            try:
                stream = self._llm.create_chat_completion(
                    messages=messages,
                    temperature=temperature,
                    max_tokens=1024,
                    stream=True,
                )
                accumulated = ""
                for chunk in stream:
                    delta = chunk["choices"][0]["delta"].get("content", "") or ""
                    accumulated += delta
                    yield accumulated
            except Exception as e:
                logger.warning("Stream generation failed: %s", e)

    def _load_persist(self) -> Optional[str]:
        if not self._persist_file or not self._persist_file.exists():
            return None
        try:
            data = json.loads(self._persist_file.read_text(encoding="utf-8"))
            # Support both old format {"model_id": ...} and new {"model_path": ...}
            path = data.get("model_path") or data.get("model_id")
            if path and Path(path).exists():
                return path
        except Exception:
            pass
        return None

    def _save_persist(self, model_path: str) -> None:
        if not self._persist_file:
            return
        try:
            self._persist_file.parent.mkdir(parents=True, exist_ok=True)
            self._persist_file.write_text(
                json.dumps({"model_path": model_path}), encoding="utf-8"
            )
        except Exception as e:
            logger.warning("Failed to save persist file: %s", e)
