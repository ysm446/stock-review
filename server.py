"""FastAPI backend for Stock Review — replaces Gradio app.py."""
import json
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Optional

import uvicorn
import yaml
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).parent


# ------------------------------------------------------------------
# JSON serialization helper
# ------------------------------------------------------------------

def _safe(obj: Any) -> Any:
    """Recursively convert numpy/pandas types to JSON-serializable Python."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return {k: _safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_safe(v) for v in obj]
    try:
        import math
        if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
            return None
    except Exception:
        pass
    try:
        import numpy as np
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return None if (not obj == obj) else float(obj)  # nan check
        if isinstance(obj, np.ndarray):
            return [_safe(v) for v in obj.tolist()]
    except ImportError:
        pass
    try:
        import pandas as pd
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
    except ImportError:
        pass
    return obj


# ------------------------------------------------------------------
# Config & shared state
# ------------------------------------------------------------------

def _load_config() -> tuple[dict, dict, dict]:
    with open(BASE_DIR / "config" / "presets.yaml", encoding="utf-8") as f:
        presets = yaml.safe_load(f)
    with open(BASE_DIR / "config" / "exchanges.yaml", encoding="utf-8") as f:
        exchanges = yaml.safe_load(f)
    with open(BASE_DIR / "config" / "scenarios.yaml", encoding="utf-8") as f:
        scenarios = yaml.safe_load(f)
    return presets, exchanges, scenarios


presets, exchanges, scenarios = _load_config()

from src.data.cache_manager import CacheManager
from src.data.llm_client import LLMClient, _scan_gguf_files
from src.data.yahoo_client import YahooClient
from src.core.portfolio_manager import PortfolioManager
from src.core.report_generator import ReportGenerator
from src.core.recommender import generate_recommendations
from src.core.scenario_analysis import run_scenario
from src.core.screener import QueryScreener, ValueScreener, results_to_dataframe

cache = CacheManager(cache_dir=str(BASE_DIR / "data" / "cache"))
yahoo = YahooClient(cache_manager=cache)
llm = LLMClient(
    models_dir=str(BASE_DIR / "models"),
    persist_file=str(BASE_DIR / "data" / "last_model.json"),
)
portfolio_mgr = PortfolioManager(str(BASE_DIR / "data" / "portfolio.csv"))
query_screener = QueryScreener(yahoo, presets)
value_screener = ValueScreener(yahoo, presets)

# ------------------------------------------------------------------
# FastAPI app
# ------------------------------------------------------------------

app = FastAPI(title="Stock Review API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------

@app.get("/api/config")
def get_config():
    return {
        "presets": {k: {"description": v.get("description", k)} for k, v in presets.items()},
        "exchanges": {k: {"name": v.get("name", k)} for k, v in exchanges.items()},
        "scenarios": {k: {"name": v.get("name", k)} for k, v in scenarios.items()},
    }


# ------------------------------------------------------------------
# Screening
# ------------------------------------------------------------------

@app.get("/api/screening")
def run_screening_api(
    mode: str = "query",
    region: str = "japan",
    preset: str = "value",
    limit: int = 20,
    tickers: str = "",
):
    try:
        if mode == "list":
            ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
            if not ticker_list:
                return {"error": "ティッカーを入力してください。", "results": [], "count": 0}
            results = value_screener.screen(ticker_list, preset=preset)
        else:
            results = query_screener.screen(region, preset, limit=limit)
        df = results_to_dataframe(results)
        if df.empty:
            return {"results": [], "count": 0, "message": "条件に一致する銘柄が見つかりませんでした。"}
        records = _safe(df.to_dict(orient="records"))
        return {"results": records, "count": len(records), "message": f"{len(records)} 件"}
    except Exception as e:
        logger.exception("Screening failed")
        return {"error": str(e), "results": [], "count": 0}


# ------------------------------------------------------------------
# Report
# ------------------------------------------------------------------

class ReportRequest(BaseModel):
    ticker: str


@app.post("/api/report")
def get_report(req: ReportRequest):
    try:
        gen = ReportGenerator(yahoo, llm)
        report = gen.generate(req.ticker.strip().upper(), skip_llm=True)
        return _safe(report)
    except Exception as e:
        logger.exception("Report failed")
        return {"error": str(e)}


@app.get("/api/report/stream")
def stream_report_analysis(ticker: str):
    """Stream AI stock analysis via SSE."""
    def generate():
        try:
            gen = ReportGenerator(yahoo, llm)
            report = gen.generate(ticker.strip().upper(), skip_llm=True)
            stock_input = report.get("llm_stock_input", {})
            if not stock_input:
                yield f"data: {json.dumps({'error': 'データが取得できませんでした。'})}\n\n"
                return
            for chunk in llm.stream_analyze_stock(stock_input):
                yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Portfolio
# ------------------------------------------------------------------

@app.get("/api/portfolio")
def get_portfolio():
    try:
        positions = portfolio_mgr.get_positions()
        trades = portfolio_mgr.get_trades()
        trades_records = _safe(trades.to_dict(orient="records")) if not trades.empty else []

        # Attach company names to each position (uses cache so minimal overhead)
        for ticker, pos in positions.items():
            try:
                info = yahoo.get_ticker_info(ticker)
                name = info.get("longName") or info.get("shortName") or ticker
                if ticker.endswith(".T"):
                    localized = yahoo.get_localized_names([ticker], lang="ja-JP", region="JP")
                    name = localized.get(ticker) or name
                pos["name"] = name
            except Exception:
                pos["name"] = ticker

        return {"positions": _safe(positions), "trades": trades_records}
    except Exception as e:
        logger.exception("Portfolio failed")
        return {"error": str(e), "positions": {}, "trades": []}


@app.get("/api/portfolio/tickers")
def get_portfolio_tickers():
    try:
        return {"tickers": list(portfolio_mgr.get_positions().keys())}
    except Exception as e:
        return {"tickers": [], "error": str(e)}


class TradeRequest(BaseModel):
    date: str
    action: str
    ticker: str
    quantity: float
    price: float
    currency: str = "JPY"
    notes: str = ""


@app.post("/api/portfolio/trade")
def add_trade(req: TradeRequest):
    try:
        portfolio_mgr.add_trade(
            date=req.date,
            action=req.action,
            ticker=req.ticker.strip().upper(),
            quantity=req.quantity,
            price=req.price,
            currency=req.currency,
            notes=req.notes,
        )
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


@app.delete("/api/portfolio/trade/{index}")
def delete_trade(index: int):
    try:
        portfolio_mgr.delete_trade(index)
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}


# ------------------------------------------------------------------
# Stress test
# ------------------------------------------------------------------

@app.get("/api/stress")
def get_stress(tickers: str, scenario: str = ""):
    try:
        ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
        if not ticker_list:
            return {"error": "ティッカーを入力してください。"}
        if not scenario:
            return {"error": "シナリオを選択してください。"}
        result = run_scenario(ticker_list, scenario, scenarios, yahoo)
        if result.get("error"):
            return _safe(result)
        recs = generate_recommendations(result)
        return _safe({**result, "recommendations": recs})
    except Exception as e:
        logger.exception("Stress test failed")
        return {"error": str(e)}


# ------------------------------------------------------------------
# Chat (SSE streaming)
# ------------------------------------------------------------------

_PORTFOLIO_KEYWORDS = [
    "ポートフォリオ", "portfolio", "保有", "持ち株", "保持",
    "holdings", "わたし", "私", "my", "リバランス",
]
_TICKER_RE = re.compile(r"\b([A-Z0-9]{1,6}(?:\.[A-Z]{1,2})?)\b")
_SYSTEM_PROMPT = """\
あなたは株式投資のアシスタントです。
提供されたデータや会話履歴を参照しながら、投資家の質問に日本語で回答してください。

