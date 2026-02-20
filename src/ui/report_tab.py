"""Individual stock report tab UI."""
import re

import gradio as gr

from src.core.portfolio_manager import PortfolioManager
from src.core.report_generator import ReportGenerator

# Pattern that a valid ticker symbol matches (e.g. 7203.T, AAPL, 285A.T, BRK.B)
_TICKER_RE = re.compile(r"^[A-Z0-9]{1,7}(\.[A-Z]{1,2})?$")

# 4–5 digit bare number → assume Tokyo Stock Exchange ticker (append .T)
_BARE_JP_NUMBER_RE = re.compile(r"^\d{4,5}$")

# Unicode ranges covering Hiragana, Katakana, and CJK Unified Ideographs
_JAPANESE_RE = re.compile(r"[\u3040-\u9fff]")
_PORTFOLIO_CSV = "data/portfolio.csv"


def _looks_like_ticker(text: str) -> bool:
    """Return True if text appears to be a ticker symbol rather than a company name."""
    return bool(_TICKER_RE.match(text.strip().upper()))


def _normalize_ticker(query: str) -> tuple[str, str]:
    """Normalize a ticker query, returning (ticker, note)."""
    if _BARE_JP_NUMBER_RE.match(query):
        return query + ".T", f"`{query}` → `{query}.T` (東証ティッカーとして補正)"
    return query.upper(), ""


def _has_japanese(text: str) -> bool:
    """Return True if text contains Japanese characters."""
    return bool(_JAPANESE_RE.search(text))


def _llm_translate_to_english(company_name: str, llm_client) -> str:
    """Ask LLM to translate a Japanese company name to English for Yahoo Finance search."""
    prompt = (
        f"以下の企業名を Yahoo Finance で検索できる英語の正式名称に変換してください。"
        f"企業名のみを出力し、説明や句読点は一切出力しないでください。\n企業名: {company_name}"
    )
    raw = llm_client.generate(prompt, temperature=0.0)
    return re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()


# ---------------------------------------------------------------------------
# AI analysis → HTML cards conversion
# ---------------------------------------------------------------------------

def _inline_md(s: str) -> str:
    """Convert inline Markdown (bold/italic/code) to HTML."""
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\*(.+?)\*", r"<em>\1</em>", s)
    s = re.sub(r"`(.+?)`", r"<code>\1</code>", s)
    return s


def _md_to_html(text: str) -> str:
    """Convert simple Markdown to HTML for rendering inside HTML card divs."""
    lines = text.split("\n")
    parts: list[str] = []
    list_items: list[str] = []

    def flush_list() -> None:
        if list_items:
            parts.append(
                '<ul style="margin:4px 0 8px;padding-left:18px;line-height:1.7">'
            )
            for item in list_items:
                parts.append(f"<li>{item}</li>")
            parts.append("</ul>")
            list_items.clear()

    for line in lines:
        s = line.strip()
        if s.startswith("- ") or s.startswith("* "):
            list_items.append(_inline_md(s[2:]))
        elif s.startswith("> "):
            flush_list()
            parts.append(
                f'<blockquote style="margin:4px 8px;padding:2px 8px;'
                f'border-left:3px solid #555;color:#aaa">{_inline_md(s[2:])}</blockquote>'
            )
        elif s == "":
            flush_list()
        else:
            flush_list()
            parts.append(f'<p style="margin:4px 0 6px">{_inline_md(s)}</p>')

    flush_list()
    return "".join(parts)


def _ai_to_cards(raw: str) -> str:
    """Convert LLM analysis text (Markdown with ### sections) to HTML cards.

    Splits on ### headings produced by the structured system prompt.
    Falls back to a single wide card if no headings are found.
    """
    text = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    if not text:
        return ""

    # Split on ### headings
    sections = re.split(r"\n(?=### )", "\n" + text)
    sections = [s.strip() for s in sections if s.strip()]

    cards: list[str] = []
    for section in sections:
        m = re.match(r"### (.+?)\n(.*)", section, re.DOTALL)
        if m:
            title = m.group(1).strip()
            content = _md_to_html(m.group(2).strip())
        else:
            title = "AI アシスタントの分析"
            content = _md_to_html(section)
        cards.append(
            f'<div class="rpt-card rpt-wide">'
            f'<h3 class="rpt-h3">{title}</h3>'
            f"{content}"
            f"</div>"
        )

    if not cards:
        return ""

    note = (
        '<p style="color:#888;font-size:0.82em;margin:0 0 10px">'
        "※ 以下は AI による情報提供です。投資助言ではありません。</p>"
    )
    return note + '<div class="rpt-cards">' + "".join(cards) + "</div>"


# ---------------------------------------------------------------------------
# Tab builder
# ---------------------------------------------------------------------------

