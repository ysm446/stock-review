# Stock Review

yfinance ベースの割安株スクリーニング・投資分析システム。ローカル LLM (llama-cpp-python / GGUF) による AI アシスタント付き。

## 機能

| タブ | 機能 |
|------|------|
| スクリーニング | 割安株・押し目・アルファ銘柄を自動スクリーニング (10地域) |
| 銘柄レポート | PER/PBR/ROE・テクニカル・ヘルスチェック・推定利回りを一覧表示 |
| ポートフォリオ | 保有銘柄の損益・リスク・相関・集中度を分析 |
| ストレステスト | 8種のマクロシナリオでポートフォリオへの影響をシミュレーション |
| AI アシスタント | ローカル LLM との対話型株式分析チャット |
| モデル管理 | GGUF モデルのロード／アンロード |

## 必要環境

- Windows 11 (動作確認済み)
- Python 3.10+
- conda 環境推奨
- GPU: CUDA 対応 (推奨) / CPU のみも可

## インストール

```bash
# 依存パッケージ
pip install -r requirements.txt

# llama-cpp-python — CUDA 12.4 対応版 (GPU 推論・推奨)
pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124

# CPU のみの場合
pip install llama-cpp-python
```

## LLM モデルの準備

`models/` フォルダに GGUF 形式のモデルファイルを配置します。

```
models/
└── Qwen3-8B-Q4_K_M.gguf
```

推奨モデル: [Qwen3-8B-Q4_K_M](https://huggingface.co/Qwen/Qwen3-8B-GGUF)

アプリ起動後、「モデル管理」タブで **Load** ボタンを押すとモデルが読み込まれます。

## 起動

```bat
:: Windows バッチ
start.bat

:: コマンドライン
set PYTHONIOENCODING=utf-8
python app.py
```

ブラウザで http://localhost:7860 を開きます。

## 注意事項

**投資は自己責任です。** 本システムの出力は投資助言ではありません。実際の投資判断は本システムの出力を参考情報の一つとして、ご自身の判断で行ってください。
