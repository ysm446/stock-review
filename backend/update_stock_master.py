import json
from io import BytesIO
from pathlib import Path

import pandas as pd
import requests


JPX_URLS = [
    "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls",
    "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data.xls",
]

MANUAL_ENTRIES = {
    "AAPL": "Apple",
    "MSFT": "Microsoft",
    "NVDA": "NVIDIA",
}


def normalize_ticker(code: object) -> str:
    raw = str(code).strip()
    if not raw or raw.lower() == "nan":
        return ""
    return raw if raw.endswith(".T") else f"{raw}.T"


def download_jpx_dataframe() -> pd.DataFrame:
    last_error = None
    for url in JPX_URLS:
        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            return pd.read_excel(BytesIO(response.content))
        except Exception as exc:  # pragma: no cover - network varies
            last_error = exc
    raise RuntimeError(f"JPX download failed: {last_error}")


def build_stock_master() -> dict[str, str]:
    df = download_jpx_dataframe()
    required_columns = {"コード", "銘柄名"}
    missing = required_columns - set(df.columns)
    if missing:
        raise RuntimeError(f"JPX file format changed. Missing columns: {sorted(missing)}")

    master = {}
    for _, row in df.iterrows():
        ticker = normalize_ticker(row["コード"])
        name = str(row["銘柄名"]).strip()
        if not ticker or not name or name.lower() == "nan":
            continue
        master[ticker] = name

    master.update(MANUAL_ENTRIES)
    return dict(sorted(master.items(), key=lambda item: item[0]))


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    output_path = repo_root / "data" / "stock_master.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    master = build_stock_master()
    output_path.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Updated {output_path}")
    print(f"Entries: {len(master)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
