"""深交所 ETF 历史份额分页离线测试。"""
import os
import sys
import pytest
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from sources import etf_turnover


def test_history_pages_and_units(monkeypatch):
    calls = []
    class Reply:
        def __init__(self, page): self.page = page
        def raise_for_status(self): pass
        def json(self):
            rows = ([{"fund_code": "159919", "size_date": "2026-11-03", "current_size": "1,395,561.66"},
                     {"fund_code": "159919", "size_date": "2026-11-02", "current_size": "1,200,000"}]
                    if self.page == 1 else [{"fund_code": "159919", "size_date": "2026-11-04", "current_size": "1,405,911.66"}])
            return [{"metadata": {"pagecount": 2, "recordcount": 3, "pagesize": 2}, "data": rows}]
    def fake(_url, **kwargs):
        calls.append(kwargs["params"])
        return Reply(kwargs["params"]["PAGENO"])
    monkeypatch.setattr("sources._http.http_get", fake)
    monkeypatch.setattr("time.sleep", lambda _: None)
    rows = etf_turnover.szse_fund_share_history("159919", "2026-11-01", "2026-11-05")
    assert [r["date"] for r in rows] == ["2026-11-02", "2026-11-03", "2026-11-04"]
    assert rows[1]["shares_yi"] == pytest.approx(139.556166)
    assert [p["PAGENO"] for p in calls] == [1, 2]
    assert all(p["loading"] == "first" for p in calls)


def test_history_count_mismatch_and_code_rejected(monkeypatch):
    class Reply:
        def raise_for_status(self): pass
        def json(self): return [{"metadata": {"pagecount": 1, "recordcount": 2, "pagesize": 20},
                                  "data": [{"fund_code": "159919", "size_date": "2026-11-03", "current_size": "100"}]}]
    monkeypatch.setattr("sources._http.http_get", lambda *_a, **_k: Reply())
    with pytest.raises(RuntimeError, match="自报 2 条"):
        etf_turnover.szse_fund_share_history("159919", "2026-11-01", "2026-11-05")
    with pytest.raises(ValueError, match="159"):
        etf_turnover.szse_fund_share_history("510300", "2026-11-01", "2026-11-05")


def test_history_long_range_is_split_to_bounded_windows(monkeypatch):
    starts = []
    class Reply:
        def __init__(self, day): self.day = day
        def raise_for_status(self): pass
        def json(self): return [{"metadata": {"pagecount": 1, "recordcount": 1, "pagesize": 20},
                                  "data": [{"fund_code": "159919", "size_date": self.day, "current_size": "10,000"}]}]
    def fake(_url, **kwargs):
        day = kwargs["params"]["txtStart"]
        starts.append(day)
        return Reply(day)
    monkeypatch.setattr("sources._http.http_get", fake)
    monkeypatch.setattr("time.sleep", lambda _: None)
    rows = etf_turnover.szse_fund_share_history("159919", "2026-01-01", "2026-04-01")
    assert starts == ["2026-01-01", "2026-03-22"]
    assert len(rows) == 2 and all(r["shares_yi"] == 1 for r in rows)
