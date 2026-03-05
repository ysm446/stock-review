# Stock Review — 設計ドキュメント

## プロジェクト概要

Stock Review は、yfinance ベースの割安株スクリーニング・投資分析システムを **Gradio Web アプリ** として提供するプロジェクトです。
[okikusan-public/stock_skills](https://github.com/okikusan-public/stock_skills) の設計思想とロジックを参考にしています。

---

## アーキテクチャ

### 3層構造

```
┌─────────────────────────────────────────────────────┐
│  UI 層 (Gradio)                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │
│  │Screening │ │ Report   │ │Portfolio │ │ Stress  │ │
│  │   Tab    │ │   Tab    │ │   Tab    │ │Test Tab │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────┘ │
│  ┌──────────────────────────────────────────────────┐│
│  │          Chat Tab (対話的分析アシスタント)          ││
│  └──────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────┤
│  Core 層 (ビジネスロジック)                            │
│  screener.py │ indicators.py │ alpha.py              │
│  technicals.py │ health_check.py │ return_estimate.py│
│  concentration.py │ correlation.py                   │
│  shock_sensitivity.py │ scenario_analysis.py         │
│  recommender.py │ portfolio_manager.py               │
│  report_generator.py                                 │
├─────────────────────────────────────────────────────┤
│  Data 層 (データ取得・キャッシュ・LLM)                   │
│  yahoo_client.py │ cache_manager.py │ llm_client.py  │
└─────────────────────────────────────────────────────┘
```

### ディレクトリ構成

```
stock-review/
├── CLAUDE.md
├── README.md
├── requirements.txt
├── app.py                       # Gradio アプリ エントリーポイント
├── start.bat                    # Windows 起動用バッチ
├── config/
│   ├── presets.yaml             # スクリーニングプリセット定義 (7種)
│   ├── exchanges.yaml           # 取引所・地域定義 (10地域)
│   └── scenarios.yaml           # ストレステストシナリオ定義 (8種)
├── models/                      # GGUF モデル置き場 (gitignore 対象)
│   ├── .gitkeep
│   └── Qwen3-8B-Q4_K_M.gguf   # ← ここに .gguf を置く
├── src/
│   ├── core/                    # ビジネスロジック
│   │   ├── screener.py          # 4スクリーナー (Query/Value/Pullback/Alpha)
│   │   ├── indicators.py        # バリュースコア (100点満点)
│   │   ├── alpha.py             # 変化スコア (100点満点)
│   │   ├── technicals.py        # テクニカル指標・押し目判定
│   │   ├── health_check.py      # ヘルスチェック (3段階アラート)
│   │   ├── return_estimate.py   # 推定利回り (3シナリオ)
│   │   ├── concentration.py     # HHI 集中度分析
│   │   ├── correlation.py       # 相関分析・ファクター分解・VaR
│   │   ├── shock_sensitivity.py # ショック感応度
│   │   ├── scenario_analysis.py # シナリオ分析 (8シナリオ)
│   │   ├── recommender.py       # 推奨アクション生成
│   │   ├── portfolio_manager.py # ポートフォリオ管理 (売買記録・損益)
│   │   └── report_generator.py  # 個別銘柄レポート生成
│   ├── data/
│   │   ├── yahoo_client.py      # yfinance ラッパー (キャッシュ・サニタイズ)
│   │   ├── cache_manager.py     # JSON キャッシュ (24h TTL)
│   │   └── llm_client.py        # llama-cpp-python ラッパー (GGUF ローカル推論)
│   ├── ui/
│   │   ├── screening_tab.py
│   │   ├── report_tab.py
│   │   ├── portfolio_tab.py
│   │   ├── stress_test_tab.py
│   │   ├── chat_tab.py
│   │   ├── model_tab.py         # モデル管理 (GGUF ロード/アンロード)
│   │   └── components.py        # 共通 UI コンポーネント
│   └── utils/
│       ├── formatter.py
│       └── validators.py
└── data/                        # 永続データ (gitignore 対象)
    ├── portfolio.csv
    ├── watchlist.json
    ├── last_model.json           # 最後に使用したモデルパスを保存
    └── cache/
```

---

## 重要な設計判断

### Graceful Degradation

- yfinance API エラー → キャッシュからフォールバック
- アナリストデータ欠損 → 過去リターンベースに切り替え

### ヘルスチェック: 3段階アラート

| レベル | テクニカル条件 | ファンダメンタル条件 |
|--------|-------------|-------------------|
| 早期警告 | SMA50割れ / RSI急落 | — |
| 注意 | SMA50がSMA200に接近 | 変化スコア1指標悪化 |
| 撤退 | デッドクロス | 変化スコア複数悪化 |

撤退シグナルにはテクニカル崩壊とファンダ悪化の **両方** を要求。

### ETF の扱い

- ETF 判定: `quoteType == "ETF"` に加え、売上履歴が空リスト/None の場合も ETF 扱い (`bool()` で truthiness チェック、`is not None` は使わない)
- ETF はテクニカルのみで評価 (ファンダ分析対象外)
- 推定利回り: 過去2年月次リターンの CAGR ベース (単利×12 ではなく複利年率)

### ポートフォリオ永続化

```
data/portfolio.csv:
  date,action,ticker,quantity,price,currency,notes
```

---

## 既知の注意点

### llama-cpp-python の注意点

1. **CUDA 版インストール:** `pip install llama-cpp-python` だけでは CPU 推論になる。GPU 推論には CUDA ビルド済みホイールが必要。
2. **n_gpu_layers=-1:** 全レイヤーを GPU にオフロード。VRAM が足りない場合は正の整数で制限。
3. **モデルロードはブロッキング:** `load_model()` は別スレッドで呼ぶこと (model_tab.py が `threading.Thread` で実行)。
4. **ストリーミング:** `create_chat_completion(stream=True)` の各チャンクは `{"choices": [{"delta": {"content": "..."}}]}` 形式。
5. **GGUF スキャン:** 起動時に `models/*.gguf` を自動スキャンして `SUPPORTED_MODELS` を更新する。

### yfinance のデータの癖

1. **ETF の売上履歴が空リスト:** `is not None` ではなく `bool()` チェックを使う
2. **配当利回りがパーセント値で返る場合がある:** 正規化処理が必要
3. **アナリスト少数時:** 目標株価 High/Mean/Low が同値 → スプレッド自動拡張
4. **ETF リターンの年率換算:** 月次リターン×12 (単利) ではなく CAGR (複利年率) を使う
5. **EquityQuery の地域コード:** yfinance 側の仕様変更に注意

### Yahoo Finance 銘柄検索 API の制約 (重要)

`yf.Search` および `/v1/finance/search` エンドポイントは**日本語テキストを受け付けない** (400 エラー)。

```
yf.Search("三菱重工")   → 結果なし (空)
yf.Search("Mitsubishi Heavy Industries")  → 7011.T を含む結果が返る
```

**対策:** 英語社名またはティッカーを直接入力するよう促す。`prefer_jpx=True` で `.T` ティッカーを優先取得。

---

## yfinance 1.x の注意点 (重要)

yfinance **1.x** は 0.2.x から API が大幅変更。

### Screener API

```python
# NG (0.2.x スタイル — 廃止)
from yfinance import Screener
s = Screener()
s.set_body({...})

# OK (1.x スタイル)
import yfinance as yf
from yfinance import EquityQuery
resp = yf.screen(query, size=100, sortField="intradaymarketcap", sortAsc=False)
quotes = resp.get("quotes", [])
```

### EquityQuery フィールド名

| 条件 | 旧 (0.2.x) | 新 (1.x) |
|------|-----------|---------|
| PER フィルタ | `peratio.lasttwelvemonths` (lt) | `peratio.lasttwelvemonths` (btwn [0, max]) |
| PBR フィルタ | `pricetobook.lasttwelvemonths` | `pricebookratio.quarterly` |
| 配当利回り | `dividendyield.lasttwelvemonths` (単位: 小数) | `forward_dividend_yield` (単位: %) |
| 地域指定 | `set_body` の `region` パラメータ | `EquityQuery('eq', ['region', 'jp'])` をクエリに含める |

> PER は `btwn [0, max]` を使うこと。`lt` だと負の PER (赤字企業) も通ってしまう。

### 有効なフィールド一覧 (EQUITY_SCREENER_FIELDS より)

```
price:        intradaymarketcap, intradayprice, percentchange, ...
valuation:    peratio.lasttwelvemonths, pricebookratio.quarterly, pegratio_5y, ...
profitability: returnonequity.lasttwelvemonths, returnonassets.lasttwelvemonths,
               forward_dividend_yield, consecutive_years_of_dividend_growth_count, ...
income_stmt:  totalrevenues1yrgrowth.lasttwelvemonths, epsgrowth.lasttwelvemonths,
              ebitdamargin.lasttwelvemonths, netincomemargin.lasttwelvemonths, ...
eq_fields:    region, exchange, sector, industry, peer_group  (EQ/IS-IN のみ)
```

### 日本語銘柄名の取得

Yahoo Finance の通常 API は英語名のみ。日本語名は専用エンドポイントで取得:

```python
# src/data/yahoo_client.py の get_localized_names() を使用
# Yahoo Finance v7 API に lang=ja-JP を指定すると longName が日本語で返る
resp = session.get(
    url="https://query2.finance.yahoo.com/v7/finance/quote",
    params={"symbols": "7203.T,9984.T", "lang": "ja-JP", "region": "JP", ...}
)
# result: {"7203.T": "トヨタ自動車", "9984.T": "ソフトバンクグループ"}
```

地域ごとの locale_map (screener.py に実装済み):
- `japan` → `lang=ja-JP, region=JP`
- `china` → `lang=zh-TW, region=HK`
- `korea` → `lang=ko-KR, region=KR`

### Gradio 6.x の変更点

```python
# NG: theme/css は Blocks() に渡せない (Gradio 6 で廃止)
with gr.Blocks(theme=gr.themes.Soft(), css="..."):

# OK: launch() に渡す
app.launch(theme=gr.themes.Soft())
```

### Windows バッチファイルの注意点

- `.bat` ファイルに日本語を含めると文字化けしてコマンドが壊れる → **英語のみで記述**
- `conda activate` はバッチから直接呼べない → **Python のフルパスを直接指定**
- 文字化け防止: `PYTHONIOENCODING=utf-8` を set してから実行

---

## 開発環境

| 項目 | 値 |
|------|-----|
| OS | Windows 11 Pro |
| conda 環境 | `main` |
| Python パス | `D:\miniconda3\conda_envs\main\python.exe` |
| スクリプト実行 | `PYTHONIOENCODING=utf-8 /d/miniconda3/conda_envs/main/python.exe script.py` |
| yfinance | 1.2.0 |
| Gradio | 6.x |
| GPU | RTX PRO 5000 (48GB VRAM) |
| LLM バックエンド | llama-cpp-python (GGUF, CUDA 対応) |

### 起動方法

```bat
:: Windows
start.bat

:: コマンドライン
set PYTHONIOENCODING=utf-8
D:\miniconda3\conda_envs\main\python.exe app.py
```

### llama-cpp-python インストール

```bash
# CUDA 12.4 対応版 (GPU 推論・推奨)
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# CPU のみ
pip install llama-cpp-python
```

### LLM モデルの配置

`models/` フォルダに `.gguf` ファイルを置き、「モデル管理」タブから Load する。

```
models/
└── Qwen3-8B-Q4_K_M.gguf   # 例: 4-bit 量子化 Qwen3-8B
```

`LLMClient` の主要パラメータ:
- `n_gpu_layers=-1`: 全レイヤーを GPU にオフロード (VRAM 48GB ならフル GPU)
- `n_ctx=4096`: コンテキスト長 (トークン数)
- `models_dir`: `.gguf` スキャン対象ディレクトリ (デフォルト: `models/`)

---

## 注意事項

**投資は自己責任です。** 本システムの出力は投資助言ではありません。実際の投資判断は、本システムの出力を参考情報の一つとして、ご自身の判断で行ってください。
