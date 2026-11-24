"""Local SQLite store for public A-share daily bars, called by the service view.

The source is the existing registered TDX package parser. This module does not
read user trades or provide tools to research agents.
"""
from __future__ import annotations

import argparse
import calendar
from collections import defaultdict
from contextlib import closing
import csv
from datetime import date, datetime
from decimal import Decimal
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import time
from typing import Mapping
from zoneinfo import ZoneInfo
from requests.exceptions import RequestException

from sources._http import capture
from sources.astock_ported import _tdx_parse_package, tdx_daily_package
from sources.astock_defaults import _open_days
from sources.shortline_watch import is_a_share

DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}\Z")
MARKETS = ("sh", "sz", "bj")


def checked_day(value: str) -> str:
    if not DATE_RE.fullmatch(value):
        raise ValueError("日期必须为 YYYY-MM-DD")
    date.fromisoformat(value)
    return value


def fixed(value: object, scale: int) -> int:
    n = Decimal(str(value)) * scale
    if n != n.to_integral_value() or n < 0:
        raise ValueError("行情数值精度或符号异常")
    return int(n)


def open_db(file: Path, *, write: bool) -> sqlite3.Connection:
    if write:
        file.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(file, timeout=5)
        # Simultaneous first opens can return SQLITE_BUSY immediately on the WAL switch.
        deadline = time.monotonic() + 5
        while True:
            try:
                db.execute("PRAGMA journal_mode=WAL").fetchone()
                break
            except sqlite3.OperationalError as exc:
                if exc.sqlite_errorcode != sqlite3.SQLITE_BUSY or time.monotonic() >= deadline:
                    db.close()
                    raise
                time.sleep(0.05)
        db.execute("PRAGMA synchronous=FULL")
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript("""
            CREATE TABLE IF NOT EXISTS market_day (
                day TEXT PRIMARY KEY, archive_sha256 TEXT NOT NULL,
                raw_ref TEXT NOT NULL, row_count INTEGER NOT NULL CHECK(row_count>0)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS calendar_month (
                month TEXT PRIMARY KEY, archive_sha256 TEXT NOT NULL,
                day_count INTEGER NOT NULL CHECK(day_count>0)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS calendar_day (
                day TEXT PRIMARY KEY, month TEXT NOT NULL,
                FOREIGN KEY(month) REFERENCES calendar_month(month)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS daily_bar (
                day TEXT NOT NULL, market TEXT NOT NULL CHECK(market IN ('sh','sz','bj')),
                raw_code TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
                prev_close_1e4 INTEGER NOT NULL CHECK(prev_close_1e4>=0),
                close_1e4 INTEGER NOT NULL CHECK(close_1e4>=0),
                volume INTEGER NOT NULL CHECK(volume>=0),
                amount_fen INTEGER NOT NULL CHECK(amount_fen>=0),
                PRIMARY KEY(day,market,raw_code),
                FOREIGN KEY(day) REFERENCES market_day(day)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS daily_bar_symbol_day ON daily_bar(symbol,day);
        """)
        return db
    if not file.is_file():
        raise FileNotFoundError("市场历史数据库尚未建立")
    # mode=ro prevents a GET view from creating a database or changing rows.
    db = sqlite3.connect(f"{file.resolve().as_uri()}?mode=ro", uri=True, timeout=5)
    db.execute("PRAGMA query_only=ON")
    return db


def mapping_from(repo_root: Path) -> dict[str, str]:
    data = json.loads((repo_root / "datasources/market_history/bse_codes_20251009.json").read_text())
    if not isinstance(data, dict) or len(data) != 248:
        raise ValueError("北交所换码表缺失或不完整")
    return data


def row_tuple(day: str, row: Mapping[str, object], mapping: dict[str, str]) -> tuple | None:
    market = str(row["market"])
    code = str(row["code"])
    if not is_a_share(market, code):
        return None
    canonical = mapping.get(code, code) if market == "bj" and day < "2025-10-09" else code
    return (day, market, code, market + canonical, str(row["name"]),
            fixed(row["prev_close"], 10_000), fixed(row["close"], 10_000),
            fixed(row["volume"], 1), fixed(row["amount"], 100))


