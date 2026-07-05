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

### 従来からの候補（フェーズ後に検討）

- グラフ配色パターンの拡充（損益ヒートマップ / 単色グラデーション / パステル など）。
- セクター別の集計・表示（保有割合のセクター内訳など）。
- レビュー / 企業指標ビューの項目拡充。

## 進め方のルール

- 作業前に `goals.md` / `plan.md` / `progress.md` を確認する（`CLAUDE.md` 参照）。
- 方針と矛盾しそうな変更は、実装前に確認する。
- 作業が一区切りしたら `progress.md` を更新する。
