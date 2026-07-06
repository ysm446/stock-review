# Progress

最終更新: 2026-07-07

## 完了済み

- **2026-07-07: 配色テーマ（デザインテンプレート）機能の第1弾**。
  - `styles.css` の色をCSS変数に集約（`--control-bg/-hover/-active/-border`、`--pos/-soft`・`--neg/-soft`・`--link`・`--warn`、`--text-strong/-soft`、`--topbar-bg`・`--menu-bg`・`--tooltip-bg`・`--modal-bg/-border`・`--overlay`・`--scrollbar-thumb` 等）。`:root` = ダーク（デフォルト）、`:root[data-theme="navy"]` = ネイビーを定義。
  - `src/theme.js`（**非モジュール** script。CSP `script-src 'self'` のためインライン不可）を `<head>` でスタイルシートより前に読み込み、body描画前に `data-theme` を確定してFOUCを防止。API は `window.StockReviewTheme`（get/set、localStorage `stock-review.theme` に保存、`stock-review:theme` イベント発火）。
  - 設定 > 表示にテーマピッカー（ミニプレビュー付きスウォッチ）を追加。`renderer-settings.js` で選択・アクティブ表示を制御。
  - 検証: 実 `styles.css`/`theme.js` を読み込む Electron ハーネスで dark/navy 両方をスクリーンショットし、ネイビーが添付画像の色調（濃紺背景・青みパネル・ティール系プラス・コーラル系マイナス）になることを目視確認（scratchpad）。
  - **残課題**: canvas チャート（`renderer.js` のトレンド緑 `#4ade80` / テキスト `#9ca3af` / グリッド、保有割合HSLパレット）はハードコードのままでテーマ非追従。テーマ変更時の再描画と `getComputedStyle` での色取得が今後の対応。

- **2026-07-06: レビューページのデザイン統一 + チャット Markdown テーブル対応 + 起動時のポート 8001 掃除**。
  - レビュービュー内の全パネル（データ・チャット）で見出し 0.92rem / 余白 14-16px / 背景 var(--panel) / 角丸 10px に統一。指標はラベル muted / 値 text + tabular-nums。銘柄チャットの本文 0.92rem、見出しは h1 1.08rem スケール。
  - chat-markdown.js に pipe テーブル描画を追加（ヘッダー行 + 区切り行の解釈、セルはエスケープ済み）。単体テストあり（scratchpad）。
  - main.js killStaleChatServer: 起動時に netstat で :8001 の LISTEN プロセスを taskkill（孤児サーバーの古いトークンによる 401 を実際に検出したため。レビュー指摘の残課題を解消）。
  - AUTOSHOT がレビュー画面で先頭チップをクリックし、データ入りで撮影するように拡張。

- **2026-07-05: フェーズ5のフィードバック反映を完了**（現金カードの直接編集化・現金入力欄の廃止、保有割合ヘッダーの1行化とドーナツ見切れ修正（半径を `height/2 - 34` 基準に）、財務サマリーの幅正常化、銘柄チャットの新規会話を＋アイコン化）。デバッグ知見: `.panel-actions` 内の select が flex で伸長しボタンを押し出していたため、保有割合ヘッダーは grid + `display: contents` で構成。
- **2026-07-05: フェーズ5（ダッシュボード UI 整理）を完了**。
  - ポートフォリオ: `#view-portfolio.is-visible` を高さ固定 flex 化し、`.dashboard-charts`（トレンド 1.5fr / 保有割合 1fr / 銘柄別損益 0.9fr、高さ330px）+ `.dashboard-tables`（保有 1.75fr / ウォッチ 1fr、内部スクロール）に再構成。チャートは CSS サイズ追従（`prepareHiDPICanvas`）。1500px 未満はページスクロールへフォールバック。
  - レビュー: 最新ニュースパネルを削除（`renderReviewNews` / `reviewNewsList` / 関連 CSS も削除）。`.review-main-grid` で左=指標グリッド（内部スクロール）/ 右=銘柄チャット全高の2カラム。
  - 銘柄チャット: 会話削除ボタン（確認付き、`DELETE /sessions/{id}`）、Markdown 描画（`src/chat-markdown.js` に共通化、renderer-chat からも移行）。
  - `activateView("portfolio")` でチャート再描画（非表示中描画のサイズ潰れ対策）。
  - 検証: `STOCK_REVIEW_AUTOSHOT=1` での実起動スクリーンショット（portfolio / review）で 1920x1080 に収まることを目視確認。**注意: この環境から Electron を起動するときは `env -u ELECTRON_RUN_AS_NODE` が必要**。
