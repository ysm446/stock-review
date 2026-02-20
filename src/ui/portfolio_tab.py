"""Portfolio management tab UI."""
import csv
import logging

import gradio as gr
import pandas as pd

from src.core.health_check import check_health
from src.core.portfolio_manager import PortfolioManager
from src.core.return_estimate import estimate_return
from src.utils.formatter import fmt_pct, fmt_price, markdown_table

logger = logging.getLogger(__name__)

_PORTFOLIO_CSV = "data/portfolio.csv"
_COLOR_GOOD = "#34d399"  # keep in sync with report_generator.py
_COLOR_BAD = "#fb7185"   # keep in sync with report_generator.py


def build_portfolio_tab(yahoo_client) -> None:
    """Build the portfolio management tab UI."""
    gr.Markdown("## ポートフォリオ管理")

    manager = PortfolioManager(_PORTFOLIO_CSV)

    with gr.Tabs():
        # ── 1. 売買記録 ──────────────────────────────────────────────────
        with gr.Tab("売買記録"):
            gr.Markdown("### 売買記録")

            def enrich_trade_names(df: pd.DataFrame) -> pd.DataFrame:
                """Add display-only name column for each ticker."""
                if df.empty or "ticker" not in df.columns:
                    return df

                result = df.copy()
                tickers = [
                    str(t).strip().upper()
                    for t in result["ticker"].dropna().tolist()
                    if str(t).strip()
                ]
                if not tickers:
                    result["name"] = "-"
                    return result

                unique_tickers = sorted(set(tickers))
                names: dict[str, str] = {}
                localized_names: dict[str, str] = {}
                try:
                    localized_names = yahoo_client.get_localized_names(
                        unique_tickers, lang="ja-JP", region="JP"
                    )
                except Exception:
                    localized_names = {}
                for ticker in unique_tickers:
                    if ticker in localized_names and localized_names[ticker]:
                        names[ticker] = localized_names[ticker]
                        continue
                    try:
                        info = yahoo_client.get_ticker_info(ticker)
                        names[ticker] = (
                            info.get("longName")
                            or info.get("shortName")
                            or ticker
                        )
                    except Exception:
                        names[ticker] = ticker
                result["name"] = result["ticker"].map(
                    lambda t: names.get(str(t).strip().upper(), str(t))
                )
                return result

            def refresh_trades():
                display_cols = ["ticker", "name", "action", "date", "quantity", "price", "currency", "notes"]
                df = manager.get_trades()
                if df.empty:
                    return pd.DataFrame(columns=display_cols)
                df = enrich_trade_names(df)
                if "quantity" in df.columns:
                    q = pd.to_numeric(df["quantity"], errors="coerce")
                    df["quantity"] = q.map(
                        lambda x: int(x) if pd.notna(x) and float(x).is_integer() else x
                    )
                return df[display_cols]

            def ticker_choices() -> list[str]:
                df = manager.get_trades()
                if df.empty or "ticker" not in df.columns:
                    return []
                return sorted({
                    str(t).strip().upper()
                    for t in df["ticker"].dropna().tolist()
                    if str(t).strip()
                })

            with gr.Row():
                action_dd = gr.Dropdown(
                    choices=["buy", "sell"], value="buy", label="売買区分", scale=1
                )
                ticker_in = gr.Dropdown(
                    choices=ticker_choices(),
                    value=None,
                    allow_custom_value=True,
                    filterable=True,
                    label="ティッカー",
                    info="過去入力済みティッカーを候補表示",
                    scale=2,
                )
                qty_in = gr.Number(label="数量", value=1, minimum=0, precision=0, scale=1)
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

            gr.Markdown(
                "一覧は読み取り専用です。追加・行フォーム編集・削除・一括登録で更新してください。"
            )
            trades_df = gr.DataFrame(
                label="売買記録一覧",
                interactive=False,
                column_count=(8, "fixed"),
                headers=["ticker", "日本語名", "action", "date", "quantity", "price", "currency", "notes"],
                value=refresh_trades(),
            )

            def add_trade(action, ticker, qty, price, currency, notes):
                ticker = (ticker or "").strip()
                if not ticker:
                    return "ティッカーを入力してください。", refresh_trades(), gr.update(choices=ticker_choices())
                qty_num = float(qty)
                if qty_num <= 0:
                    return "数量は 0 より大きい値を入力してください。", refresh_trades(), gr.update(choices=ticker_choices())
                if not qty_num.is_integer():
                    return "数量は整数で入力してください。", refresh_trades(), gr.update(choices=ticker_choices())
                try:
                    qty_int = int(qty_num)
                    manager.add_trade(action, ticker, qty_int, price, currency, notes or "")
                    return (
                        f"{action.upper()} {ticker} × {qty_int} @ {price} {currency} を記録しました。",
                        refresh_trades(),
                        gr.update(choices=ticker_choices(), value=None),
                    )
                except Exception as e:
                    logger.exception("add_trade failed")
                    return f"エラー: {e}", refresh_trades(), gr.update(choices=ticker_choices())

            with gr.Accordion("選択行をフォームで編集", open=False):
                gr.Markdown("行番号を指定して読み込み、フォームで編集してください（通貨/売買区分はプルダウン選択）。")
                with gr.Row():
                    edit_row_index = gr.Number(
                        label="行番号 (0始まり)",
                        value=0,
                        minimum=0,
                        precision=0,
                        scale=1,
                    )
                    load_edit_btn = gr.Button("行を読込", scale=1)
                with gr.Row():
                    edit_action = gr.Dropdown(
                        choices=["buy", "sell"], value="buy", label="売買区分", scale=1
                    )
                    edit_ticker = gr.Dropdown(
                        choices=ticker_choices(),
                        value=None,
                        allow_custom_value=True,
                        filterable=True,
                        label="ティッカー",
                        scale=2,
                    )
                    edit_qty = gr.Number(label="数量", value=1, minimum=0, precision=0, scale=1)
                    edit_price = gr.Number(label="単価", value=0, minimum=0, scale=1)
                    edit_currency = gr.Dropdown(
                        choices=["JPY", "USD", "EUR", "HKD", "SGD"],
                        value="JPY",
                        label="通貨",
                        scale=1,
                    )
                    edit_notes = gr.Textbox(label="メモ (任意)", scale=2)
                with gr.Row():
                    update_row_btn = gr.Button("この行を更新", variant="primary")
                    delete_row_btn = gr.Button("この行を削除", variant="stop")
                edit_status = gr.Markdown("")

            def _coerce_row_index(row_index) -> int:
                try:
                    return int(row_index)
                except Exception as e:
                    raise ValueError("行番号は整数で入力してください。") from e

            def load_trade_for_edit(row_index):
                try:
                    idx = _coerce_row_index(row_index)
                    df = refresh_trades()
                    if df.empty:
                        return (
                            "売買記録がありません。",
                            idx,
                            "buy",
                            1,
                            0,
                            "JPY",
                            "",
                            gr.update(choices=ticker_choices()),
                        )
                    if idx < 0 or idx >= len(df):
                        return (
                            f"行番号 {idx} は範囲外です。0 から {len(df) - 1} を指定してください。",
                            idx,
                            "buy",
                            1,
                            0,
                            "JPY",
                            "",
                            gr.update(choices=ticker_choices()),
                        )
                    row = df.iloc[idx]
                    return (
                        f"行 {idx} を読み込みました。",
                        idx,
                        str(row["action"]).lower(),
                        int(float(row["quantity"])),
                        float(row["price"]),
                        str(row["currency"]).upper(),
                        str(row["notes"]) if pd.notna(row["notes"]) else "",
                        gr.update(choices=ticker_choices(), value=str(row["ticker"]).upper()),
                    )
                except Exception as e:
                    logger.exception("load_trade_for_edit failed")
                    return (
                        f"エラー: {e}",
                        row_index,
                        "buy",
                        1,
                        0,
                        "JPY",
                        "",
                        gr.update(choices=ticker_choices()),
                    )

            def update_trade_row(row_index, action, ticker, qty, price, currency, notes):
                try:
                    idx = _coerce_row_index(row_index)
                    ticker = (ticker or "").strip()
                    if not ticker:
                        return (
                            "ティッカーを入力してください。",
                            refresh_trades(),
                            gr.update(choices=ticker_choices()),
                            gr.update(choices=ticker_choices()),
                        )
                    qty_num = float(qty)
                    if qty_num <= 0:
                        return (
                            "数量は 0 より大きい値を入力してください。",
                            refresh_trades(),
                            gr.update(choices=ticker_choices()),
                            gr.update(choices=ticker_choices()),
                        )
                    if not qty_num.is_integer():
                        return (
                            "数量は整数で入力してください。",
                            refresh_trades(),
                            gr.update(choices=ticker_choices()),
                            gr.update(choices=ticker_choices()),
                        )
                    df = refresh_trades()
                    if idx < 0 or idx >= len(df):
                        return (
                            f"行番号 {idx} は範囲外です。0 から {len(df) - 1} を指定してください。",
                            refresh_trades(),
                            gr.update(choices=ticker_choices()),
                            gr.update(choices=ticker_choices()),
                        )

                    # date は保持し、その他列を更新
                    df.at[idx, "action"] = str(action).lower()
                    df.at[idx, "ticker"] = ticker.upper()
                    df.at[idx, "quantity"] = int(qty_num)
                    df.at[idx, "price"] = float(price)
                    df.at[idx, "currency"] = str(currency).upper()
                    df.at[idx, "notes"] = notes or ""
                    manager.update_trades(df)

                    return (
                        f"行 {idx} を更新しました。",
                        refresh_trades(),
                        gr.update(choices=ticker_choices(), value=ticker.upper()),
                        gr.update(choices=ticker_choices(), value=ticker.upper()),
                    )
                except Exception as e:
                    logger.exception("update_trade_row failed")
                    return (
                        f"エラー: {e}",
                        refresh_trades(),
                        gr.update(choices=ticker_choices()),
                        gr.update(choices=ticker_choices()),
                    )

            def delete_trade_row(row_index):
                try:
                    idx = _coerce_row_index(row_index)
                    manager.delete_trade(idx)
                    return (
                        f"行 {idx} を削除しました。",
                        refresh_trades(),
                        gr.update(choices=ticker_choices(), value=None),
                        gr.update(choices=ticker_choices(), value=None),
                    )
                except Exception as e:
                    logger.exception("delete_trade_row failed")
                    return (
                        f"エラー: {e}",
                        refresh_trades(),
                        gr.update(choices=ticker_choices()),
                        gr.update(choices=ticker_choices()),
                    )

            with gr.Accordion("一括登録 (CSV 形式)", open=False):
                gr.Markdown(
                    "1行1取引で入力してください。`action,ticker,quantity,price,currency,notes` "
                    "または `ticker,quantity,price,currency,notes`（action は上の売買区分を使用）"
                )
                bulk_in = gr.Textbox(
                    lines=6,
                    label="一括入力",
                    placeholder=(
                        "buy,7203.T,100,2750,JPY,NISA\n"
                        "AAPL,10,185,USD,長期\n"
                        "sell,MSFT,5,420,USD,利確"
                    ),
                )
                bulk_btn = gr.Button("一括で記録", variant="secondary")
                bulk_status = gr.Markdown("")

            def add_trades_bulk(text, default_action, default_currency):
                rows = (text or "").splitlines()
                if not rows:
                    return "一括入力が空です。", refresh_trades(), gr.update(choices=ticker_choices())

                success = 0
                errors = []
                for line_no, cols in enumerate(csv.reader(rows), start=1):
                    cols = [c.strip() for c in cols]
                    if not cols or not any(cols):
                        continue
                    try:
                        action = default_action
                        if cols[0].lower() in ("buy", "sell"):
                            action = cols[0].lower()
                            cols = cols[1:]

                        if len(cols) < 3:
                            raise ValueError("列数不足（最低: ticker,quantity,price）")

                        ticker = cols[0].upper()
                        qty_num = float(cols[1])
                        if not qty_num.is_integer():
                            raise ValueError("数量は整数で入力してください")
                        qty = int(qty_num)
                        price = float(cols[2])
                        currency = (
                            cols[3].upper()
                            if len(cols) >= 4 and cols[3]
                            else default_currency.upper()
                        )
                        notes = cols[4] if len(cols) >= 5 else ""

                        if qty <= 0:
                            raise ValueError("数量は 0 より大きい必要があります")

                        manager.add_trade(action, ticker, qty, price, currency, notes)
                        success += 1
                    except Exception as e:
                        errors.append(f"{line_no}行目: {e}")

                if success == 0 and errors:
                    msg = "一括登録に失敗しました。\n" + "\n".join(errors[:5])
                    return msg, refresh_trades(), gr.update(choices=ticker_choices())

                msg = f"{success} 件を一括登録しました。"
                if errors:
                    msg += f"\n{len(errors)} 件は失敗しました。\n" + "\n".join(errors[:3])
                return msg, refresh_trades(), gr.update(choices=ticker_choices(), value=None)

            record_btn.click(
                add_trade,
                inputs=[action_dd, ticker_in, qty_in, price_in, currency_dd, notes_in],
                outputs=[record_status, trades_df, ticker_in],
            )
            load_edit_btn.click(
                load_trade_for_edit,
                inputs=[edit_row_index],
                outputs=[
                    edit_status,
                    edit_row_index,
                    edit_action,
                    edit_qty,
                    edit_price,
                    edit_currency,
                    edit_notes,
                    edit_ticker,
                ],
            )
            update_row_btn.click(
                update_trade_row,
                inputs=[edit_row_index, edit_action, edit_ticker, edit_qty, edit_price, edit_currency, edit_notes],
                outputs=[edit_status, trades_df, ticker_in, edit_ticker],
            )
            delete_row_btn.click(
                delete_trade_row,
                inputs=[edit_row_index],
                outputs=[edit_status, trades_df, ticker_in, edit_ticker],
            )
            bulk_btn.click(
                add_trades_bulk,
                inputs=[bulk_in, action_dd, currency_dd],
                outputs=[bulk_status, trades_df, ticker_in],
            )

        # ── 2. スナップショット ──────────────────────────────────────────
        with gr.Tab("スナップショット"):
            gr.Markdown("### 評価額スナップショット")
            snapshot_btn = gr.Button("更新", variant="primary")
            snapshot_status = gr.Markdown("")
            snapshot_df = gr.DataFrame(label="保有銘柄一覧", interactive=False)

            def run_snapshot():
                def _pnl_color_style(value: float | None) -> str:
                    if value is None or pd.isna(value):
                        return ""
                    if value > 0:
                        return f"color: {_COLOR_GOOD}; font-weight: 600;"
                    if value < 0:
                        return f"color: {_COLOR_BAD}; font-weight: 600;"
                    return ""

                def _style_snapshot(df: pd.DataFrame):
                    if df.empty:
                        return df
                    styled = df.style.apply(
                        lambda row: [
                            _pnl_color_style(row["_gain_raw"]) if c == "損益" else
                            _pnl_color_style(row["_gain_pct_raw"]) if c == "損益率" else
                            ""
                            for c in df.columns
                        ],
                        axis=1,
                    )
                    return styled.hide(axis="columns", subset=["_gain_raw", "_gain_pct_raw"])

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
                        "数量": int(item["quantity"]) if float(item["quantity"]).is_integer() else item["quantity"],
                        "平均取得単価": fmt_price(item["avg_price"], cur),
                        "現在株価": fmt_price(item["current_price"], cur) if item["current_price"] else "-",
                        "評価額": fmt_price(item["market_value"], cur) if item["market_value"] else "-",
                        "損益": fmt_price(item["gain"], cur) if item["gain"] is not None else "-",
                        "損益率": fmt_pct(item["gain_pct"]) if item["gain_pct"] is not None else "-",
                        "_gain_raw": item["gain"],
                        "_gain_pct_raw": item["gain_pct"],
                    })
                snapshot_df_data = pd.DataFrame(rows)
                yield "更新完了", _style_snapshot(snapshot_df_data)

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
