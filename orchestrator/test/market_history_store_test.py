"""Offline tests for the public market-history service worker."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, timedelta
import calendar
import csv
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from threading import Barrier
from unittest.mock import patch

import pandas as pd
import pytest

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / ".agents/skills/data-access/scripts"))
sys.path.insert(0, str(REPO / "orchestrator/src/finance/shortline"))
import market_history_store as M  # noqa: E402
from sources._http import record_raw  # noqa: E402


def sample_frame(close: float = 11.0, *, include_bj: bool = True) -> pd.DataFrame:
    rows = [
        {"date": "2026-11-20", "market": "sh", "code": "600000", "name": "沪样本", "prev_close": 10.0, "close": close, "volume": 10, "amount": 110.0},
        {"date": "2026-11-20", "market": "sz", "code": "000001", "name": "深样本", "prev_close": 10.0, "close": close, "volume": 10, "amount": 110.0},
    ]
    if include_bj:
        rows.append({"date": "2026-11-20", "market": "bj", "code": "920001", "name": "京样本", "prev_close": 10.0, "close": close, "volume": 10, "amount": 110.0})
    return pd.DataFrame(rows)


def fake_calendar(db: sqlite3.Connection, _store: Path, day: str) -> None:
    with db:
        db.execute("INSERT OR IGNORE INTO calendar_month VALUES ('2026-11','fixture',1)")
        db.execute("INSERT OR IGNORE INTO calendar_day VALUES (?, '2026-11')", (day,))


def test_ingest_revision_and_read(tmp_path: Path) -> None:
    store = tmp_path / "market_history"
    version = [b"PK-fixture-1"]
    frame = [sample_frame()]

    def source(_day: str) -> pd.DataFrame:
        record_raw(version[0], "zip")
        return frame[0]

    with patch.object(M, "tdx_daily_package", source), patch.object(M, "ensure_calendar", fake_calendar):
        first = M.ingest(REPO, store, "2026-11-20")
        assert first["status"] == "inserted"
        assert M.query(store, "2026-11-20")["markets"]["sh"]["up"] == 1
        assert M.ingest(REPO, store, "2026-11-20")["status"] == "unchanged"

        version[0] = b"PK-fixture-2"
        frame[0] = sample_frame(12.0)
        assert M.ingest(REPO, store, "2026-11-20")["status"] == "replaced"
        assert M.query(store, None)["source"]["archive_sha256"] != first["archive_sha256"]

        version[0] = b"PK-fixture-3"
        frame[0] = sample_frame(include_bj=False)
        with pytest.raises(ValueError, match="缺少沪深京"):
            M.ingest(REPO, store, "2026-11-20")
        assert M.query(store, None)["source"]["archive_sha256"] != first["archive_sha256"]
        assert M.query(store, None)["markets"]["bj"]["observed"] == 1


def test_concurrent_first_ingest_keeps_one_archive(tmp_path: Path) -> None:
    day = "2026-11-20"
    content = b"concurrent fixture"
    barrier = Barrier(2, timeout=5)

    def source(_day: str) -> pd.DataFrame:
        record_raw(content, "zip")
        return sample_frame()

    def calendar(year: int, month: int) -> list[str]:
        if month == 11:
            barrier.wait()  # Both requests observed an absent month before downloading.
        record_raw(f"{year}-{month}".encode(), "json")
        return [f"{year}-{month:02d}-20"]

    with patch.object(M, "tdx_daily_package", source), patch.object(M, "_open_days", calendar):
        with ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(M.ingest, REPO, tmp_path, day) for _ in range(2)]
            assert sorted(job.result()["status"] for job in jobs) == ["inserted", "unchanged"]
        with closing(M.open_db(tmp_path / "market.sqlite3", write=False)) as db:
            archive = tmp_path / db.execute("SELECT raw_ref FROM market_day").fetchone()[0]
            assert db.execute("SELECT COUNT(*) FROM calendar_day").fetchone()[0] == 5
            assert db.execute("SELECT COUNT(*) FROM daily_bar").fetchone()[0] == 3
        assert list(tmp_path.rglob("*.zip")) == [archive]
        assert archive.read_bytes() == content

        archive.write_bytes(b"damaged fixture")
        assert M.ingest(REPO, tmp_path, day)["status"] == "unchanged"
        with closing(M.open_db(tmp_path / "market.sqlite3", write=False)) as db:
            repaired = tmp_path / db.execute("SELECT raw_ref FROM market_day").fetchone()[0]
            assert repaired.read_bytes() == content


def test_complete_windows_and_missing_day(tmp_path: Path) -> None:
    store = tmp_path / "market_history"
    with closing(M.open_db(store / "market.sqlite3", write=True)) as db:
        base = date(2026, 1, 1)
        days = [(base + timedelta(days=i)).isoformat() for i in range(60)]
        db.executemany("INSERT INTO calendar_month VALUES (?,'fixture',60)",
                       [(month,) for month in M.months_between(days[0], days[-1])])
        db.executemany("INSERT INTO calendar_day VALUES (?, '2026-01')", [(d,) for d in days])
        for day in days:
            rows = [(day, m, code, m + code, m, 10_0000, 10_1000, 10, 10000)
                    for m, code in (("sh", "600000"), ("sz", "000001"), ("bj", "920001"))]
            M.replace_day(db, day, day, "raw/fixture", rows)
    got = M.query(store, days[-1])
    assert got["window_complete"] == {"20": True, "60": True}
    assert got["width"]["all"]["20"] == {"eligible": 3, "above": 3}
    assert got["width"]["all"]["60"] == {"eligible": 3, "above": 3}
    assert len(got["series"]) == 30
    assert got["series"][-1]["up"] == 3
    with sqlite3.connect(store / "market.sqlite3") as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("DELETE FROM daily_bar WHERE day=?", (days[20],))
        db.execute("DELETE FROM market_day WHERE day=?", (days[20],))
    gap = M.query(store, days[-1])
    assert gap["window_complete"] == {"20": True, "60": False}
    assert gap["window_reason"]["60"] == "缺少 1 个交易日盘后包"
    assert gap["width"]["all"]["60"] == {"eligible": None, "above": None}
    assert M.query(store, days[-1], 60)["series"][20]["status"] == "missing"
    assert M.query(store, "2026-12-31")["available"] is False


def test_bad_date_and_empty_store(tmp_path: Path) -> None:
    assert M.query(tmp_path, None) == {"available": False, "reason": "市场历史数据尚未导入"}
    with pytest.raises(ValueError):
        M.checked_day("2026-02-30")
    with pytest.raises(ValueError, match="未来"):
        M.ingest(REPO, tmp_path, "2999-01-01")


def test_official_calendar_is_captured_and_required(tmp_path: Path) -> None:
    store = tmp_path / "market_history"

    def calendar(year: int, month: int) -> list[str]:
        record_raw(f"{year}-{month}".encode(), "json")
        ym = f"{year:04d}-{month:02d}"
        return ["2026-11-20" if ym == "2026-11" else f"{ym}-01"]

    with patch.object(M, "_open_days", calendar):
        with closing(M.open_db(store / "market.sqlite3", write=True)) as db:
            M.ensure_calendar(db, store, "2026-11-20")
            assert db.execute("SELECT COUNT(*) FROM calendar_month").fetchone()[0] == 5
            assert db.execute("SELECT COUNT(*) FROM calendar_day").fetchone()[0] == 5
            assert len(list((store / "calendar").glob("*/raw/*.json"))) == 5
            with pytest.raises(ValueError, match="不是深交所登记交易日"):
                M.ensure_calendar(db, store, "2026-11-21")


def test_replay_validates_raw_and_is_idempotent(tmp_path: Path) -> None:
    captured = tmp_path / "captured"
    store = tmp_path / "store"
    day = "2026-11-20"
    original = b"PK-replay-fixture"
    raw_dir = captured / day / "raw"
    raw_dir.mkdir(parents=True)
    (raw_dir / "daily.zip").write_bytes(original)
    sha = hashlib.sha256(original).hexdigest()
    with (captured / "archives.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["day", "sha256", "rows"])
        writer.writeheader()
        writer.writerow({"day": day, "sha256": sha, "rows": 3})
    (captured / "calendar.json").write_text(json.dumps([day]))
    cdir = captured / "calendar" / "raw"
    cdir.mkdir(parents=True)
    records = [{"jyrq": f"2026-11-{n:02d}", "jybz": "1" if n == 20 else "0"}
               for n in range(1, calendar.monthrange(2026, 11)[1] + 1)]
    (cdir / "nov.json").write_text(json.dumps({"data": records}))
    with patch.object(M, "_tdx_parse_package", return_value=sample_frame().to_dict("records")) as parse:
        first = M.replay(REPO, store, captured)
        assert first["inserted"] == 1
        assert M.query(store, day)["markets"]["bj"]["observed"] == 1
        second = M.replay(REPO, store, captured)
        assert second["unchanged"] == 1
        assert parse.call_count == 1
    (raw_dir / "daily.zip").write_bytes(b"PK-corrupt")
    with pytest.raises(ValueError, match="哈希不符"):
        M.replay(REPO, store, captured)


def test_backfill_uses_calendar_and_resumes_missing_days(tmp_path: Path) -> None:
    store = tmp_path / "store"
    days = [(date(2026, 8, 1) + timedelta(days=i)).isoformat() for i in range(60)]
    target = days[-1]
    calls: list[str] = []

    def calendar(db: sqlite3.Connection, _store: Path, _day: str) -> None:
        with db:
            for month in M.months_between(days[0], target):
                db.execute("INSERT OR IGNORE INTO calendar_month VALUES (?, 'fixture', 30)", (month,))
            db.executemany("INSERT OR IGNORE INTO calendar_day VALUES (?, ?)",
                           ((day, day[:7]) for day in days))

    def import_day(_repo: Path, path: Path, day: str, *, calendar_ready: bool = False) -> dict:
        assert calendar_ready
        calls.append(day)
        with closing(M.open_db(path / "market.sqlite3", write=True)) as db:
            rows = [(day, market, code, market + code, market, 10000, 10100, 10, 10000)
                    for market, code in (("sh", "600000"), ("sz", "000001"), ("bj", "920001"))]
            M.replace_day(db, day, day, "raw/fixture", rows)
        return {"date": day}

    with patch.object(M, "ensure_calendar", calendar), patch.object(M, "ingest", import_day):
        first = M.backfill(REPO, store, target)
        assert first == {"target": target, "requested_days": 60, "completed": 5,
                         "remaining": 55, "imported": days[:5]}
        second = M.backfill(REPO, store, target)
        assert second["completed"] == 10
        assert second["imported"] == days[5:10]
        for _ in range(10):
            last = M.backfill(REPO, store, target)
        assert last["completed"] == 60 and last["remaining"] == 0
        assert M.backfill(REPO, store, target)["imported"] == []
        assert calls == days

    with pytest.raises(ValueError, match="1–5"):
        M.backfill(REPO, store, target, limit=6)
