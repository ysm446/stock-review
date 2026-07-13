"""チャットエージェント: Web 検索・ニュース検索・銘柄指標をツールとして使う対話ループ。

news-picker の chat_agent で実証済みの設計:
- 最大 MAX_TOOL_STEPS 回のツールターン。上限に達したら tools=None で最終回答を強制。
- ツールの失敗は {"error": ...} をツール結果としてモデルに返し、ループは止めない。
- ツールターンで content が先に流れてしまった場合は turn_reset で UI に破棄させる。
- 出典 URL の列挙は system prompt で強制する（構造化はしない）。
"""
from __future__ import annotations

import json
import logging

import llm_client
import search_web

logger = logging.getLogger(__name__)

MAX_TOOL_STEPS = 8
MAX_TOKENS_PER_TURN = 4096

AGENT_SYSTEM_PROMPT = """あなたは株式投資の調査アシスタントです。必要に応じてツールを使って回答します。

ツールの使い方:
- web_search: 株価・製品・企業情報・技術情報など一般的な Web 検索。
- news_search: 直近の報道・決算・イベントのニュース検索。
- stock_snapshot: 銘柄のティッカーを指定して現在の指標（株価・PER・ROE など）を取得。

ルール:
- 検索クエリはニッチすぎる表現を避け、広めの語で。日本語で見つからなければ英語でも試す。
- 同じ意味のクエリを言い換えて何度も検索しない。2回試して見つからなければ「見つからなかった」と正直に答える。
- 検索結果を根拠にした場合は、回答の末尾に「出典:」として使った記事の URL を必ず列挙する。
- 事実・推測・意見を区別し、投資判断を断定しない。"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "一般的な Web 検索（DuckDuckGo）。株価・企業情報・製品・技術情報などに使う。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索クエリ（日本語可）"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "news_search",
            "description": "ニュース検索（直近1週間）。決算・報道・イベントなど時事性のある情報に使う。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "検索クエリ（日本語可）"}
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "stock_snapshot",
            "description": "銘柄の現在の指標（株価・時価総額・PER・PBR・ROE・配当利回りなど）を取得する。ティッカー例: 7203.T, AAPL",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string", "description": "ティッカーシンボル"}
                },
                "required": ["ticker"],
            },
        },
    },
]


def _stock_snapshot(ticker: str) -> dict:
    """fetch_review のスナップショットからチャット向けの要約を作る（ニュース・財務表は除く）。"""
    import fetch_review

    payload = fetch_review.build_payload(str(ticker or "").strip())
    return {
        "ticker": payload.get("ticker"),
        "name": payload.get("name"),
        "currency": payload.get("currency"),
        "overview": payload.get("overview"),
        "valuation": payload.get("valuation"),
        "profitability": payload.get("profitability"),
        "analyst": payload.get("analyst"),
    }


def _dispatch_tool(name: str, args: dict):
    query = str(args.get("query") or "").strip()
    if name == "web_search":
        return search_web.search_text(query, max_results=8)
    if name == "news_search":
        return search_web.search_news(query, max_results=8)
    if name == "stock_snapshot":
        return _stock_snapshot(str(args.get("ticker") or ""))
    return {"error": f"unknown tool: {name}"}


def _merge_generation_metrics(total: dict, current: dict | None) -> None:
    if not current:
        return
    for key in ("prompt_tokens", "completion_tokens", "total_tokens", "duration_seconds"):
        value = current.get(key)
        if isinstance(value, (int, float)):
            total[key] = total.get(key, 0) + value
    if current.get("finish_reason"):
        total["finish_reason"] = current["finish_reason"]


def _finalize_generation_metrics(metrics: dict) -> dict:
    result = dict(metrics)
    tokens = result.get("completion_tokens")
    duration = result.get("duration_seconds")
    if isinstance(tokens, (int, float)) and isinstance(duration, (int, float)) and duration > 0:
        result["tokens_per_second"] = tokens / duration
    return result


def run_chat_agent(llm_messages: list[dict], *, base_url: str):
    """イベント dict を順に yield する。最後に最終回答と生成メトリクスを _final で返す。

    '_final' は呼び出し側（chat_server）が永続化に使う内部イベントで、SSE には流さない。
    """
    msgs = list(llm_messages)
    generation_metrics: dict = {}

    for _step in range(MAX_TOOL_STEPS):
        content_parts: list[str] = []
        reasoning_parts: list[str] = []
        tool_calls = None

        for kind, data in llm_client.chat_stream(
            base_url, msgs, tools=TOOLS, max_tokens=MAX_TOKENS_PER_TURN
        ):
            if kind == "content":
                content_parts.append(data)
                yield {"type": "token", "content": data}
            elif kind == "reasoning":
                reasoning_parts.append(data)
            elif kind == "tool_calls":
                tool_calls = data
            elif kind == "metrics":
                _merge_generation_metrics(generation_metrics, data)

        if reasoning_parts:
            yield {"type": "thinking", "content": "".join(reasoning_parts)}

        content = "".join(content_parts)
        if not tool_calls:
            yield {"type": "_final", "content": content, "metrics": _finalize_generation_metrics(generation_metrics)}
            return

        # ツールターンなのに content が流れていたら UI 側で破棄させる
        if content:
            yield {"type": "turn_reset"}

        msgs.append({"role": "assistant", "content": content or None, "tool_calls": tool_calls})
        for tc in tool_calls:
            name = tc.get("function", {}).get("name", "")
            try:
                args = json.loads(tc.get("function", {}).get("arguments") or "{}")
            except json.JSONDecodeError:
                args = {}
            yield {"type": "tool_call", "name": name, "args": args}
            try:
                result = _dispatch_tool(name, args)
            except Exception as e:  # ツール失敗でループを止めず、モデルに伝える
                logger.warning("tool %s failed: %s", name, e)
                result = {"error": str(e)[:200]}
            count = len(result) if isinstance(result, list) else None
            yield {"type": "tool_result", "name": name, "count": count}
            msgs.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )

    # 上限到達: ツール無しで最終回答を強制
    msgs.append(
        {
            "role": "user",
            "content": "検索回数の上限に達しました。ここまでに得られた情報だけで最終回答をまとめてください。",
        }
    )
    content_parts = []
    for kind, data in llm_client.chat_stream(
        base_url, msgs, tools=None, max_tokens=MAX_TOKENS_PER_TURN
    ):
        if kind == "content":
            content_parts.append(data)
            yield {"type": "token", "content": data}
        elif kind == "reasoning":
            pass
        elif kind == "metrics":
            _merge_generation_metrics(generation_metrics, data)
    yield {"type": "_final", "content": "".join(content_parts), "metrics": _finalize_generation_metrics(generation_metrics)}
