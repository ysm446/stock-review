"""Local LLM client via Hugging Face Transformers."""
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


class LLMClient:
    """Client for local LLM inference via Hugging Face Transformers."""

    SUPPORTED_MODELS: dict[str, str] = {
        "Qwen3-4B":  "Qwen/Qwen3-4B",
        "Qwen3-8B":  "Qwen/Qwen3-8B",
        "Qwen3-14B": "Qwen/Qwen3-14B",
        "Qwen3-32B": "Qwen/Qwen3-32B",
    }

    def __init__(
        self,
        model_id: str = "Qwen/Qwen3-8B",
        cache_dir: str = r"d:\GitHub\stock-advisor\models",
        device: str = "auto",
        load_on_init: bool = False,
        persist_file: Optional[str] = None,
    ) -> None:
        """
        Args:
            model_id: Hugging Face model ID (e.g. "Qwen/Qwen3-8B").
            cache_dir: Local directory to cache downloaded model files.
            device: "auto" lets accelerate choose GPU/CPU automatically.
            load_on_init: If True, load the model synchronously at construction.
            persist_file: Path to a JSON file for saving/restoring the last used
                          model ID across restarts.
        """
        self._model_id = model_id
        self._cache_dir = cache_dir
        self._device = device
        self._persist_file = Path(persist_file) if persist_file else None

        self._model = None
        self._tokenizer = None
        self._current_model_id: Optional[str] = None
        self._available: bool = False
        self._load_error: str = ""
        self._load_log: str = ""

        self._state_lock = threading.Lock()
        self._generation_lock = threading.Lock()
        self._loading = threading.Event()

        if load_on_init:
            self.load_model(model_id)

    # ------------------------------------------------------------------
    # Public interface (backward-compatible with Ollama version)
    # ------------------------------------------------------------------

    def is_available(self) -> bool:
        """Return True iff a model is loaded and ready for inference."""
        with self._state_lock:
            return self._available

    def reset_availability_cache(self) -> None:
        """No-op — kept for backward compatibility with chat_tab.py."""
        pass

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.3,
    ) -> str:
        """Single-turn text generation.

        Returns empty string if no model is loaded.
        """
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
        """Multi-turn chat generation.

        Args:
            messages: List of {"role": "user"|"assistant", "content": str}.
            system: Optional system prompt prepended to messages.

        Returns empty string if no model is loaded.
        """
        if not self.is_available():
            return ""
        all_messages = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)
        return self._run_chat(all_messages, temperature)

    def analyze_stock(self, stock_data: dict) -> str:
        """Generate natural language analysis for a stock."""
        prompt = (
            "以下の銘柄データを分析し、投資家向けのサマリーを作成してください:\n\n"
            f"{json.dumps(stock_data, ensure_ascii=False, indent=2)}"
        )
        return self.generate(prompt, system=_STOCK_SYSTEM_PROMPT)

    def summarize_portfolio(self, portfolio_data: dict) -> str:
        """Generate a portfolio-level summary."""
        prompt = (
            "以下のポートフォリオデータを分析し、リスク評価と改善提案を作成してください:\n\n"
            f"{json.dumps(portfolio_data, ensure_ascii=False, indent=2)}"
        )
        return self.generate(prompt, system=_PORTFOLIO_SYSTEM_PROMPT)

    # ------------------------------------------------------------------
    # Streaming generation (yields accumulated text incrementally)
    # ------------------------------------------------------------------

    def stream_generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.3,
    ):
        """Single-turn streaming text generation.

        Yields accumulated text strings as tokens are generated.
        Yields nothing if no model is loaded.
        """
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
        """Multi-turn streaming chat generation.

        Yields accumulated text strings as tokens are generated.
        Yields nothing if no model is loaded.
        """
        if not self.is_available():
            return
        all_messages = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)
        yield from self._stream_run(all_messages, temperature)

    def stream_analyze_stock(self, stock_data: dict):
        """Streaming version of analyze_stock.

        Yields accumulated text strings as tokens are generated.
        """
        prompt = (
            "以下の銘柄データを分析し、投資家向けのサマリーを作成してください:\n\n"
            f"{json.dumps(stock_data, ensure_ascii=False, indent=2)}"
        )
        yield from self.stream_generate(prompt, system=_STOCK_SYSTEM_PROMPT)

    # ------------------------------------------------------------------
    # Persist file helpers
    # ------------------------------------------------------------------

    def get_last_persisted_model(self) -> Optional[str]:
        """Return the model ID saved in the persist file, or None."""
        if not self._persist_file or not self._persist_file.exists():
            return None
        try:
            data = json.loads(self._persist_file.read_text(encoding="utf-8"))
            return data.get("model_id")
        except Exception:
            return None

    def _save_persist(self, model_id: str) -> None:
        """Write the current model ID to the persist file."""
        if not self._persist_file:
            return
        try:
            self._persist_file.parent.mkdir(parents=True, exist_ok=True)
            self._persist_file.write_text(
                json.dumps({"model_id": model_id}), encoding="utf-8"
            )
        except Exception as e:
            logger.warning("Failed to save persist file: %s", e)

    # ------------------------------------------------------------------
    # Model management (used by model_tab.py)
    # ------------------------------------------------------------------

    def is_loading(self) -> bool:
        """Return True while a background load is in progress."""
        return self._loading.is_set()

    def get_status(self) -> dict:
        """Return a status dict for the model management UI.

        Returns:
            dict with keys: available, loading, current_model_id,
            load_error, vram_allocated_gb, vram_reserved_gb, vram_total_gb.
        """
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
                "current_model_id": self._current_model_id,
                "load_error": self._load_error,
                "vram_allocated_gb": vram_alloc,
                "vram_reserved_gb": vram_reserved,
                "vram_total_gb": vram_total,
            }

    def load_model(
        self,
        model_id: str,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> None:
        """Load a model (run this in a background thread for non-blocking UI).

        Args:
            model_id: HF model ID, e.g. "Qwen/Qwen3-8B".
            on_progress: Optional callback called with status strings during load.
        """
        if self._loading.is_set():
            return

        self._loading.set()

        def _report(msg: str) -> None:
            logger.info("LLM load: %s", msg)
            self._load_log = msg
            if on_progress:
                on_progress(msg)

        try:
            from transformers import AutoModelForCausalLM, AutoTokenizer
            import torch

            # 1. Unload old model first to free VRAM
            with self._generation_lock:
                if self._model is not None:
                    _report("旧モデルをアンロード中...")
                    with self._state_lock:
                        self._model = None
                        self._tokenizer = None
                        self._available = False
                    gc.collect()
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()

            # 2. Load tokenizer
            _report(f"トークナイザーを読み込み中: {model_id}")
            tokenizer = AutoTokenizer.from_pretrained(
                model_id,
                cache_dir=self._cache_dir,
                trust_remote_code=True,
            )

            # 3. Load model
            _report(f"モデルを読み込み中: {model_id}  (初回はダウンロードに数分かかります)")
            use_bf16 = torch.cuda.is_available()
            model = AutoModelForCausalLM.from_pretrained(
                model_id,
                cache_dir=self._cache_dir,
                torch_dtype=torch.bfloat16 if use_bf16 else torch.float32,
                device_map=self._device,
                trust_remote_code=True,
            )
            model.eval()

            # 4. Atomic swap
            with self._generation_lock:
                with self._state_lock:
                    self._model = model
                    self._tokenizer = tokenizer
                    self._current_model_id = model_id
                    self._available = True
                    self._load_error = ""

            self._save_persist(model_id)
            _report(f"読み込み完了: {model_id}")

        except Exception as e:
            with self._state_lock:
                self._load_error = str(e)
                self._available = False
            logger.error("Model load failed: %s", e)
            _report(f"エラー: {e}")
        finally:
            self._loading.clear()

    def unload_model(self) -> None:
        """Unload the current model, freeing VRAM."""
        with self._generation_lock:
            with self._state_lock:
                self._model = None
                self._tokenizer = None
                self._current_model_id = None
                self._available = False
                self._load_error = ""
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        logger.info("Model unloaded.")

    # ------------------------------------------------------------------
    # Internal generation
    # ------------------------------------------------------------------

    def _stream_run(self, messages: list[dict], temperature: float):
        """Core streaming generation. Holds generation lock while streaming.

        Yields accumulated text strings one token at a time.
        The generation lock is held for the entire streaming duration,
        preventing model unload during active generation.
        """
        with self._generation_lock:
            if not self._available:
                return
            try:
                import threading
                import torch
                from transformers import TextIteratorStreamer

                # Build prompt
                try:
                    text = self._tokenizer.apply_chat_template(
                        messages,
                        tokenize=False,
                        add_generation_prompt=True,
                        enable_thinking=False,
                    )
                except TypeError:
                    text = self._tokenizer.apply_chat_template(
                        messages,
                        tokenize=False,
                        add_generation_prompt=True,
                    )

                model_inputs = self._tokenizer(
                    [text], return_tensors="pt"
                ).to(self._model.device)

                streamer = TextIteratorStreamer(
                    self._tokenizer,
                    skip_prompt=True,
                    skip_special_tokens=True,
                )

                generation_kwargs = {
                    **model_inputs,
                    "max_new_tokens": 1024,
                    "temperature": temperature,
                    "do_sample": temperature > 0,
                    "pad_token_id": self._tokenizer.eos_token_id,
                    "streamer": streamer,
                }

                thread = threading.Thread(
                    target=self._model.generate,
                    kwargs=generation_kwargs,
                    daemon=True,
                )
                thread.start()

                accumulated = ""
                for token in streamer:
                    accumulated += token
                    yield accumulated

                thread.join(timeout=120)

            except Exception as e:
                logger.warning("Stream generation failed: %s", e)

    def _run_chat(self, messages: list[dict], temperature: float) -> str:
        """Core generation. Holds generation lock to prevent unload races."""
        with self._generation_lock:
            if not self._available:
                return ""
            try:
                import torch

                # Build prompt with chat template
                # enable_thinking=False suppresses <think> blocks (transformers>=4.51)
                try:
                    text = self._tokenizer.apply_chat_template(
                        messages,
                        tokenize=False,
                        add_generation_prompt=True,
                        enable_thinking=False,
                    )
                except TypeError:
                    # Fallback for older transformers without enable_thinking
                    text = self._tokenizer.apply_chat_template(
                        messages,
                        tokenize=False,
                        add_generation_prompt=True,
                    )

                model_inputs = self._tokenizer(
                    [text], return_tensors="pt"
                ).to(self._model.device)

                with torch.no_grad():
                    generated_ids = self._model.generate(
                        **model_inputs,
                        max_new_tokens=1024,
                        temperature=temperature,
                        do_sample=temperature > 0,
                        pad_token_id=self._tokenizer.eos_token_id,
                    )

                output_ids = generated_ids[0][len(model_inputs.input_ids[0]):]
                result = self._tokenizer.decode(
                    output_ids, skip_special_tokens=True
                ).strip()
                return result

            except Exception as e:
                logger.warning("Generation failed: %s", e)
                return ""