def build_report_tab(yahoo_client, llm_client, report_ticker_state: gr.State | None = None) -> None:
    """Build the stock report tab."""
    gr.Markdown("## 銘柄レポート")
    gr.Markdown("ティッカーまたは会社名を入力して個別銘柄の財務分析レポートを生成します。")

    manager = PortfolioManager(_PORTFOLIO_CSV)

    def portfolio_ticker_choices() -> list[tuple[str, str]]:
        positions = manager.get_positions()
        if not positions:
            return []

        choices: list[tuple[str, str]] = []
        tickers = list(positions.keys())
        jp_tickers = [t for t in tickers if t.endswith(".T")]
        localized_names: dict[str, str] = {}
        if jp_tickers:
            try:
                localized_names = yahoo_client.get_localized_names(
                    jp_tickers, lang="ja-JP", region="JP"
                )
            except Exception:
                localized_names = {}

        for ticker in tickers:
            name = ticker
            try:
                info = yahoo_client.get_ticker_info(ticker)
                name = (
                    localized_names.get(ticker)
                    or info.get("longName")
                    or info.get("shortName")
                    or ticker
                )
            except Exception:
                name = ticker
            choices.append((f"{ticker} | {name}", ticker))
        return choices

    with gr.Row():
        with gr.Column(scale=1, min_width=200):
            with gr.Tabs():
                with gr.Tab("手入力"):
                    ticker_input = gr.Textbox(
                        label="ティッカー / 会社名",
                        placeholder="例: 7203.T、AAPL、三菱重工、Toyota",
                    )
                with gr.Tab("保有銘柄"):
                    portfolio_ticker_input = gr.Dropdown(
                        choices=portfolio_ticker_choices(),
                        value=None,
                        label="保有銘柄から選択",
                    )
                    refresh_portfolio_btn = gr.Button("保有銘柄を更新", size="sm")
            run_btn = gr.Button("レポート生成", variant="primary")
        with gr.Column(scale=3):
            pass

    resolved_md = gr.Markdown(visible=False)

    # Main report: header (title + score) + financial cards
    main_output = gr.Markdown(
        "*ティッカーまたは会社名を入力して実行してください。*"
    )

    # AI analysis section: rendered after full response is received
    ai_output = gr.Markdown("")

    generator = ReportGenerator(yahoo_client, llm_client)

    def on_run(query_manual: str, query_portfolio: str):
        query = (query_portfolio or "").strip() or (query_manual or "").strip()
        query = query.strip()
        if not query:
            yield (
                gr.update(visible=False),
                "ティッカーまたは会社名を入力してください（または保有銘柄を選択してください）。",
                "",
            )
            return

        yield gr.update(visible=False), "データを取得中...", ""

        # --- Ticker resolution ---
        if _looks_like_ticker(query):
            ticker, norm_note = _normalize_ticker(query)
            if norm_note:
                resolved_note = gr.update(value=f"**{norm_note}**", visible=True)
                yield resolved_note, "データを取得中...", ""
            else:
                resolved_note = gr.update(visible=False)
        else:
            is_japanese = _has_japanese(query)
            search_query = query
            translation_note = ""

            if is_japanese:
                if llm_client.is_available():
                    yield gr.update(visible=False), f"「{query}」を検索中...", ""
                    english_name = _llm_translate_to_english(query, llm_client)
                    if english_name:
                        search_query = english_name
                        translation_note = f" (英語名: {english_name})"
                else:
                    yield gr.update(visible=False), (
                        f"「{query}」は日本語の会社名のようですが、LLM が未読み込みのため英語変換できません。"
                        "ティッカー記号 (例: 7011.T) を直接入力してください。"
                    ), ""
                    return

            candidates = yahoo_client.search_tickers(
                search_query, max_results=5, prefer_jpx=is_japanese
            )
            if not candidates:
                yield gr.update(visible=False), (
                    f"「{query}」に対応するティッカーが見つかりませんでした。"
                    "ティッカー記号を直接入力してください。"
                ), ""
                return

            ticker = candidates[0]
            info = yahoo_client.get_ticker_info(ticker)
            display_name = info.get("longName") or info.get("shortName") or ticker
            if ticker.endswith(".T"):
                localized = yahoo_client.get_localized_names([ticker], lang="ja-JP", region="JP")
                display_name = localized.get(ticker) or display_name

            note_lines = [
                f"**「{query}」→ `{ticker}` ({display_name}){translation_note} として検索します**"
            ]
            if len(candidates) > 1:
                others = "、".join(f"`{c}`" for c in candidates[1:])
                note_lines.append(f"他の候補: {others}")

            resolved_note = gr.update(value="\n\n".join(note_lines), visible=True)
            yield resolved_note, "データを取得中...", ""

        # Generate static report
        data = generator.generate(ticker, skip_llm=True)
        main_html = generator.format_report_html(data)

        if data.get("error"):
            yield gr.update(visible=False), main_html, ""
            return

        # Show financial cards immediately
        yield resolved_note, main_html, ""

        if not llm_client.is_available():
            return

        llm_input = data.get("llm_stock_input")
        if not llm_input:
            return

        # Show loading state while waiting for full AI response
        yield (
            gr.update(),
            gr.update(),
            '<p style="color:#888;font-style:italic">AI 分析中...</p>',
        )

        try:
            raw = llm_client.analyze_stock(llm_input) or ""
        except Exception:
            raw = ""

        if raw:
            yield gr.update(), gr.update(), _ai_to_cards(raw)

    def refresh_portfolio_choices():
        return gr.update(choices=portfolio_ticker_choices(), value=None)

    refresh_portfolio_btn.click(
        refresh_portfolio_choices,
        outputs=[portfolio_ticker_input],
    )

    run_btn.click(
        on_run,
        inputs=[ticker_input, portfolio_ticker_input],
        outputs=[resolved_md, main_output, ai_output],
    )
    ticker_input.submit(
        on_run,
        inputs=[ticker_input, portfolio_ticker_input],
        outputs=[resolved_md, main_output, ai_output],
    )
    portfolio_ticker_input.change(
        on_run,
        inputs=[ticker_input, portfolio_ticker_input],
        outputs=[resolved_md, main_output, ai_output],
    )

    if report_ticker_state is not None:
        def on_external_ticker(ticker: str):
            t = (ticker or "").strip()
            if not t:
                return gr.update(), gr.update()
            return gr.update(value=t), gr.update(value=None)

        report_ticker_state.change(
            on_external_ticker,
            inputs=[report_ticker_state],
            outputs=[ticker_input, portfolio_ticker_input],
        ).then(
            on_run,
            inputs=[ticker_input, portfolio_ticker_input],
            outputs=[resolved_md, main_output, ai_output],
        )
