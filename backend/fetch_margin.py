"""JPX「銘柄別信用取引週末残高」PDF を取得し、信用買い残・売り残を蓄積する。

東証は毎週の週末残高（申込日＝金曜時点）を翌週第2営業日ごろに PDF で公表する。
無料公開は直近5週分のみで過去分は削除されるため、定期的に取り込んで
`app.db` の `margin_history` テーブルへ蓄積する（review_price_history と同じ発想）。

PDF の1テーブル行 = 銘柄名 | 普通株式 | 5桁コード | ISIN | (貸借フラグ) | 数値12列。
数値列は 売残 前週比 買残 前週比 一般売 前週比 制度売 前週比 一般買 前週比 制度買 前週比。
名前と数値で baseline が僅かにずれるため許容誤差付きで行グループ化し、
ISIN より右側の数値だけを右揃えの x 座標で12列へ割り当てる。
検証則: 売残 = 一般売 + 制度売, 買残 = 一般買 + 制度買（不一致行は破棄）。
"""
from __future__ import annotations

import io
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

import requests

from paths import DB_FILE

PAGE_URL = "https://www.jpx.co.jp/markets/statistics-equities/margin/05.html"
JPX_ORIGIN = "https://www.jpx.co.jp"
# JPX はデフォルトの python-requests UA を 403 で拒否する
HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
}
CHECK_INTERVAL = timedelta(hours=6)

PDF_LINK = re.compile(r'href="([^"]*syumatsu(\d{8})00\.pdf)"')
NUM = re.compile(r"^[0-9][0-9,]*$")
CODE = re.compile(r"^[0-9][0-9A-Z]{3}[0-9]$")
ISIN = re.compile(r"^JP[0-9A-Z]{10}$")


def normalize_code(code5: str) -> str:
    """PDF の5桁コードをアプリのティッカー形式へ（'72030'→'7203'、'25935'はそのまま）。"""
    return code5[:-1] if code5.endswith("0") else code5


def code_for_ticker(symbol: str) -> str | None:
    """'7203.T' のような東証ティッカーから照合用コードを取り出す。対象外は None。"""
    match = re.fullmatch(r"([0-9A-Z]{4,5})\.T", str(symbol).strip().upper())
    return match.group(1) if match else None


def _group_lines(words, tol=4.0):
    lines = []
    for word in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(lines[-1][0] - word["top"]) <= tol:
            lines[-1][1].append(word)
        else:
            lines.append([word["top"], [word]])
    return [sorted(ws, key=lambda w: w["x0"]) for _, ws in lines]


def parse_margin_pdf(pdf_bytes: bytes) -> dict[str, tuple[int, int]]:
    """PDF から {正規化コード: (売残, 買残)} を返す。"""
    import pdfplumber  # 重い依存のため遅延 import

    raw_rows = []  # (code5, [(x1, value), ...])
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            for words in _group_lines(page.extract_words()):
                isin_word = next((w for w in words if ISIN.match(w["text"])), None)
                if not isin_word:
                    continue
                code = next(
                    (w["text"] for w in words
                     if CODE.match(w["text"]) and w["x1"] <= isin_word["x0"] + 1),
                    None,
                )
                if not code:
                    continue
                values = []
                negative = False
                for word in words:
                    if word["x0"] <= isin_word["x1"]:
                        continue
                    text = word["text"]
                    if text == "▲":  # 次の数値のマイナス符号
                        negative = True
                    elif NUM.match(text):
                        value = int(text.replace(",", ""))
                        values.append((round(word["x1"]), -value if negative else value))
                        negative = False
                    else:
                        negative = False
                if values:
                    raw_rows.append((code, values))

    # 右揃え数値の右端 x を全行からクラスタ化して12列の中心を決める
    xs = sorted({x for _, values in raw_rows for x, _ in values})
    clusters: list[list[int]] = []
    for x in xs:
        if clusters and x - clusters[-1][-1] <= 12:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    centers = [sum(c) / len(c) for c in clusters]
    if len(centers) != 12:
        raise RuntimeError(f"PDFの列構造を解釈できませんでした（{len(centers)}列を検出）")

    result: dict[str, tuple[int, int]] = {}
    for code, values in raw_rows:
        columns: list[int | None] = [None] * 12
        for x, value in values:
            index = min(range(12), key=lambda i: abs(centers[i] - x))
            columns[index] = value
        sell, buy = columns[0], columns[2]
        if sell is None or buy is None:
            continue
        components = (columns[4], columns[6], columns[8], columns[10])
        if all(v is not None for v in components) and (
            sell != components[0] + components[1] or buy != components[2] + components[3]
        ):
            continue  # 列ずれの疑いがある行は取り込まない
        result[normalize_code(code)] = (sell, buy)
    return result