def replace_day(db: sqlite3.Connection, day: str, archive_sha: str, raw_ref: str,
                rows: list[tuple], *, capture_store: Path | None = None) -> str:
    if not rows or {r[1] for r in rows} != set(MARKETS):
        raise ValueError("盘后包缺少沪深京 A 股记录")
    if len(rows) != len({(r[1], r[2]) for r in rows}):
        raise ValueError("同一市场代码重复")
    with db:
        inserted = db.execute(
            "INSERT INTO market_day VALUES (?,?,?,?) ON CONFLICT(day) DO NOTHING",
            (day, archive_sha, raw_ref, len(rows)),
        ).rowcount
        if not inserted:
            old_sha, old_ref = db.execute(
                "SELECT archive_sha256,raw_ref FROM market_day WHERE day=?", (day,)
            ).fetchone()
            if old_sha == archive_sha:
                if capture_store is not None and old_ref != raw_ref:
                    previous = capture_store / old_ref
                    if previous.is_file() and hashlib.sha256(previous.read_bytes()).hexdigest() == archive_sha:
                        (capture_store / raw_ref).unlink()
                    else:
                        db.execute("UPDATE market_day SET raw_ref=? WHERE day=?", (raw_ref, day))
                return "unchanged"
            db.execute("DELETE FROM daily_bar WHERE day=?", (day,))
            db.execute("UPDATE market_day SET archive_sha256=?,raw_ref=?,row_count=? WHERE day=?",
                       (archive_sha, raw_ref, len(rows), day))
        db.executemany("INSERT INTO daily_bar VALUES (?,?,?,?,?,?,?,?,?)", rows)
    return "inserted" if inserted else "replaced"


def months_for(day: str) -> list[str]:
    year, month = map(int, day[:7].split("-"))
    out = []
    for _ in range(5):
        out.append(f"{year:04d}-{month:02d}")
        month -= 1
        if month == 0:
            year -= 1
            month = 12
    return out


def months_between(first: str, last: str) -> list[str]:
    year, month = map(int, first[:7].split("-"))
    final = last[:7]
    out = []
    while f"{year:04d}-{month:02d}" <= final:
        out.append(f"{year:04d}-{month:02d}")
        month += 1
        if month == 13:
            year += 1
            month = 1
    return out


def ensure_calendar(db: sqlite3.Connection, store: Path, day: str) -> None:
    for month in months_for(day):
        if db.execute("SELECT 1 FROM calendar_month WHERE month=?", (month,)).fetchone():
            continue
        year, number = map(int, month.split("-"))
        with capture(str(store / "calendar" / month), "szse", "calendar") as cap:
            days = _open_days(year, number)
        if not days or any(not d.startswith(month) for d in days):
            raise ValueError(f"{month} 的交易日历不完整")
        raw = cap.raws[-1] if cap.raws else None
        if not raw or not raw.get("sha256"):
            raise ValueError(f"{month} 的日历没有原始来源")
        with db:
            inserted = db.execute("INSERT INTO calendar_month VALUES (?,?,?) ON CONFLICT(month) DO NOTHING",
                                  (month, raw["sha256"], len(days))).rowcount
            if not inserted:
                continue
            db.executemany("INSERT INTO calendar_day VALUES (?,?)", ((d, month) for d in days))
    if not db.execute("SELECT 1 FROM calendar_day WHERE day=?", (day,)).fetchone():
        raise ValueError(f"{day} 不是深交所登记交易日")