- **2026-07-05: フェーズ4第2弾（役割ベースモデル管理）を完了**。
  - `chat_llama_manager.py` を役割ベースに全面書き換え: standard（:8091、常駐・要約用・フォールバック）/ deep（:8092、チャット優先・手動ロード/アンロード）。設定と PID は `llama_paths.json` の `roles` キーに保存。旧 :8080 構成からの自動移行あり。
  - **重要**: news-picker が同一マシンで 8081/8082 を使用しているため 8091/8092 を採用（検証中に実際に衝突を検出。ポート割り当てはメモリ `port-allocation-same-machine` 参照）。
  - API: `GET /llama/roles` / `POST /llama/{role}/start|stop` / `PUT /llama/{role}/settings`。旧 `/model/*` は廃止。
  - `/chat/agent-stream` は deep→standard フォールバックで model イベントを先頭に送出。`/chat/stream`（要約用）は standard 優先 + `enable_thinking:false`（実測 0.5 秒で応答）。
  - バックエンド起動時に standard を自動起動（`ensure_standard`、バックグラウンド実行）。Electron 終了時は roles 配下の全 PID を停止。
  - フロント: モデルモーダルを役割カード UI に刷新（モデル/ctx 選択 + 起動/停止）。ステータスバーは「深堀り: モデル名」形式、10秒間隔で自動更新。回答メタに実際に使われたモデル名を表示。
  - E2E 検証済み: 設定保存 → 再起動 → standard 自動起動 → deep 停止時のフォールバックでエージェント動作（model イベント + news_search + 出典付き回答）、要約 0.5 秒。
- **2026-07-05: フェーズ4第1弾（エージェンティックチャット + Web検索、Ornith 対応）を完了**。
  - 新規モジュール: `backend/search_web.py`（ddgs）、`backend/llm_client.py`（OpenAI 互換ストリーム、reasoning_content 分離、ツールコール断片の index 連結復元）、`backend/chat_agent.py`（MAX_TOOL_STEPS=8 のツールループ）。
  - `POST /chat/agent-stream` 追加。system メッセージは1つに結合（Qwen3 系は複数 system で 400）。既存 `/chat/stream` は要約用にそのまま残置。
  - llama-server 起動に `--jinja --alias` を追加（Ornith のツールコール・思考分離に必須）。
  - フロント: `chat-api.js` に `createActivityRenderer` を追加し、renderer-chat / renderer-stock-chat 両方の送信を agent-stream 化（活動ログ + 折りたたみ思考 + turn_reset 対応）。
  - E2E 検証済み: Ornith 9B 実ロード → 日本語ニュース質問 → news_search×2 + web_search×1 が自動実行され、thinking 4回・token 59・done まで全イベント正常。FTS `ORDER BY rank` / `/documents/search` ルート順も修正・確認済み。
  - Ornith-1.0 9B（5.2GB）/ 35B（19.7GB）Q4_K_M は `models/` に配置済み。
