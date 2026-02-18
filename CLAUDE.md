# Stock Advisor — 設計ドキュメント

## プロジェクト概要

Stock Advisor は、yfinance ベースの割安株スクリーニング・投資分析システムを **Gradio Web アプリ** として提供するプロジェクトです。
[okikusan-public/stock_skills](https://github.com/okikusan-public/stock_skills) の設計思想とロジックを参考に、ローカル LLM を活用した対話的な銘柄分析アシスタント機能を追加しています。

### 元プロジェクトとの違い

| 項目 | stock_skills (元) | Stock Advisor (本プロジェクト) |
|------|-------------------|-------------------------------|
| インターフェース | Claude Code Skills (CLI/自然言語) | Gradio Web UI |
| LLM | Claude Code (API) | ローカル LLM (Ollama) |
| LLM の役割 | スキル選択・結果解釈 | レポート自然言語化・対話的分析 |
| データソース | yfinance | yfinance (同じ) |
| 永続化 | CSV/YAML/JSON/CLAUDE.md | CSV/YAML/JSON/SQLite |
| 実行環境 | ローカルターミナル | ブラウザ (localhost) |

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
│  Data 層 (データ取得・キャッシュ・LLM)                 │
│  yahoo_client.py │ llm_client.py │ cache_manager.py  │
└─────────────────────────────────────────────────────┘
```

### ディレクトリ構成

```
stock-advisor/
├── CLAUDE.md                    # 本ファイル (設計ドキュメント)
├── README.md
├── requirements.txt
├── app.py                       # Gradio アプリ エントリーポイント
├── config/
│   ├── presets.yaml             # スクリーニングプリセット定義
│   ├── exchanges.yaml           # 取引所・地域定義
│   └── scenarios.yaml           # ストレステストシナリオ定義
├── src/
│   ├── __init__.py
│   ├── core/                    # ビジネスロジック
│   │   ├── __init__.py
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
│   ├── data/                    # データ取得層
│   │   ├── __init__.py
│   │   ├── yahoo_client.py      # yfinance ラッパー (キャッシュ・サニタイズ)
│   │   ├── llm_client.py        # ローカル LLM クライアント (Ollama)
│   │   └── cache_manager.py     # JSON キャッシュ (24h TTL)
│   ├── ui/                      # Gradio UI 定義
│   │   ├── __init__.py
│   │   ├── screening_tab.py     # スクリーニングタブ
│   │   ├── report_tab.py        # 個別銘柄レポートタブ
│   │   ├── portfolio_tab.py     # ポートフォリオ管理タブ
│   │   ├── stress_test_tab.py   # ストレステストタブ
│   │   ├── chat_tab.py          # 対話的分析アシスタントタブ
│   │   └── components.py        # 共通 UI コンポーネント
│   └── utils/                   # ユーティリティ
│       ├── __init__.py
│       ├── formatter.py         # Markdown / テーブルフォーマッタ
│       └── validators.py        # 入力バリデーション
├── data/                        # 永続データ (gitignore 対象)
│   ├── portfolio.csv            # ポートフォリオ売買記録
│   ├── watchlist.json           # ウォッチリスト
│   └── cache/                   # API レスポンスキャッシュ
├── models/                      # Ollama モデルファイル (gitignore 対象)
│   └── (qwen3:14b 等のモデルデータが保存される)
└── tests/
    ├── __init__.py
    ├── core/                    # Core 層テスト
    ├── data/                    # Data 層テスト
    └── conftest.py              # テスト共通フィクスチャ
```

---

## 機能仕様

### 1. 割安株スクリーニング (`src/core/screener.py`)

4つのスクリーニングエンジンを用途に応じて使い分ける。

| エンジン | アプローチ | 用途 |
|----------|-----------|------|
| QueryScreener | yfinance EquityQuery でバルク取得 → バリュースコアでランキング | 基本的な割安株検索 |
| PullbackScreener | EquityQuery → RSI/ボリンジャーバンドで押し目判定 → バリュースコア | 一時調整エントリー |
| AlphaScreener | EquityQuery(足切り) → 変化スコア → 押し目判定 → 2軸スコア | 業績改善+割安 (4段パイプライン) |
| ValueScreener | 銘柄リスト1件ずつ取得 → フィルタ → スコア | 個別リスト指定 |

#### 7つのプリセット

| プリセット | 説明 | 主な条件 |
|-----------|------|---------|
| value | バリュー (標準) | PER<15, PBR<1.5, 配当>2% |
| high-dividend | 高配当 | 配当利回り重視 |
| growth-value | 成長割安 | PEG<1.5, 売上成長率>10% |
| deep-value | ディープバリュー | PBR<0.8, ネットネット型 |
| quality | クオリティ | ROE>15%, 安定配当 |
| pullback | 押し目買い | 上昇トレンド中の一時調整 |
| alpha | アルファ | 割安+業績改善の兆し |

#### バリュースコア配分 (100点満点)

```
PER:         25点 (低いほど高得点)
PBR:         25点 (低いほど高得点)
配当利回り:    20点 (高いほど高得点)
ROE:         15点 (高いほど高得点)
売上成長率:    15点 (高いほど高得点)
```

#### 変化スコア (Alpha用, 100点満点)

4指標で「業績が良い方向に変化しているか」を定量化:

- アクルーアルズ (利益の質)
- 売上加速度
- FCF マージン変化
- ROE 趨勢

#### 対応地域

yfinance EquityQuery の 60+ 取引所に対応。主要な地域:

- japan: 東証 (プライム・スタンダード・グロース)
- us: NYSE, NASDAQ
- asean: SGX, SET, BURSA, IDX, PSE
- hongkong: HKEX
- europe: LSE, FRA, PAR, AMS
- その他: config/exchanges.yaml で定義

#### Gradio UI 設計

- 地域選択ドロップダウン
- プリセット選択ラジオボタン
- セクターフィルタ (オプション)
- 結果テーブル (ソート可能, スコア・PER・PBR・配当利回り等のカラム)
- 「レポート表示」ボタンで個別銘柄タブへ遷移

### 2. 個別銘柄レポート (`src/core/report_generator.py`)

ティッカー指定で財務分析レポートを生成。

#### レポート内容

- 基本情報: 社名, セクター, 時価総額, 52週レンジ
- バリュエーション: PER, PBR, EV/EBITDA, 配当利回り
- 財務サマリー: 売上高, 営業利益, 純利益 (3期分)
- 収益性: ROE, ROA, 営業利益率, FCFマージン
- アナリストコンセンサス: 目標株価 (High/Mean/Low), レーティング, アナリスト数
- バリュースコア (100点) + 判定
- 最新ニュース (yfinance から取得)

#### ローカル LLM 活用

レポートデータをローカル LLM に渡し、以下を自然言語で生成:

- 投資判断サマリー (3-5行の総合評価)
- リスク要因の解説
- 注目ポイント

### 3. ポートフォリオ管理 (`src/core/portfolio_manager.py`)

#### サブ機能

| 機能 | 説明 |
|------|------|
| 売買記録 | buy/sell の記録 (ティッカー, 数量, 単価, 通貨) |
| スナップショット | 現在の評価額・損益一覧 (多通貨→JPY換算) |
| 構造分析 | HHI集中度, セクター配分, 地域配分 |
| ヘルスチェック | 3段階アラートで投資仮説の有効性を判定 |
| 推定利回り | 楽観/ベース/悲観の3シナリオ |
| リバランス提案 | 集中度に基づく調整提案 |

#### ヘルスチェック: 3段階アラート

| レベル | テクニカル条件 | ファンダメンタル条件 | アクション |
|--------|-------------|-------------------|-----------|
| 早期警告 | SMA50割れ / RSI急落 | — | 注視 |
| 注意 | SMA50がSMA200に接近 | 変化スコア1指標悪化 | 一部利確検討 |
| 撤退 | デッドクロス | 変化スコア複数悪化 | 撤退検討 |

**重要な設計判断:**
- 撤退シグナルにはテクニカル崩壊とファンダ悪化の **両方** を要求
- ETF は資産クラスで自動分類し、テクニカルのみで評価 (ファンダ分析対象外)
- ETF 判定: `quoteType == "ETF"` に加え、売上履歴が空リスト/None の場合も ETF 扱い (`bool()` で truthiness チェック)

#### 推定利回り: 3シナリオ

**個別株:** アナリスト目標株価 (High/Mean/Low) ベース
- アナリスト3名未満の場合、自動スプレッド拡張

**ETF:** 過去2年月次リターンの CAGR ベース
- 標準偏差でシナリオ分岐
- キャップ付きで異常値による過大評価を防止
- 単利(12倍)ではなく CAGR (複利年率) を使用

#### データ永続化

```
data/portfolio.csv:
  date,action,ticker,quantity,price,currency,notes
  2025-01-15,buy,7203.T,100,2850,JPY,決算後の押し目
  2025-02-01,sell,AAPL,5,185.50,USD,利確
```

### 4. ストレステスト (`src/core/scenario_analysis.py` 他)

#### 分析パイプライン

```
集中度分析 (HHI)
  → ショック感応度
    → シナリオ別インパクト推定
      → 相関分析 (ピアソン相関 + マクロ因子分解)
        → VaR (95% / 99%)
          → 因果連鎖分析
            → 推奨アクション
```

#### 8つの事前定義シナリオ

| シナリオ | 内容 |
|---------|------|
| トリプル安 | 株安・円安・債券安の同時発生 |
| テック暴落 | テクノロジーセクター急落 |
| 円高ドル安 | 急激な円高進行 |
| 金利急騰 | 長期金利の急上昇 |
| リセッション | 景気後退シナリオ |
| 地政学リスク | 国際的な政治リスク |
| インフレ加速 | 予想以上のインフレ |
| パンデミック | 感染症パンデミック |

#### ETF の扱い

- 資産クラス自動分類: 金ETF, 長期債ETF, 株式インカムETF 等
- シナリオごとに適切なインパクト係数を適用
- 例: トリプル安で金ETF はヘッジ機能 (逆方向インパクト)

### 5. 対話的分析アシスタント (`src/ui/chat_tab.py`)

ローカル LLM を活用した対話型インターフェース。

#### 機能

- 自然言語での銘柄質問 (例: 「トヨタの最近の業績はどう？」)
- スクリーニング結果の深掘り (例: 「この銘柄がランクインした理由は？」)
- ポートフォリオ相談 (例: 「今のポートフォリオのリスクは？」)
- 比較分析 (例: 「トヨタとホンダを比較して」)

#### 実装方針

- ユーザーの質問を受け取り、必要なデータを yfinance から取得
- 取得データ + 質問をローカル LLM に渡して回答を生成
- チャット履歴を保持し、文脈を維持
- 定量データ (計算結果) と定性分析 (LLM の解釈) を分離

---

## Data 層 仕様

### yahoo_client.py — yfinance ラッパー

外部 API を直接呼ばず、必ずこのラッパー経由にする。

#### 責務

- **キャッシュ:** JSON 形式, 24時間 TTL (`data/cache/`)
- **レート制限:** API 呼び出し間に 1秒ディレイ
- **異常値サニタイズ:**
  - 配当利回り > 15% → 除外
  - PBR < 0.1 → 除外
  - 配当利回りがパーセント値で返る場合の正規化
- **ETF 判定:** `quoteType`, 売上履歴の truthiness チェック
- **エラーハンドリング:** ティッカー取得失敗時のグレースフルフォールバック

#### 主要メソッド

```python
class YahooClient:
    def get_ticker_info(self, ticker: str) -> dict
    def get_financials(self, ticker: str) -> dict
    def get_history(self, ticker: str, period: str = "2y") -> pd.DataFrame
    def get_analyst_data(self, ticker: str) -> dict
    def get_news(self, ticker: str) -> list[dict]
    def screen_equities(self, region: str, filters: dict) -> list[dict]
    def search_tickers(self, query: str, max_results: int = 3, prefer_jpx: bool = False) -> list[str]
    def get_localized_names(self, tickers: list[str], lang: str = "ja-JP", region: str = "JP") -> dict[str, str]
    def is_etf(self, ticker: str) -> bool
```

### llm_client.py — ローカル LLM クライアント

#### Ollama 連携

```python
class LLMClient:
    def __init__(self, model: str = "qwen3:8b", base_url: str = "http://localhost:11434"):
        ...

    def generate(self, prompt: str, system: str = None, temperature: float = 0.3) -> str:
        """単発テキスト生成"""

    def chat(self, messages: list[dict], system: str = None, temperature: float = 0.3) -> str:
        """チャット形式 (対話履歴あり)"""

    def analyze_stock(self, stock_data: dict) -> str:
        """銘柄データを受け取り自然言語レポートを生成"""

    def summarize_portfolio(self, portfolio_data: dict) -> str:
        """ポートフォリオ全体の評価サマリーを生成"""
```

#### 推奨モデル

RTX PRO 5000 (48GB VRAM) 環境:

| モデル | サイズ | 用途 | 備考 |
|--------|------|------|------|
| qwen3:8b | ~6GB | 日本語レポート生成・対話 | **現在使用中** |
| qwen3:14b | ~10GB | より高品質な分析 | VRAM に余裕があれば |
| qwen3:32b | ~22GB | 最高品質 | さらに余裕があれば |
| gemma3:27b | ~18GB | 代替選択肢 | 多言語対応 |

> **重要:** `app.py` の `LLMClient(model="qwen3:8b")` をインストール済みモデル名と一致させること。
> モデル名不一致は「LLM からの応答が取得できませんでした」エラーの原因になる。
> インストール済みモデルは `ollama list` で確認できる。

#### Graceful Degradation

- Ollama が起動していない場合、LLM 機能をスキップ
- データ分析・スコアリング等の定量部分は LLM 無しで完全動作
- UI 上で「LLM 未接続」を表示し、接続方法を案内

### cache_manager.py — キャッシュ管理

```python
class CacheManager:
    def __init__(self, cache_dir: str = "data/cache", ttl_hours: int = 24):
        ...

    def get(self, key: str) -> Optional[dict]
    def set(self, key: str, data: dict) -> None
    def invalidate(self, key: str) -> None
    def cleanup_expired(self) -> int  # 期限切れ削除, 削除数を返す
```

---

## UI 層 (Gradio) 設計

### タブ構成

```python
import gradio as gr

with gr.Blocks(title="Stock Advisor", theme=gr.themes.Soft()) as app:
    gr.Markdown("# 📊 Stock Advisor")

    with gr.Tabs():
        with gr.Tab("🔍 スクリーニング"):
            # screening_tab.py
        with gr.Tab("📋 銘柄レポート"):
            # report_tab.py
        with gr.Tab("💼 ポートフォリオ"):
            # portfolio_tab.py
        with gr.Tab("⚡ ストレステスト"):
            # stress_test_tab.py
        with gr.Tab("💬 AI アシスタント"):
            # chat_tab.py
```

### 各タブの UI 概要

#### スクリーニングタブ

```
┌─ 設定パネル (左) ─────────┐  ┌─ 結果パネル (右) ─────────────┐
│ 地域: [Japan ▼]            │  │ ┌──────────────────────────┐  │
│ プリセット: ○value ○high-  │  │ │  結果テーブル              │  │
│   dividend ○growth-value   │  │ │  (スコア, PER, PBR, ...)  │  │
│ セクター: [全セクター ▼]    │  │ │                           │  │
│ [🔍 スクリーニング実行]     │  │ └──────────────────────────┘  │
│                            │  │ [📋 選択銘柄のレポート表示]    │
└────────────────────────────┘  └──────────────────────────────┘
```

#### ポートフォリオタブ

```
┌─ 操作パネル ──────────────────────────────────────────────────┐
│ [売買記録] [スナップショット] [構造分析] [ヘルスチェック] [利回り] │
├──────────────────────────────────────────────────────────────┤
│                    メインコンテンツエリア                       │
│  (選択した操作に応じて動的に表示)                               │
└──────────────────────────────────────────────────────────────┘
```

#### ストレステストタブ

```
┌─ 入力 ──────────────────────┐
│ ティッカー: [7203.T,AAPL]   │
│ シナリオ: [トリプル安 ▼]     │
│ [⚡ テスト実行]              │
├─ 結果 ──────────────────────┤
│ 集中度 (HHI): 0.35          │
│ VaR (95%): -12.5%           │
│ シナリオインパクト: ...      │
│ 推奨アクション: ...          │
└─────────────────────────────┘
```

---

## 設定ファイル仕様

### config/presets.yaml

```yaml
value:
  description: "バリュー (標準)"
  filters:
    per_max: 15
    pbr_max: 1.5
    dividend_yield_min: 2.0
    market_cap_min: 10000000000  # 100億円
  score_weights:
    per: 25
    pbr: 25
    dividend_yield: 20
    roe: 15
    revenue_growth: 15

high-dividend:
  description: "高配当"
  filters:
    dividend_yield_min: 3.5
    per_max: 20
    payout_ratio_max: 80
  score_weights:
    dividend_yield: 40
    per: 20
    pbr: 15
    roe: 15
    revenue_growth: 10

# ... 他のプリセット
```

### config/exchanges.yaml

```yaml
japan:
  name: "日本"
  exchanges: ["JPX"]
  currency: "JPY"
  equity_query_region: "jp"

us:
  name: "米国"
  exchanges: ["NYSE", "NASDAQ"]
  currency: "USD"
  equity_query_region: "us"

asean:
  name: "ASEAN"
  exchanges: ["SGX", "SET", "BURSA"]
  currency: null  # 複数通貨
  equity_query_region: ["sg", "th", "my"]

# ... 他の地域
```

### config/scenarios.yaml

```yaml
triple_decline:
  name: "トリプル安"
  description: "株安・円安・債券安の同時発生"
  shocks:
    equity: -0.20
    bond: -0.10
    fx_jpy: -0.15
  etf_overrides:
    gold: 0.10      # 金はヘッジ
    long_bond: -0.15

tech_crash:
  name: "テック暴落"
  description: "テクノロジーセクター急落"
  shocks:
    technology: -0.35
    other_equity: -0.10
  sector_multipliers:
    Technology: 2.0
    Communication Services: 1.5

# ... 他のシナリオ
```

---

## ローカル LLM 統合方針

### 設計原則: 定量と定性の分離

```
定量分析 (Python)          定性分析 (ローカル LLM)
├─ バリュースコア計算       ├─ 投資判断サマリー生成
├─ 変化スコア計算          ├─ リスク要因の自然言語解説
├─ VaR 計算               ├─ 推奨アクションの補足説明
├─ HHI 集中度             ├─ 対話的質問への回答
├─ 相関分析               └─ 銘柄比較の定性評価
└─ シナリオインパクト
```

**原則:** 計算結果は Python で確定させ、LLM は解釈・説明のみを担当。LLM が計算結果を覆すことはない。

### プロンプト設計

#### 銘柄レポート用システムプロンプト例

```
あなたは株式投資のアナリストです。
提供された財務データに基づいて、投資判断に役立つサマリーを日本語で作成してください。

ルール:
- 提供されたデータのみに基づいて分析すること
- 投資助言ではなく、情報提供であることを明示すること
- ポジティブ/ネガティブ両面をバランスよく記述すること
- 専門用語を使う場合は簡潔な説明を添えること
```

### Ollama セットアップ手順

```bash
# Ollama インストール (未インストールの場合)
curl -fsSL https://ollama.com/install.sh | sh

# モデル保存先をプロジェクト内の models/ フォルダに設定
export OLLAMA_MODELS=/path/to/stock-advisor/models
# Windows の場合:
# $env:OLLAMA_MODELS = "D:\GitHub\stock-advisor\models"

# 推奨モデルのダウンロード (models/ フォルダに保存される)
ollama pull qwen3:8b   # 現在使用中
# ollama pull qwen3:14b  # より高品質

# サーバー起動 (デフォルト: http://localhost:11434)
OLLAMA_MODELS=/path/to/stock-advisor/models ollama serve
# Windows の場合:
# $env:OLLAMA_MODELS = "D:\GitHub\stock-advisor\models"; ollama serve
```

> **注意:** `models/` フォルダはモデルサイズが大きいため (10〜48GB)、`.gitignore` に追加し git 管理外にすること。

---

## 依存ライブラリ

### requirements.txt

```
# Data
yfinance>=0.2.40
numpy>=1.24.0
pandas>=2.0.0

# UI
gradio>=5.0.0

# Config
pyyaml>=6.0

# LLM
requests>=2.31.0   # Ollama API 呼び出し用

# Testing
pytest>=7.0.0
pytest-mock>=3.10.0
```

### オプション依存

```
# 高度なチャート (将来拡張)
plotly>=5.0.0
matplotlib>=3.7.0
```

---

## 開発ガイドライン

### コーディング規約

- Python 3.10+
- 型ヒント必須 (関数シグネチャ)
- docstring: Google スタイル
- フォーマッタ: ruff
- テスト: pytest, 外部 API はモック

### テスト方針

- Core 層: 全関数に対するユニットテスト (モック使用)
- Data 層: モックベース (実際の API は叩かない)
- UI 層: 手動テスト中心 (Gradio のテストは限定的)
- 目標: 修正のたびに全テスト実行 (20秒以内)

### 実装順序 (推奨)

```
Phase 1: 基盤 + スクリーニング
  1. プロジェクト構造・設定ファイル作成
  2. yahoo_client.py (データ取得・キャッシュ)
  3. indicators.py (バリュースコア)
  4. screener.py (QueryScreener のみ)
  5. screening_tab.py (Gradio UI)
  → ここで動作確認

Phase 2: レポート + LLM
  6. report_generator.py
  7. llm_client.py (Ollama 連携)
  8. report_tab.py
  → LLM 統合テスト

Phase 3: ポートフォリオ
  9. portfolio_manager.py
  10. health_check.py
  11. return_estimate.py
  12. portfolio_tab.py

Phase 4: ストレステスト
  13. concentration.py, correlation.py
  14. shock_sensitivity.py, scenario_analysis.py
  15. recommender.py
  16. stress_test_tab.py

Phase 5: 対話アシスタント
  17. chat_tab.py (チャット UI + LLM 統合)
  18. 全機能との連携

Phase 6: テスト・リファクタ
  19. テスト拡充
  20. パフォーマンス最適化
  21. UI ブラッシュアップ
```

---

## 既知の注意点 (元プロジェクトからの知見)

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

**対策 (report_tab.py / chat_tab.py に実装済み):**
1. 入力に日本語文字が含まれる場合、LLM に英語社名へ翻訳させる
2. 英語社名で検索し、`prefer_jpx=True` で `.T` ティッカーを優先取得
3. LLM 未接続時はティッカー直接入力を促すメッセージを表示

```python
# LLM による日本語→英語変換 (report_tab.py)
english_name = _llm_translate_to_english("三菱重工", llm_client)
# → "Mitsubishi Heavy Industries"
candidates = yahoo_client.search_tickers(english_name, prefer_jpx=True)
# → ["7011.T", ...]
```

### Graceful Degradation パターン

- Ollama 未起動 → LLM 機能スキップ、データ分析のみで動作
- yfinance API エラー → キャッシュからフォールバック
- アナリストデータ欠損 → 過去リターンベースに切り替え
- LLM モデル名不一致 → `chat()` / `generate()` が空文字を返す → `ollama list` でモデル名確認

---

## 実装済み状況 (Phase 1〜5 完了 / Phase 6 残)

### 完了ファイル

```
app.py                          # Gradio エントリーポイント (LLMClient model="qwen3:8b")
start.bat                       # Windows 起動用バッチ (Python フルパス指定)
config/presets.yaml             # 7 プリセット定義
config/exchanges.yaml           # 10 地域定義
config/scenarios.yaml           # 8 シナリオ定義

# Data 層
src/data/cache_manager.py       # JSON キャッシュ (24h TTL)
src/data/yahoo_client.py        # yfinance 1.x ラッパー + search_tickers (prefer_jpx対応)
src/data/llm_client.py          # Ollama クライアント (model="qwen3:8b")

# Core 層
src/core/indicators.py          # バリュースコア計算
src/core/screener.py            # QueryScreener / ValueScreener / PullbackScreener / AlphaScreener
src/core/alpha.py               # 変化スコア計算
src/core/technicals.py          # テクニカル指標・押し目判定
src/core/health_check.py        # ヘルスチェック (3段階アラート)
src/core/return_estimate.py     # 推定利回り (3シナリオ)
src/core/concentration.py       # HHI 集中度分析
src/core/correlation.py         # 相関分析・ファクター分解・VaR
src/core/shock_sensitivity.py   # ショック感応度
src/core/scenario_analysis.py   # シナリオ分析 (8シナリオ)
src/core/recommender.py         # 推奨アクション生成
src/core/portfolio_manager.py   # ポートフォリオ管理 (売買記録・損益)
src/core/report_generator.py    # 個別銘柄レポート生成 (LLM分析付き)

# UI 層
src/ui/components.py            # 共通 UI
src/ui/screening_tab.py         # スクリーニングタブ
src/ui/report_tab.py            # 銘柄レポートタブ (会社名→ティッカー解決・LLM翻訳対応)
src/ui/portfolio_tab.py         # ポートフォリオ管理タブ
src/ui/stress_test_tab.py       # ストレステストタブ
src/ui/chat_tab.py              # AI アシスタントタブ (LLM統合・会社名検索フォールバック)

# Utils
src/utils/formatter.py          # フォーマッタ
src/utils/validators.py         # バリデータ
tests/conftest.py               # pytest フィクスチャ
```

### 残作業 (Phase 6)

- テスト拡充 (Core 層ユニットテスト)
- パフォーマンス最適化
- UI ブラッシュアップ

### 起動方法

```bat
:: Windows
start.bat

:: コマンドライン
set PYTHONIOENCODING=utf-8
D:\miniconda3\conda_envs\main\python.exe app.py
```

---

## 開発環境 (実機情報)

| 項目 | 値 |
|------|-----|
| OS | Windows 11 Pro |
| conda 環境 | `main` |
| Python パス | `D:\miniconda3\conda_envs\main\python.exe` |
| スクリプト実行 | `PYTHONIOENCODING=utf-8 /d/miniconda3/conda_envs/main/python.exe script.py` |
| yfinance | 1.2.0 |
| Gradio | 6.x |
| GPU | RTX PRO 5000 (48GB VRAM) |

---

## 既知の注意点 — yfinance 1.x への移行 (重要)

yfinance **1.x** は 0.2.x から API が大幅変更。以下を必ず守ること。

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
| 時価総額 | `intradaymarketcap` | `intradaymarketcap` (変更なし) |

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

## 注意事項

**投資は自己責任です。** 本システムの出力は投資助言ではありません。実際の投資判断は、本システムの出力を参考情報の一つとして、ご自身の判断で行ってください。
