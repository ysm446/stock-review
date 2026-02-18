"""Local LLM client via Ollama API."""
import json
import logging
from typing import Optional

import requests

logger = logging.getLogger(__name__)

_STOCK_SYSTEM_PROMPT = """あなたは株式投資のアナリストです。
提供された財務データに基づいて、投資判断に役立つサマリーを日本語で作成してください。

ルール:
- 提供されたデータのみに基づいて分析すること
- 投資助言ではなく、情報提供であることを明示すること
- ポジティブ/ネガティブ両面をバランスよく記述すること
- 専門用語を使う場合は簡潔な説明を添えること"""

_PORTFOLIO_SYSTEM_PROMPT = """あなたは資産運用の専門家です。
提供されたポートフォリオデータに基づき、リスクと分散の観点からサマリーを日本語で作成してください。
投資助言ではなく情報提供であることを明示してください。"""


class LLMClient:
    """Client for local LLM inference via Ollama."""

    def __init__(
        self,
        model: str = "qwen3:8b",
        base_url: str = "http://localhost:11434",
    ):
        """
        Args:
            model: Ollama model name (e.g. "qwen3:14b").
            base_url: Ollama server base URL.
        """
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._available: Optional[bool] = None

    def is_available(self) -> bool:
        """Check if Ollama server is reachable."""
        if self._available is not None:
            return self._available
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=3)
            self._available = resp.status_code == 200
        except Exception:
            self._available = False
        return self._available

    def reset_availability_cache(self) -> None:
        """Force re-check on next is_available() call."""
        self._available = None

    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        temperature: float = 0.3,
    ) -> str:
        """Single-turn text generation.

        Returns empty string if Ollama is unavailable.
        """
        if not self.is_available():
            return ""
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature},
        }
        if system:
            payload["system"] = system
        try:
            resp = requests.post(
                f"{self.base_url}/api/generate", json=payload, timeout=120
            )
            resp.raise_for_status()
            return resp.json().get("response", "")
        except Exception as e:
            logger.warning("LLM generate failed: %s", e)
            return ""

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

        Returns empty string if Ollama is unavailable.
        """
        if not self.is_available():
            return ""
        all_messages = []
        if system:
            all_messages.append({"role": "system", "content": system})
        all_messages.extend(messages)
        payload = {
            "model": self.model,
            "messages": all_messages,
            "stream": False,
            "options": {"temperature": temperature},
        }
        try:
            resp = requests.post(
                f"{self.base_url}/api/chat", json=payload, timeout=120
            )
            resp.raise_for_status()
            return resp.json().get("message", {}).get("content", "")
        except Exception as e:
            logger.warning("LLM chat failed: %s", e)
            return ""

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
