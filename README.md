# Stock Review

Electronで作る株レビュー用デスクトップアプリです。左サイドはアイコンのみのナビゲーションで、`Portfolio` と `Review` を切り替えられます。

## できること

- 銘柄別に保有株数、現在値、メモを入力
- 評価額をテーブルで自動計算
- 保有割合をドーナツチャートで表示
- 個別銘柄レビューをウォッチリスト形式で保存
- `yfinance` で現在値を一括更新

## 起動

```powershell
npm install
npm start
```

## Python環境

Pythonはプロジェクト直下の `.venv` を前提にしています。モックのバックエンドは次のどちらでも起動できます。

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python backend/mock_api.py
```

または

```powershell
npm run python:backend
```

## 株価自動取得

ポートフォリオ画面の `価格を更新` ボタンで、`yfinance` から現在値を取得できます。米国株など外貨建て銘柄は自動で円換算して `現在値` に反映します。

- 米国株は `AAPL`
- 日本株は `7203.T`

`.venv` 環境に依存パッケージが無い場合は先にインストールしてください。

```powershell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

埋め込み検索を使う場合は任意依存もインストールします。

```powershell
pip install -r requirements-optional.txt
```

## 銘柄マスター更新

日本株の銘柄一覧は JPX の上場銘柄一覧から `data/stock_master.json` を再生成できます。

```powershell
.venv\Scripts\Activate.ps1
python backend/update_stock_master.py
```

## Notes

- `企業指標` ビューは日本株（`.T`）の保有銘柄 / ウォッチリスト銘柄を対象に表示します。