def captured_calendar(raw: bytes) -> tuple[str, list[str]]:
    """Validate a complete natural month before trusting its open-day flags."""
    payload = json.loads(raw)
    records = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(records, list) or not records:
        raise ValueError("日历原文缺少 data 列表")
    first = records[0]
    if not isinstance(first, dict) or not isinstance(first.get("jyrq"), str):
        raise ValueError("日历日期字段异常")
    month = first["jyrq"][:7]
    if not re.fullmatch(r"\d{4}-\d{2}", month):
        raise ValueError("日历月份异常")
    year, number = map(int, month.split("-"))
    expected = {f"{month}-{d:02d}" for d in range(1, calendar.monthrange(year, number)[1] + 1)}
    seen: set[str] = set()
    opened: list[str] = []
    for rec in records:
        if not isinstance(rec, dict) or rec.get("jybz") not in ("0", "1"):
            raise ValueError(f"{month} 日历开市字段异常")
        day = rec.get("jyrq")
        if not isinstance(day, str) or day not in expected or day in seen:
            raise ValueError(f"{month} 日历日期缺失、重复或错月")
        seen.add(day)
        if rec["jybz"] == "1":
            opened.append(day)
    if seen != expected or not opened:
        raise ValueError(f"{month} 日历不完整")
    return month, sorted(opened)


def copied_archive(source: Path, target: Path, sha: str) -> None:
    """Keep the service store self-contained, without linking validation files."""
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == sha:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".part")
    shutil.copyfile(source, temp)
    if hashlib.sha256(temp.read_bytes()).hexdigest() != sha:
        temp.unlink(missing_ok=True)
        raise ValueError(f"复制后哈希不符: {source.name}")
    os.replace(temp, target)


def replay(repo_root: Path, store: Path, captured: Path) -> dict:
    """Local-only rebuild from a previously captured, verified source directory."""
    mapping = mapping_from(repo_root)
    with (captured / "archives.csv").open(newline="") as fh:
        manifest = list(csv.DictReader(fh))
    if not manifest or len({r["day"] for r in manifest}) != len(manifest):
        raise ValueError("原始包清单为空或日期重复")
    dates = [checked_day(r["day"]) for r in manifest]
    if dates != sorted(dates):
        raise ValueError("原始包清单未按日期排序")
    calendar_raw = list((captured / "calendar" / "raw").glob("*.json"))
    if not calendar_raw:
        raise ValueError("缺少交易所日历原文")
    months: dict[str, tuple[Path, str, list[str]]] = {}
    for file in calendar_raw:
        content = file.read_bytes()
        month, opened = captured_calendar(content)
        if month in months:
            raise ValueError(f"重复的日历月份: {month}")
        months[month] = (file, hashlib.sha256(content).hexdigest(), opened)
    declared = json.loads((captured / "calendar.json").read_text())
    calendar_days = sorted(d for _, _, opened in months.values() for d in opened if dates[0] <= d <= dates[-1])
    if declared != dates or calendar_days != dates:
        raise ValueError("原始包日期与交易所日历不一致")
    inserted = unchanged = replaced = 0
    with closing(open_db(store / "market.sqlite3", write=True)) as db:
        for month, (source, sha, opened) in sorted(months.items()):
            target = store / "calendar" / month / source.name
            copied_archive(source, target, sha)
            old = db.execute("SELECT archive_sha256 FROM calendar_month WHERE month=?", (month,)).fetchone()
            if old and old[0] == sha:
                continue
            with db:
                if old:
                    db.execute("DELETE FROM calendar_day WHERE month=?", (month,))
                    db.execute("DELETE FROM calendar_month WHERE month=?", (month,))
                db.execute("INSERT INTO calendar_month VALUES (?,?,?)", (month, sha, len(opened)))
                db.executemany("INSERT INTO calendar_day VALUES (?,?)", ((d, month) for d in opened))
        for index, record in enumerate(manifest, 1):
            day = record["day"]
            files = list((captured / day / "raw").glob("*.zip"))
            if len(files) != 1:
                raise ValueError(f"{day} 原始 ZIP 不唯一")
            source = files[0]
            sha = hashlib.sha256(source.read_bytes()).hexdigest()
            if sha != record["sha256"]:
                raise ValueError(f"{day} 原始 ZIP 哈希不符")
            target = store / "raw" / day / source.name
            copied_archive(source, target, sha)
            old = db.execute("SELECT archive_sha256 FROM market_day WHERE day=?", (day,)).fetchone()
            if old and old[0] == sha:
                unchanged += 1
                continue
            parsed = _tdx_parse_package(target.read_bytes(), day.replace("-", ""))
            rows = [item for row in parsed if (item := row_tuple(day, row, mapping)) is not None]
            if len(rows) != int(record["rows"]):
                raise ValueError(f"{day} A 股行数与清单不符")
            action = replace_day(db, day, sha, target.relative_to(store).as_posix(), rows)
            if action == "inserted":
                inserted += 1
            else:
                replaced += 1
            if index % 25 == 0 or index == len(manifest):
                print(f"replay {index}/{len(manifest)}", file=sys.stderr, flush=True)
        integrity = db.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError("SQLite quick_check 未通过")
    return {"dates": len(manifest), "inserted": inserted, "replaced": replaced,
            "unchanged": unchanged, "from": dates[0], "to": dates[-1], "quick_check": integrity}


