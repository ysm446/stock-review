"""llama-server (OpenAI 互換 API) クライアント。標準ライブラリのみ使用。

Ornith (Qwen 3.5 系 reasoning + tool-calling) 前提の注意点:
- llama-server は --jinja 起動時に思考を delta.reasoning_content に分離して返す。
  <think> タグを自前でパースしてはいけない。
- 思考は一言の回答にも ~1000 トークン消費するため、チャットは max_tokens を
  大きめ (4096) に、背景処理は enable_thinking=False にする。
- system メッセージは 1 つに結合すること（複数あると 400 を返すテンプレートがある）。
"""
from __future__ import annotations

import json
import logging
from urllib import error as urllib_error
from urllib import request as urllib_request

logger = logging.getLogger(__name__)

DEFAULT_SAMPLING = {"temperature": 0.6, "top_p": 0.95, "top_k": 20}


def chat_stream(
    base_url: str,
    messages: list[dict],
    *,
    tools: list[dict] | None = None,
    max_tokens: int = 2048,
    timeout: int = 600,
    enable_thinking: bool | None = None,
):
    """ストリーミングで ("reasoning"|"content", text) を yield し、
    ツール呼び出しがあれば最後に ("tool_calls", list) を yield する。"""
    payload: dict = {
        "model": "local",
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens,
        **DEFAULT_SAMPLING,
    }
    if tools:
        payload["tools"] = tools
    if enable_thinking is not None:
        payload["chat_template_kwargs"] = {"enable_thinking": enable_thinking}

    req = urllib_request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # ストリーミングのツール呼び出し断片は index ごとに name / arguments を連結して復元する
    tool_calls: list[dict] = []
    try:
        with urllib_request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue
                choices = data.get("choices") or [{}]
                delta = choices[0].get("delta") or {}
                reasoning = delta.get("reasoning_content")
                if reasoning:
                    yield ("reasoning", reasoning)
                content = delta.get("content")
                if content:
                    yield ("content", content)
                for tc in delta.get("tool_calls") or []:
                    index = tc.get("index", 0)
                    while len(tool_calls) <= index:
                        tool_calls.append(
                            {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                        )
                    slot = tool_calls[index]
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        slot["function"]["arguments"] += fn["arguments"]
    except urllib_error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:500]
        except Exception:
            pass
        # エラーボディにはテンプレート起因の失敗理由が入るため必ず載せる
        raise RuntimeError(f"llama-server {e.code}: {body}") from e

    if tool_calls:
        yield ("tool_calls", tool_calls)
