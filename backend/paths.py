"""バックエンド共通のパス解決。

`data/` を性質で分けて解決する（詳細は docs/plan/plan.md フェーズ6）:
  ① ユーザーデータ（可搬・バックアップ対象）    → DATA_DIR
  ② 環境設定（マシン固有・llama_paths.json 等）  → CONFIG_DIR
  ③ 参照/キャッシュ（stock_master.json 等）       → 当面 DATA_DIR 配下

Electron から起動された場合は環境変数でルートが渡される:
  STOCK_REVIEW_DATA_DIR   … ユーザーデータルート
  STOCK_REVIEW_CONFIG_DIR … 環境設定ディレクトリ
どちらも未指定のとき（Python 単体実行・後方互換）はリポジトリ直下 `data/`。
"""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
_LEGACY_DATA_DIR = REPO_ROOT / "data"


def _dir_from_env(var: str, default: Path) -> Path:
    value = os.environ.get(var)
    if value:
        try:
            return Path(value).expanduser().resolve()
        except Exception:
            pass
    return default


# ① ユーザーデータルート（設定で変更可能）
DATA_DIR = _dir_from_env("STOCK_REVIEW_DATA_DIR", _LEGACY_DATA_DIR)
# ② 環境設定ディレクトリ（マシン固有。ルート移動の対象外）
CONFIG_DIR = _dir_from_env("STOCK_REVIEW_CONFIG_DIR", _LEGACY_DATA_DIR)

# ── ① ユーザーデータ ──────────────────────────────────────
DB_FILE = DATA_DIR / "app.db"
PORTFOLIO_FILE = DATA_DIR / "portfolio.json"
ANNOTATIONS_FILE = DATA_DIR / "annotations.json"
CHAT_DB_FILE = DATA_DIR / "chat.db"
STOCKS_DIR = DATA_DIR / "stocks"
SCREENSHOTS_DIR = DATA_DIR / "screenshots"

# ── ③ 参照/キャッシュ（当面 DATA_DIR 配下） ───────────────
STOCK_MASTER_FILE = DATA_DIR / "stock_master.json"

# ── ② 環境設定 ────────────────────────────────────────────
LLAMA_PATHS_FILE = CONFIG_DIR / "llama_paths.json"


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def ensure_config_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