- **2026-07-05: プロジェクト全体レビューを実施し、フェーズ1（正確性・データ損失）とフェーズ2（セキュリティ）+ F12 スクリーンショットを完了**（詳細は `docs/changelog.md` 2026-07-05 参照）。
  - `holdings` をロット単位スキーマへ移行（`id INTEGER PRIMARY KEY AUTOINCREMENT`、既存 DB は起動時自動移行）。save は全量置き換え（DELETE→INSERT）。配当集計もロット合算に修正。
  - 通貨換算を `shared.py` に一本化（`portfolio_store.py` の重複 `get_latest_quote`/`convert_price_to_jpy` を削除）。GBp 等の補助単位は `normalize_price_currency` で正規化。通貨欠損時は推測せずエラー。FX 欠損日は直近過去レートで補完（`_fx_rate_for_date`、bisect）。
  - `app.db` を WAL + busy_timeout=10000 に。JSON/notes の書き込みはアトミック化（`shared.atomic_write_text` / data-files.js の tmp+rename+.bak）。
  - トレンドチャートの合成データ生成（buildTrendSeries のサイン波フォールバック）を削除し空状態表示に。
  - チャットサーバーにトークン認証（`STOCK_REVIEW_API_TOKEN` 環境変数、Electron main が生成し IPC `chat:api-token` で renderer に渡す）。renderer の :8001 アクセスは `src/chat-api.js` の `apiFetch` に統一。CORS は `allow_origins=["null"]`。
  - XSS エスケープ（`escapeHtml` を renderer-utils に追加）、`setWindowOpenHandler`/`will-navigate` ガード、Electron 43 へ更新。
  - F12 スクリーンショット（`before-input-event` → `capturePage` → `data/screenshots/`）、ウィンドウを `useContentSize: true` の 1920x1080 に。

- 評価額推移チャートの「期間」「軸」プルダウンの選択を localStorage で永続化（`trendRange` / `trendYAxisMode`）。再起動後も前回の選択を維持。
- 現金残高がアプリ再起動後に 0 に戻る不具合を修正。`portfolio.json` には `cash` キーで保存されるが、フロントの読み込み（`applyPortfolioState`）が `cashJpy` のみを参照していたため。`cashJpy ?? cash` の両対応にした。あわせて、同一銘柄の複数ロット保有環境でレガシー JSON → DB 初回移行が重複ティッカーで落ちる不具合も upsert 化で修正。
- 現金残高（買付余力）の入力に対応。ポートフォリオ画面に現金入力欄を新設し、`app_settings`（key-value）テーブルへ円建てで永続化（`portfolio_store.py` の load/save に連携、`load_state` が `cashJpy` を返す）。サマリーに「保有資産評価（株式＋現金）」「株式評価額」「現金（資産比率）」のカードを併記し、保有割合チャートに現金スライスを追加。第1段階として円のみ・トレンドチャートは株式のみ（現金は未反映）。

