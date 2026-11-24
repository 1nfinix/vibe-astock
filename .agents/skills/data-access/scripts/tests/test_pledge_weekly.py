from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sources import pledge_weekly  # noqa: E402


def test_weekly_pledge_uses_complete_rows_and_preserves_missing_fields(monkeypatch):
    days = ["2026-11-20", "2026-11-13"]

    def latest(_report, condition, *_args, **_kwargs):
        return [{"TRADE_DATE": days[0] if not condition else days[1]}]

    def snapshot(*, date):
        values = [10.0, None] if date == days[1] else [10.0, 20.0]
        return pd.DataFrame({
            "date": [date, date], "code": ["600000", "000001"],
            "pledged_shares_10k": [100.0, 200.0],
            "pledged_mktcap_10k": values,
            "pledge_ratio_pct": [49.9, 50.0],
        })

    monkeypatch.setattr(pledge_weekly.pledge_source, "_em_event_rows", latest)
    monkeypatch.setattr(pledge_weekly.pledge_source, "_em_day", lambda value: value)
    monkeypatch.setattr(pledge_weekly.pledge_source, "equity_pledge", snapshot)
    monkeypatch.setattr(pledge_weekly, "official_week", lambda _day: (2, 300.0))
    rows = pledge_weekly.weekly_pledge(weeks=2).to_dict("records")
    assert rows[0]["date"] == "2026-11-13"
    assert pd.isna(rows[0]["pledged_mktcap_10k"])
    assert rows[0]["missing_mktcap"] == 1
    assert rows[1]["pledged_shares_10k"] == 300.0
    assert rows[1]["companies_ratio_ge_50"] == 1
    assert rows[1]["official_new_shares_10k"] == 300.0


def test_weekly_pledge_rejects_invalid_range():
    with pytest.raises(ValueError, match="weeks"):
        pledge_weekly.weekly_pledge(weeks=27)


def test_official_week_matches_its_requested_date(monkeypatch):
    class Response:
        content = b"<table><tr><td>20261113</td><td>380</td><td>279702.13</td></tr></table>"

        def raise_for_status(self):
            pass

    monkeypatch.setattr(pledge_weekly, "http_post", lambda *_args, **_kwargs: Response())
    assert pledge_weekly.official_week("2026-11-13") == (380, 279702.13)
    with pytest.raises(ValueError, match="缺失"):
        pledge_weekly.official_week("2026-11-20")