def ingest(repo_root: Path, store: Path, day: str, *, calendar_ready: bool = False) -> dict:
    checked_day(day)
    if day > datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat():
        raise ValueError("未来日期不能采集")
    mapping = mapping_from(repo_root)
    capture_dir = store / "raw" / day
    with capture(str(capture_dir), "tdx", "daily") as cap:
        frame = tdx_daily_package(day)
    archives = [x for x in cap.raws if str(x.get("raw_ref", "")).endswith(".zip")]
    if len(archives) != 1:
        raise ValueError("盘后包没有唯一的原始 ZIP")
    archive = archives[0]
    relative = Path("raw") / day / str(archive["raw_ref"])
    raw = store / relative
    sha = hashlib.sha256(raw.read_bytes()).hexdigest()
    if sha != archive["sha256"]:
        raise ValueError("原始包哈希校验失败")
    if set(frame["date"].astype(str)) != {day}:
        raise ValueError("行情日期不符")
    rows = [item for row in frame.to_dict("records") if (item := row_tuple(day, row, mapping)) is not None]
    with closing(open_db(store / "market.sqlite3", write=True)) as db:
        calendar_status = "ready"
        if calendar_ready:
            if not db.execute("SELECT 1 FROM calendar_day WHERE day=?", (day,)).fetchone():
                raise ValueError(f"{day} 不是深交所登记交易日")
        else:
            try:
                ensure_calendar(db, store, day)
            except RequestException:
                calendar_status = "source_unavailable"
        status = replace_day(db, day, sha, relative.as_posix(), rows, capture_store=store)
    return {"date": day, "status": status, "rows": len(rows), "archive_sha256": sha,
            "calendar_status": calendar_status}


def backfill(repo_root: Path, store: Path, target: str, *, limit: int = 5, latest_first: bool = False) -> dict:
    """Import one bounded batch of the latest 60 official trading days."""
    checked_day(target)
    if target > datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat():
        raise ValueError("未来日期不能回填")
    if not 1 <= limit <= 5:
        raise ValueError("每批回填天数必须为 1–5")
    with closing(open_db(store / "market.sqlite3", write=True)) as db:
        ensure_calendar(db, store, target)
        days = [r[0] for r in db.execute(
            "SELECT day FROM calendar_day WHERE day<=? ORDER BY day DESC LIMIT 60", (target,)
        )][::-1]
        if len(days) != 60 or not all(db.execute("SELECT 1 FROM calendar_month WHERE month=?", (month,)).fetchone()
                                       for month in months_between(days[0], target)):
            raise ValueError("交易日历不足 60 个连续交易日，不能回填")
        existing = {r[0] for r in db.execute(
            "SELECT day FROM market_day WHERE day>=? AND day<=?", (days[0], target)
        )}
    pending = [day for day in days if day not in existing]
    imported = []
    for day in (pending[::-1] if latest_first else pending)[:limit]:
        imported.append(ingest(repo_root, store, day, calendar_ready=True))
    return {"target": target, "requested_days": len(days),
            "completed": len(days) - len(pending) + len(imported),
            "remaining": len(pending) - len(imported),
            "imported": [item["date"] for item in imported]}