ルール:
- 提供されたデータのみに基づいて分析すること
- 投資助言ではなく、情報提供であることを明示すること
- データが不足している場合はその旨を伝えること
{context_section}"""


def _build_chat_context(message: str) -> str:
    sections: list[str] = []
    lower = message.lower()
    if any(kw.lower() in lower for kw in _PORTFOLIO_KEYWORDS):
        try:
            positions = portfolio_mgr.get_positions()
            if positions:
                summary = {
                    t: {"quantity": p["quantity"], "avg_price": round(p["avg_price"], 2)}
                    for t, p in positions.items()
                }
                sections.append("## 保有ポジション\n" + json.dumps(summary, ensure_ascii=False, indent=2))
        except Exception as e:
            logger.warning("Portfolio context failed: %s", e)
    found_tickers = list(dict.fromkeys(_TICKER_RE.findall(message.upper())))
    for ticker in found_tickers[:3]:
        try:
            info = yahoo.get_ticker_info(ticker)
            if not info:
                continue
            sections.append(
                f"## {ticker} の財務データ\n"
                + json.dumps({
                    "ticker": ticker,
                    "name": info.get("longName") or info.get("shortName"),
                    "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
                    "per": info.get("trailingPE") or info.get("forwardPE"),
                    "pbr": info.get("priceToBook"),
                }, ensure_ascii=False, indent=2)
            )
        except Exception as e:
            logger.warning("Stock context for %s failed: %s", ticker, e)
    return "\n\n## 参照データ\n\n" + "\n\n".join(sections) if sections else ""


class ChatRequest(BaseModel):
    message: str
    history: list = []


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    def generate():
        if not llm.is_available():
            yield f"data: {json.dumps({'error': 'モデル未読み込み。モデル管理タブでモデルを読み込んでください。'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return
        context = _build_chat_context(req.message)
        system = _SYSTEM_PROMPT.format(context_section=context)
        messages = list(req.history) + [{"role": "user", "content": req.message}]
        try:
            for chunk in llm.stream_chat(messages, system=system):
                yield f"data: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")


# ------------------------------------------------------------------
# Models
# ------------------------------------------------------------------

@app.get("/api/models")
def get_models():
    gguf_files = _scan_gguf_files(str(BASE_DIR / "models"))
    return {"models": gguf_files, "status": llm.get_status()}


@app.get("/api/models/status")
def model_status():
    return llm.get_status()


class LoadModelRequest(BaseModel):
    model_path: str


@app.post("/api/models/load")
def load_model_api(req: LoadModelRequest):
    if llm.is_loading():
        return {"error": "すでに読み込み中です。"}
    threading.Thread(target=llm.load_model, args=(req.model_path,), daemon=True).start()
    return {"ok": True}


@app.post("/api/models/unload")
def unload_model_api():
    llm.unload_model()
    return {"ok": True}


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Stock Review API server")
    parser.add_argument("--host", default=os.getenv("STOCK_REVIEW_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("STOCK_REVIEW_PORT", "8000")))
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    uvicorn.run(app, host=args.host, port=args.port)