def _connect():
    DB_FILE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("""CREATE TABLE IF NOT EXISTS margin_history (
        code TEXT NOT NULL, week_date TEXT NOT NULL,
        sell_balance INTEGER, buy_balance INTEGER, updated_at TEXT NOT NULL,
        PRIMARY KEY (code, week_date))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS margin_meta (
        key TEXT PRIMARY KEY, value TEXT)""")
    return conn


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _upsert_week(conn, week_date: str, balances: dict[str, tuple[int, int]], now: str) -> None:
    conn.executemany(
        """INSERT INTO margin_history (code, week_date, sell_balance, buy_balance, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(code, week_date) DO UPDATE SET
             sell_balance=excluded.sell_balance, buy_balance=excluded.buy_balance,
             updated_at=excluded.updated_at""",
        [(code, week_date, sell, buy, now) for code, (sell, buy) in balances.items()],
    )


def ingest(throttle: bool = True) -> dict:
    """JPX ページを確認し、未取り込みの週の PDF を蓄積する。"""
    conn = _connect()
    try:
        if throttle:
            row = conn.execute(
                "SELECT value FROM margin_meta WHERE key = 'last_checked'"
            ).fetchone()
            if row:
                try:
                    last = datetime.fromisoformat(row[0].replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) - last < CHECK_INTERVAL:
                        return {"checked": False, "ingested": []}
                except ValueError:
                    pass

        page = requests.get(PAGE_URL, headers=HTTP_HEADERS, timeout=30)
        page.raise_for_status()
        links = {}  # week_date -> url
        for href, ymd in PDF_LINK.findall(page.text):
            week_date = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:]}"
            links[week_date] = href if href.startswith("http") else JPX_ORIGIN + href

        known = {r[0] for r in conn.execute("SELECT DISTINCT week_date FROM margin_history")}
        now = _utc_now_iso()
        ingested = []
        for week_date in sorted(links):
            if week_date in known:
                continue
            pdf = requests.get(links[week_date], headers=HTTP_HEADERS, timeout=60)
            pdf.raise_for_status()
            balances = parse_margin_pdf(pdf.content)
            if not balances:
                continue
            _upsert_week(conn, week_date, balances, now)
            ingested.append({"weekDate": week_date, "count": len(balances)})
        conn.execute(
            "INSERT INTO margin_meta (key, value) VALUES ('last_checked', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now,),
        )
        conn.commit()
        return {"checked": True, "ingested": ingested}
    finally:
        conn.close()


def load_margin_history(symbol: str) -> list[dict]:
    """東証ティッカーの蓄積済み信用残を古い順で返す。対象外・未蓄積は空リスト。"""
    code = code_for_ticker(symbol)
    if not code or not DB_FILE.exists():
        return []
    conn = sqlite3.connect(DB_FILE)
    try:
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='margin_history'"
        ).fetchone()
        if not table:
            return []
        rows = conn.execute(
            """SELECT week_date, sell_balance, buy_balance FROM margin_history
               WHERE code = ? ORDER BY week_date""",
            (code,),
        ).fetchall()
        return [{"date": r[0], "sell": r[1], "buy": r[2]} for r in rows]
    finally:
        conn.close()


def get_settings() -> dict:
    """自動取り込み設定（margin_meta に保存。未設定はオン）。"""
    conn = _connect()
    try:
        row = conn.execute("SELECT value FROM margin_meta WHERE key = 'auto_ingest'").fetchone()
        return {"autoIngest": row is None or row[0] != "0"}
    finally:
        conn.close()


def save_settings(auto_ingest: bool) -> dict:
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO margin_meta (key, value) VALUES ('auto_ingest', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            ("1" if auto_ingest else "0",),
        )
        conn.commit()
    finally:
        conn.close()
    return {"autoIngest": bool(auto_ingest)}


def ingest_safely(symbol: str) -> None:
    """日足再取得などに相乗りして蓄積を試みる。失敗しても呼び出し元を止めない。

    設定（margin_meta.auto_ingest）でオフのときは何もしない。手動実行
    （CLI --force / バックフィル / 設定画面の取り込み）はこの関数を通らない。
    """
    if not code_for_ticker(symbol):
        return
    try:
        if not get_settings()["autoIngest"]:
            return
        ingest(throttle=True)
    except Exception as error:
        print(f"margin ingest failed: {error}", file=sys.stderr)


def main() -> int:
    result = ingest(throttle="--force" not in sys.argv)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
