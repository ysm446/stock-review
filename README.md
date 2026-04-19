# Stock Review

Electronで作る株レビュー用デスクトップアプリです。左サイドはアイコンのみのナビゲーションで、`Portfolio` と `Review` を切り替えられます。

## できること

- 銘柄別に保有株数、現在値、メモを入力
- 評価額をテーブルで自動計算
- 保有割合をドーナツチャートで表示
- 個別銘柄レビューをウォッチリスト形式で保存

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