def width(db: sqlite3.Connection, expected: dict[int, list[str] | None]) -> dict[str, dict[str, dict[str, int | None]]]:
    out: dict[str, dict[str, dict[str, int | None]]] = {
        m: {str(n): {"eligible": 0, "above": 0} for n in (20, 60)} for m in (*MARKETS, "all")
    }
    available = [d for ds in expected.values() if ds for d in ds]
    if not available:
        return out
    by_symbol: dict[str, dict[str, tuple[int, int, int, int]]] = defaultdict(dict)
    for day, symbol, prev, close, volume, amount in db.execute(
        "SELECT day,symbol,prev_close_1e4,close_1e4,volume,amount_fen FROM daily_bar WHERE day>=? AND day<=?",
        (min(available), max(available)),
    ):
        by_symbol[symbol][day] = (prev, close, volume, amount)
    for symbol, history in by_symbol.items():
        for n in (20, 60):
            days = expected[n]
            if days is None:
                continue
            bars = [history.get(day) for day in days]
            if any(b is None or min(b) <= 0 for b in bars):
                continue
            complete = [b for b in bars if b is not None]
            # Exact comparison; a close-to-MA tie must not flip with float rounding.
            normalized = Fraction(1)
            total = normalized
            for prev, close, _, _ in reversed(complete[1:]):
                normalized *= Fraction(prev, close)
                total += normalized
            above = int(total < n)
            for market in (symbol[:2], "all"):
                item = out[market][str(n)]
                item["eligible"] = (item["eligible"] or 0) + 1
                item["above"] = (item["above"] or 0) + above
    return out


