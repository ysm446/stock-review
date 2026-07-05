"""Web 検索（ddgs / DuckDuckGo）。チャットエージェントのツールとして使う。

news-picker で実証済みの方針:
- 検索失敗・0件は例外にせず [] を返す（呼び出し側を殺さない）。
- news は timelimit="w"（"d" はニッチな日本語クエリで 0 件になりがち）。
- レート制限（403）時は ddgs が Bing/Yahoo 等のバックエンドへ自動フォールバックする。
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _normalize(item: dict) -> dict | None:
    title = str(item.get("title") or "").strip()
    url = str(item.get("href") or item.get("url") or "").strip()
    if not title or not url:
        return None
    return {
        "title": title,
        "url": url,
        "snippet": str(item.get("body") or item.get("excerpt") or "").strip(),
    }


def search_text(query: str, max_results: int = 8, region: str = "jp-jp") -> list[dict]:
    """一般 Web 検索。株価・製品・技術情報などニュース索引に無いものに使う。"""
    try:
        from ddgs import DDGS

        with DDGS() as ddgs:
            raw = ddgs.text(query, region=region, safesearch="off", max_results=max_results)
    except Exception as e:
        if "no results" in str(e).lower():
            logger.info("search_text no results for %r", query)
        else:
            logger.warning("search_text failed for %r: %s", query, e)
        return []
    results = []
    for item in raw or []:
        normalized = _normalize(item)
        if normalized:
            results.append(normalized)
    return results


def search_news(query: str, max_results: int = 8, region: str = "jp-jp", timelimit: str = "w") -> list[dict]:
    """ニュース検索。直近の報道・決算・イベントに使う。"""
    try:
        from ddgs import DDGS

        with DDGS() as ddgs:
            raw = ddgs.news(
                query,
                region=region,
                safesearch="off",
                timelimit=timelimit,
                max_results=max_results,
            )
    except Exception as e:
        if "no results" in str(e).lower():
            logger.info("search_news no results for %r", query)
        else:
            logger.warning("search_news failed for %r: %s", query, e)
        return []
    results = []
    for item in raw or []:
        normalized = _normalize(item)
        if normalized is None:
            continue
        normalized["source"] = str(item.get("source") or "").strip()
        normalized["date"] = str(item.get("date") or "").strip()
        results.append(normalized)
    return results
