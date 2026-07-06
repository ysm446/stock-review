# Plan

## 実装方針

- **アーキテクチャ**
  - フロント: Electron renderer（`src/`、Vanilla JS + Canvas 描画）。
  - メイン: `electron/`（IPC、Python サービス起動、データファイル管理）。
  - バックエンド: `backend/`（Python、`yfinance` での価格・指標・セクター・配当取得）。
  - データ: `data/`（SQLite `app.db`、`portfolio.json`、`stock_master.json`、銘柄別ノート）。
- Python は **プロジェクト直下の `.venv`** を前提とする（conda からは移行済み）。
- UI 文言・コメントは日本語を基本とする。
- 計算ロジック（評価額・損益・円換算）は renderer / backend のどちらに置くか役割を意識し、二重実装を避ける。

## 優先順位

1. **正確性に関わる不具合**: 評価額・損益・配当・トレンド・重複保有の扱い。
2. **既存機能の使い勝手向上**: 表示の見やすさ、配色、まとめ表示などの調整。
3. **新機能**: 配色パターンの拡充、レビュー機能の強化、LLM チャットの改善。

## 今後の予定（2026-07-05 全体レビューを受けたロードマップ）

1. **フェーズ1: データ損失・正確性の修正**（最優先）
   - 同一銘柄の複数ロットが DB 保存で最後の1件に潰れる問題（`holdings` の ticker PRIMARY KEY → ロット単位のスキーマへ移行）。
   - GBp（ペンス）等の補助通貨単位が 100 倍換算される問題。あわせて `shared.py` と `portfolio_store.py` の通貨換算の重複を解消。
   - 通貨欠損時のデフォルト不整合（履歴=JPY / 最新値=USD）の統一。
   - トレンドチャートの合成（デモ）データ生成を削除し、履歴不足時は明示表示。
   - `portfolio.json` / `notes.md` などの非アトミック書き込みを tmp+rename 化。
   - 小型修正: 配当利回りフォールバックの 100 倍表示、全角数字入力で現金が 0 になる問題、文字化けリテラル。
2. **フェーズ2: セキュリティ** — chat_server の CORS 制限＋トークン認証、ニュース描画の XSS エスケープ、`setWindowOpenHandler` / `will-navigate` ガード、Electron のメジャー更新。
3. **フェーズ3: F12 スクリーンショット + 1920x1080** — `useContentSize:true` でコンテンツ領域 1920x1080、F12（`before-input-event`）→ `capturePage()` → `data/screenshots/YYYYMMDD-HHmmss.png`。
4. **フェーズ4: LLM チャット再設計（Ornith 移行、news-picker の実証パターンを移植）**
   - 役割ベース2ポート運用: standard（Ornith 9B、:8081 常駐）/ deep（Ornith 35B、:8082、ロード/アンロード）。GGUF 自動発見と設定画面での役割別選択。
   - llama-server は `--jinja` 必須。sampling {temp 0.6, top_p 0.95, top_k 20}。チャットは thinking ON + max_tokens 4096、背景処理は `enable_thinking:false` + json_schema（Ornith は思考に ~1000 トークン消費するため）。
   - エージェンティックループ（MAX_TOOL_STEPS=8、ツール失敗は error をモデルへ返却、上限時は tools=None で最終回答強制）。ツール: web_search / news_search（ddgs、region jp-jp、timelimit "w"）+ stock_context + notes_search。
   - system メッセージは1つに結合（Qwen3 系は複数で 400）。SSE イベント語彙は news-picker 互換。
   - フロントは共通 `chat-client.js` に統合し、銘柄別チャットは「ワークスペース＝銘柄」として同一実装へ。
