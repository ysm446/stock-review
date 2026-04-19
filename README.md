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

Pythonは `conda activate main` を前提にしています。モックのバックエンドは次のどちらでも起動できます。

```powershell
conda activate main
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

`main` 環境に `yfinance` が無い場合は先にインストールしてください。

```powershell
conda activate main
pip install yfinance
```

## 銘柄マスター更新

日本株の銘柄一覧は JPX の上場銘柄一覧から `data/stock_master.json` を再生成できます。

```powershell
conda activate main
python backend/update_stock_master.py
```