- ポートフォリオの保有・評価額・損益・保有割合チャートの基本機能。
- `yfinance` による価格一括更新と外貨建ての円換算。
- 個別銘柄レビュー / ウォッチリスト / 企業指標ビュー。
- 資産推移トレンドチャート（注釈機能付き）。
- ポートフォリオ全体・個別銘柄向けの LLM チャット。
- Python ランタイムを conda から `.venv` へ移行。
- 同一銘柄のまとめ表示（保有テーブル・配分チャートのトグル）。
- 「保有銘柄数」をユニーク銘柄数でカウントするよう修正（重複保有を1銘柄として数える）。
- 保有割合チャートの配色プルダウンを追加し、「セクター別」配色（業種ごとにキーカラー＋同一セクター内グラデーション）を実装。
- 保有割合チャートのラベル見切れを修正（テキスト幅を測りキャンバス内にクランプ）。
- 保有割合チャートのキャンバス幅とドーナツ半径をレスポンシブ化し、広い画面でグラフ本体が小さく見える問題を修正。
- 左ナビ最下部に設定アイコンを追加し、設定ウィンドウ（タブ構成）を新設。第1タブで llama-cpp（llama-server）の最新バージョン確認と Windows ビルド（CPU/CUDA/Vulkan を毎回選択）のダウンロード・展開に対応。バイナリ保存先を `bin/llama-server/` から `runtime/llama-server/` へ移行（旧 `bin/` も後方互換で参照）。
- 設定ウィンドウに「埋め込み」タブを追加。埋め込みモデル（ruri-v3-310m）の状態表示（sentence-transformers / sqlite-vec の有無、取得済み/未取得）と手動ダウンロード（HuggingFace 経由、進捗バー付き）に対応。`backend/embed_manager.py` 新設。
- 埋め込み依存（sentence-transformers / sqlite-vec、PyTorch を含む大容量）が未導入のとき、設定画面のボタンが「依存をインストール」に変化。押すと `.venv` へ pip 導入（出力をストリーム表示）→ 続けてモデル取得まで自動実行。`POST /embedding/install-deps` 追加。`importlib.invalidate_caches()` で再起動なしに新規パッケージを認識。
- 設定ウィンドウに「表示」タブを追加し、「リソースモニターを表示」チェックボックスを新設（lm-chat を参考）。ON のとき上部バー（株ステータスバー）に CPU / RAM / GPU / VRAM の使用量を1秒間隔のバーで表示。`GET /system/resources`（psutil + nvidia-ml-py、無ければ available:false / GPU 無しは gpus:[] でグレースフル）と `src/renderer-resources.js` を追加。設定は localStorage 永続化。
- リソースモニターの依存（psutil / nvidia-ml-py）が未導入のとき、ON にすると `POST /system/install-deps` で `.venv` へ自動インストールしてから表示開始（埋め込みと同様の自動導入）。`system_resources` は遅延 import 化し、インストール後に再起動なしで認識。requirements.txt に psutil / nvidia-ml-py を追加。
- チャットの入力欄が見切れる問題を修正。アプリ全体を `app-shell` でビューポート高に固定（`height:100vh; overflow:hidden`）し、`main-panel` を内部スクロール化。チャットビューは `height:100%` で main-panel いっぱいに収め、会話（メッセージ）と会話ツリーだけが内部スクロール、入力欄は常に表示。スクロールバーは外枠ではなく会話部分に付く。狭い画面（760px）はページスクロールに戻す。
- 後続CSSの `#view-chat.is-visible` が `height: calc(100vh - 40px)` で上書きしていたため、`height:100%` / `min-height:0` に揃えて入力欄が画面内に収まるよう再修正。
- `CLAUDE.md` を参考に `AGENTS.md` を追加し、作業前確認・変更後ドキュメント更新・リポジトリ固有の進め方を明記。
- 保有テーブル / 保有割合チャートのまとめ表示と、保有割合チャートの配色モード（デフォルト / セクター別）を localStorage で永続化。

## 未完了 / 検討中

- **フェーズ4残課題**: チャット2系統（renderer-chat / renderer-stock-chat）の完全共通化（Markdown は共通化済み）、エージェントの出典リンクのクリック対応確認、要約への json_schema 構造化出力の導入検討。
- **UI 微調整候補**: 保有割合ドーナツの小さいスライスのラベル重なり、レビュー左カラムのパネル密度調整、銘柄チャットの会話リネーム。renderer.js（約2,900行）のモジュール分割。
- 外貨建て銘柄の買値の通貨対応（現状は「円で入力」ルール。買値通貨を保持して換算するのが本修正）。
- 株数・買値の小数対応（`parse_number`/`parseWholeNumber` が整数に丸めるため、米国株の端株・小数の平均取得単価が失われる）。
- レビューで指摘された残課題: 削除操作（全体チャットのワークスペース等）の確認ダイアログ、styles.css の重複セレクタ整理。
- グラフ配色パターンの追加（損益ヒートマップ / 単色グラデーション / パステル など）。
- セクター別の集計・内訳表示。
- 現金の拡張（外貨建て現金の円換算対応、資産推移トレンドへの現金反映、LLM チャットへの現金・総資産の引き渡し）。

## 注意点

- `holdings` テーブルはロット単位（2026-07-05 移行済み）。同一銘柄の複数行が正であり、DB を直接触るときは ticker でユニークと仮定しないこと。
- 通貨が取得できない銘柄の価格更新はエラーになる（推測換算はしない方針）。エラーは refresh の `errors` に載る。
- 1920x1080 コンテンツサイズは 100% スケーリング前提。125% スケーリングのモニタでは論理作業領域（約1536x864）を超えるため、必要ならウィンドウは小さくなるが `capturePage` は物理ピクセルで撮れる。
- セクター情報は `yfinance` 由来で取得失敗・空のことがある。セクター別配色では不明銘柄をグレースケールにフォールバックしている。
