"""Portfolio management tab UI."""
import logging

import gradio as gr
import pandas as pd

from src.core.health_check import check_health
from src.core.portfolio_manager import PortfolioManager
from src.core.return_estimate import estimate_return
from src.utils.formatter import fmt_pct, fmt_price, markdown_table

logger = logging.getLogger(__name__)

_PORTFOLIO_CSV = "data/portfolio.csv"


def build_portfolio_tab(yahoo_client) -> None:
    """Build the portfolio management tab UI."""
    gr.Markdown("## ポートフォリオ管理")

    manager = PortfolioManager(_PORTFOLIO_CSV)

    with gr.Tabs():
        # ── 1. 売買記録 ──────────────────────────────────────────────────
        with gr.Tab("売買記録"):
            gr.Markdown("### 売買記録")
            with gr.Row():
                action_dd = gr.Dropdown(
                    choices=["buy", "sell"], value="buy", label="売買区分", scale=1
                )
                ticker_in = gr.Textbox(label="ティッカー", placeholder="例: 7203.T", scale=2)
                qty_in = gr.Number(label="数量", value=1, minimum=0, scale=1)
                price_in = gr.Number(label="単価", value=0, minimum=0, scale=1)
                currency_dd = gr.Dropdown(
                    choices=["JPY", "USD", "EUR", "HKD", "SGD"],
                    value="JPY",
                    label="通貨",
                    scale=1,
                )
                notes_in = gr.Textbox(label="メモ (任意)", scale=2)
            record_btn = gr.Button("記録", variant="primary")
            record_status = gr.Markdown("")
            trades_df = gr.DataFrame(label="売買記録一覧", interactive=False)

            def refresh_trades():
                df = manager.get_trades()
                if df.empty:
                    return pd.DataFrame(
                        columns=["date", "action", "ticker", "quantity", "price", "currency", "notes"]
                    )
                return df

            def add_trade(action, ticker, qty, price, currency, notes):
                ticker = (ticker or "").strip()
                if not ticker:
                    return "ティッカーを入力してください。", refresh_trades()
                if qty <= 0:
                    return "数量は 0 より大きい値を入力してください。", refresh_trades()
                try:
                    manager.add_trade(action, ticker, qty, price, currency, notes or "")
                    return (
                        f"{action.upper()} {ticker} × {qty} @ {price} {currency} を記録しました。",
                        refresh_trades(),
                    )
                except Exception as e:
                    logger.exception("add_trade failed")
                    return f"エラー: {e}", refresh_trades()

            record_btn.click(
                add_trade,
                inputs=[action_dd, ticker_in, qty_in, price_in, currency_dd, notes_in],
                outputs=[record_status, trades_df],
            )
            trades_df.value = refresh_trades()

        # ── 2. スナップショット ──────────────────────────────────────────
        with gr.Tab("スナップショット"):
            gr.Markdown("### 評価額スナップショット")
            snapshot_btn = gr.Button("更新", variant="primary")
            snapshot_status = gr.Markdown("")
            snapshot_df = gr.DataFrame(label="保有銘柄一覧", interactive=False)

            def run_snapshot():
                yield "評価額を取得中...", pd.DataFrame()
                positions = manager.get_positions()
                if not positions:
                    yield "ポートフォリオに銘柄がありません。売買記録から銘柄を追加してください。", pd.DataFrame()
                    return
                snap = manager.get_snapshot(yahoo_client)
                rows = []
                for item in snap:
                    cur = item["currency"]
                    rows.append({
                        "ティッカー": item["ticker"],
                        "銘柄名": item["name"],
                        "数量": item["quantity"],
                        "平均取得単価": fmt_price(item["avg_price"], cur),
                        "現在株価": fmt_price(item["current_price"], cur) if item["current_price"] else "-",
                        "評価額": fmt_price(item["market_value"], cur) if item["market_value"] else "-",
                        "損益": fmt_price(item["gain"], cur) if item["gain"] is not None else "-",
                        "損益率": fmt_pct(item["gain_pct"]) if item["gain_pct"] is not None else "-",
                    })
                yield "更新完了", pd.DataFrame(rows)

            snapshot_btn.click(run_snapshot, outputs=[snapshot_status, snapshot_df])

        # ── 3. 構造分析 ──────────────────────────────────────────────────
        with gr.Tab("構造分析"):
            gr.Markdown("### ポートフォリオ構造分析")
            structure_btn = gr.Button("分析", variant="primary")
            structure_out = gr.Markdown("*[分析] ボタンを押してください。*")

            def run_structure():
                yield "分析中..."
                positions = manager.get_positions()
                if not positions:
                    yield "ポートフォリオに銘柄がありません。"
                    return
                struct = manager.get_structure(yahoo_client)
                hhi = struct["hhi"]
                sectors = struct["sectors"]
                tickers = struct["tickers"]

                if hhi < 0.15:
                    hhi_label = "低集中 (分散良好)"
                elif hhi < 0.25:
                    hhi_label = "中程度の集中"
                else:
                    hhi_label = "高集中 (リスク注意)"

                lines = [
                    f"**保有銘柄数:** {len(tickers)}",
                    f"**HHI 集中度指数:** {hhi:.4f} — {hhi_label}",
                    "",
                    "### セクター配分",
                ]
                if sectors:
                    sector_rows = [[s, f"{p}%"] for s, p in sectors.items()]
                    lines.append(markdown_table(["セクター", "比率"], sector_rows))
                else:
                    lines.append("*セクター情報なし*")

                yield "\n".join(lines)

            structure_btn.click(run_structure, outputs=[structure_out])

        # ── 4. ヘルスチェック ────────────────────────────────────────────
        with gr.Tab("ヘルスチェック"):
            gr.Markdown("### ヘルスチェック")
            gr.Markdown(
                "ティッカーをカンマ区切りで入力するか、空欄のままにすると保有銘柄全体をチェックします。"
            )
            health_input = gr.Textbox(
                label="ティッカー (空欄=保有銘柄全体)",
                placeholder="例: 7203.T, AAPL",
            )
            health_btn = gr.Button("チェック", variant="primary")
            health_out = gr.Markdown("*[チェック] ボタンを押してください。*")

            def run_health(tickers_raw: str):
                yield "チェック中..."
                if tickers_raw.strip():
                    tickers = [t.strip() for t in tickers_raw.split(",") if t.strip()]
                else:
                    tickers = list(manager.get_positions().keys())
                if not tickers:
                    yield "ポートフォリオに銘柄がありません。"
                    return

                lines = []
                for ticker in tickers:
                    result = check_health(ticker, yahoo_client)
                    lines.append(
                        f"### {result['level_label']}　{result['name']} `{result['ticker']}`"
                    )
                    if result["is_etf"]:
                        lines.append("*ETF: テクニカル指標のみで評価*")
                    tech = result["technicals"]
                    if tech.get("current_price"):
                        sma50_str = f"{tech['sma50']:.1f}" if tech["sma50"] else "-"
                        sma200_str = f"{tech['sma200']:.1f}" if tech["sma200"] else "-"
                        rsi_str = str(tech["rsi"]) if tech["rsi"] else "-"
                        lines.append(
                            f"現在株価: {tech['current_price']:.1f}　"
                            f"SMA50: {sma50_str}　"
                            f"SMA200: {sma200_str}　"
                            f"RSI: {rsi_str}"
                        )
                    if result["signals"]:
                        lines.append("**発動シグナル:**")
                        for sig in result["signals"]:
                            lines.append(f"- {sig}")
                    lines.append(f"**推奨アクション:** {result['action']}")
                    lines.append("")
                yield "\n".join(lines)

            health_btn.click(run_health, inputs=[health_input], outputs=[health_out])

        # ── 5. 推定利回り ────────────────────────────────────────────────
        with gr.Tab("推定利回り"):
            gr.Markdown("### 推定利回り (3シナリオ)")
            gr.Markdown(
                "ティッカーをカンマ区切りで入力するか、空欄のままにすると保有銘柄全体を試算します。"
            )
            return_input = gr.Textbox(
                label="ティッカー (空欄=保有銘柄全体)",
                placeholder="例: 7203.T, AAPL",
            )
            return_btn = gr.Button("試算", variant="primary")
            return_out = gr.Markdown("*[試算] ボタンを押してください。*")

            def run_return(tickers_raw: str):
                yield "試算中..."
                if tickers_raw.strip():
                    tickers = [t.strip() for t in tickers_raw.split(",") if t.strip()]
                else:
                    tickers = list(manager.get_positions().keys())
                if not tickers:
                    yield "ポートフォリオに銘柄がありません。"
                    return

                rows = []
                for ticker in tickers:
                    est = estimate_return(ticker, yahoo_client)
                    rows.append([
                        f"{est['name']} ({est['ticker']})",
                        "CAGR" if est["method"] == "cagr" else "アナリスト",
                        fmt_pct(est["pessimistic"]),
                        fmt_pct(est["base"]),
                        fmt_pct(est["optimistic"]),
                        est["note"] or "-",
                    ])

                table = markdown_table(
                    ["銘柄", "算出方法", "悲観", "ベース", "楽観", "備考"],
                    rows,
                )
                yield table

            return_btn.click(run_return, inputs=[return_input], outputs=[return_out])