5. **フェーズ5: ダッシュボード統合** — renderer.js の分割（state / テーブル / チャート / レビュー）を前提に、portfolio ビューを高さ固定グリッドへ再構成。
6. **フェーズ6: データルートフォルダの分離（アプリとデータの分離）**
   - **目的**: アプリ本体（コード・実行バイナリ）とユーザーデータを分離し、データの保存先ルートフォルダを設定で選べるようにする。バックアップ・別ドライブ配置・再インストール時のデータ保持を容易にする（`goals.md` の「ローカル完結」と整合）。
   - **`data/` 内の分類（ユーザーデータ／環境設定／参照キャッシュ）**: `data/` を一律に扱わず、性質で分離する。
     - **① ユーザーデータ（可搬・バックアップ対象・ルート移動の対象）**: `app.db`（保有・ウォッチ・現金・`app_settings`）、`chat.db`（会話）、`portfolio.json`(+`.bak`)、`annotations.json`(+`.bak`)、`stocks/<ticker>/notes.md`（銘柄別ノート）、`notes/`（旧ノート）、`screenshots/`（ユーザー生成だが破棄可）。
     - **② 環境設定（マシン固有・可搬にしない・ルート移動の対象外）**: `llama_paths.json`（このマシンの GGUF 絶対パス・`ctx_size`・PID・役割/ポート設定）。将来の `config.json`（リソースモニター表示、モデル役割設定、そして**データルートの保存先ポインタ自身**）もここ。※ データルートの場所を可搬なユーザーデータ内に置くと自己参照になるため、ポインタは必ず環境設定側（例: `app.getPath("userData")`）に置く。
     - **③ 参照/キャッシュ（アプリ管理・再取得可能）**: `stock_master.json`（`update_stock_master.py` で更新可能な銘柄マスタ）、`portfolio.example.json`（アプリ同梱のサンプル。ユーザーデータではない）。埋め込みベクトル DB もここ寄り（再生成可能なら）。ルートに含めるか、別のキャッシュ領域に置くかは容量と再取得コストで判断。
   - **`models/`・`runtime/`（llama-server バイナリ）** は容量が大きく「アプリ資産」寄りのため、上記いずれとも別に扱う（データルートには含めない方針を軸に検討）。
   - **現状の課題**: データ基点が複数箇所でハードコードされ二重管理になっている。Electron 側は `electron/data-files.js` の `DATA_DIR = __dirname/../data` と `electron/main.js` の `LLAMA_PATHS_FILE`。Python 側は `backend/portfolio_store.py` の `REPO_ROOT/data`（`shared.py`・ノート・埋め込み等の各モジュールも同様の基点を持つ想定）。まずこれらの基点を洗い出して一本化する。
   - **方針**:
     - **2系統のパスを別々に解決する**: (a) ユーザーデータルート（①、ユーザーが設定で選べる。デフォルトは `app.getPath("userData")/data` 等）、(b) 環境設定ディレクトリ（②、常にマシン固有の固定領域＝`app.getPath("userData")` 直下。ユーザーデータルートのポインタもここに保存）。
     - パス基点は Electron 側・Python 側それぞれ一箇所（`paths.js` / `paths.py` 的なモジュール）に集約し、二重ハードコードを解消する。バックエンド（Python）へは環境変数（例 `STOCK_REVIEW_DATA_DIR` とは別に `STOCK_REVIEW_CONFIG_DIR`）または CLI 引数で両方を明示的に渡す。
     - 相対パス前提の箇所を棚卸しして振り分ける: `screenshots/`・ノート・`app.db`・`chat.db`・`portfolio.json`・`annotations.json` → ユーザーデータルート。`llama_paths.json`・将来の `config.json` → 環境設定。`stock_master.json` → 参照/キャッシュ。
   - **設定 UI**: 設定モーダルに「データ」タブ（または表示タブ内）を新設し、フォルダ選択（`dialog.showOpenDialog`）・現在の保存先表示・「フォルダを開く」を用意。
   - **エクスポート／インポートの廃止**: ポートフォリオヘッダーの「エクスポート」「インポート」ボタン（`src/index.html` の `#export-portfolio`/`#import-portfolio`、`renderer.js` の `exportPortfolio`/`importPortfolio`、preload/`main.js` の `stockReviewApi.exportPortfolio`/`importPortfolio` IPC）を撤去する。これらは `portfolio.json` を手動でファイル入出力する機能で、データルートをユーザーが選んで直接バックアップ・移動できるようになれば役割が重複するため。ルートフォルダ設定が可搬性の担い手を引き継ぐ。撤去に伴いヘッダーは「価格を更新」のみになる。
   - **移行**: ルート変更時に既存 `data/` の移動/コピー方針を決める（コピー後に旧を残す/消す、書き込み中の安全性）。初回起動時のデフォルト作成と、旧レイアウト（リポジトリ直下 `data/`）からの後方互換フォールバック。
   - **注意**: DB は WAL 運用（`app.db-wal`/`-shm` も含めて移動）。移行中の非アトミック書き込みに注意（tmp+rename 方針を踏襲）。

### 従来からの候補（フェーズ後に検討）

- グラフ配色パターンの拡充（損益ヒートマップ / 単色グラデーション / パステル など）。
- セクター別の集計・表示（保有割合のセクター内訳など）。
- レビュー / 企業指標ビューの項目拡充。

## 進め方のルール

- 作業前に `goals.md` / `plan.md` / `progress.md` を確認する（`CLAUDE.md` 参照）。
- 方針と矛盾しそうな変更は、実装前に確認する。
- 作業が一区切りしたら `progress.md` を更新する。