def query(store: Path, day: str | None, series_days: int = 30) -> dict:
    if day is not None:
        checked_day(day)
    if not 5 <= series_days <= 60:
        raise ValueError("历史序列天数必须为 5–60")
    file = store / "market.sqlite3"
    if not file.is_file():
        return {"available": False, "reason": "市场历史数据尚未导入"}
    with closing(open_db(file, write=False)) as db:
        span = db.execute("SELECT MIN(day),MAX(day),COUNT(*) FROM market_day").fetchone()
        if not span or not span[2]:
            return {"available": False, "reason": "市场历史数据尚未导入"}
        target = day or span[1]
        source = db.execute("SELECT archive_sha256,row_count FROM market_day WHERE day=?", (target,)).fetchone()
        if source is None:
            return {"available": False, "date": target, "reason": "该交易日没有已导入的盘后数据", "coverage": {"from": span[0], "to": span[1], "days": span[2]}}
        expected = {}
        window_reason: dict[str, str | None] = {}
        target_calendar = db.execute("SELECT 1 FROM calendar_month WHERE month=?", (target[:7],)).fetchone() is not None
        for n in (20, 60):
            dates = [r[0] for r in db.execute("SELECT day FROM calendar_day WHERE day<=? ORDER BY day DESC LIMIT ?", (target, n))][::-1]
            present = db.execute("SELECT COUNT(*) FROM market_day WHERE day IN (SELECT day FROM calendar_day WHERE day<=? ORDER BY day DESC LIMIT ?)", (target, n)).fetchone()[0]
            months_complete = bool(dates) and all(db.execute("SELECT 1 FROM calendar_month WHERE month=?", (month,)).fetchone()
                                                  for month in months_between(dates[0], target))
            expected[n] = dates if months_complete and len(dates) == n and present == n and dates[-1] == target else None
            window_reason[str(n)] = ("交易日历未完整取得" if not target_calendar or not months_complete else
                                     "该日未列入交易日历" if not dates or dates[-1] != target else
                                     f"交易日历中不足 {n} 个历史交易日" if len(dates) < n else
                                     f"缺少 {n - present} 个交易日盘后包" if present < n else None)
        markets = {}
        for market in MARKETS:
            n, valid, up, down, flat = db.execute("""
                SELECT COUNT(*),
                  SUM(CASE WHEN close_1e4>0 AND prev_close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                  SUM(CASE WHEN close_1e4>prev_close_1e4 AND prev_close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                  SUM(CASE WHEN close_1e4<prev_close_1e4 AND close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                  SUM(CASE WHEN close_1e4=prev_close_1e4 AND close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END)
                FROM daily_bar WHERE day=? AND market=?
            """, (target, market)).fetchone()
            markets[market] = {"observed": n, "valid": valid or 0, "up": up or 0, "down": down or 0, "flat": flat or 0}
        widths = width(db, expected)
        for m in (*MARKETS, "all"):
            for n in (20, 60):
                item = widths[m][str(n)]
                if expected[n] is None or not item["eligible"]:
                    if expected[n] is not None and m == "all":
                        window_reason[str(n)] = "没有连续有效的股票日线"
                    item["eligible"] = None
                    item["above"] = None
        series: list[dict] = []
        series_reason: str | None = None
        if target_calendar:
            series_dates = [r[0] for r in db.execute(
                "SELECT day FROM calendar_day WHERE day<=? ORDER BY day DESC LIMIT ?", (target, series_days)
            )][::-1]
            series_months_complete = bool(series_dates) and all(
                db.execute("SELECT 1 FROM calendar_month WHERE month=?", (month,)).fetchone()
                for month in months_between(series_dates[0], target))
            if not series_months_complete:
                series_reason = "交易日历未完整取得，不能确认连续交易日序列"
            for date_str in series_dates if series_months_complete else []:
                aggregate = db.execute("""
                    SELECT COUNT(*),
                      SUM(CASE WHEN close_1e4>0 AND prev_close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                      SUM(CASE WHEN close_1e4>prev_close_1e4 AND prev_close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                      SUM(CASE WHEN close_1e4<prev_close_1e4 AND close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END),
                      SUM(CASE WHEN close_1e4=prev_close_1e4 AND close_1e4>0 AND volume>0 AND amount_fen>0 THEN 1 ELSE 0 END)
                    FROM daily_bar WHERE day=?
                """, (date_str,)).fetchone()
                observed, valid, up, down, flat = aggregate
                series.append({"date": date_str, "status": "ok" if observed else "missing",
                               "observed": observed or None, "valid": valid if observed else None,
                               "up": up if observed else None, "down": down if observed else None,
                               "flat": flat if observed else None})
        else:
            series_reason = "交易日历未完整取得，不能确认连续交易日序列"
        return {"available": True, "date": target, "coverage": {"from": span[0], "to": span[1], "days": span[2]},
                "source": {"name": "通达信盘后包", "archive_sha256": source[0], "rows": source[1]},
                "markets": markets, "width": widths,
                "calendar_status": "ready" if target_calendar else "incomplete",
                "window_complete": {str(n): expected[n] is not None for n in (20, 60)},
                "window_reason": window_reason,
                "series": series, "series_reason": series_reason,
                "notes": ["只统计包中观察到的 A 股，不代表全部应有上市股票", "缺行状态未知；均线要求官方交易日连续且每天有有效记录", "日历或日线不完整时宽度为 null，不视作 0", "价格位置按参考前收盘比率链接，避免除权日直接拼接原价"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("ingest", "query", "replay", "backfill"))
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--store", required=True, type=Path)
    parser.add_argument("--date")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--capture-root", type=Path)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--latest-first", action="store_true")
    args = parser.parse_args()
    if args.mode == "ingest" and not args.date:
        parser.error("ingest requires --date")
    if args.mode == "replay" and not args.capture_root:
        parser.error("replay requires --capture-root")
    if args.mode == "backfill" and not args.date:
        parser.error("backfill requires --date")
    result = (ingest(args.repo_root, args.store, args.date) if args.mode == "ingest"
              else backfill(args.repo_root, args.store, args.date, limit=args.limit,
                            latest_first=args.latest_first) if args.mode == "backfill"
              else replay(args.repo_root, args.store, args.capture_root) if args.mode == "replay"
              else query(args.store, args.date, args.days))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError, sqlite3.Error) as exc:
        print(f"market_history: {exc}", file=sys.stderr)
        sys.exit(2)
    except RequestException as exc:
        print(f"market_history: 上游连接失败({type(exc).__name__})", file=sys.stderr)
        sys.exit(2)
