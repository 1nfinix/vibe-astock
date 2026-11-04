"""宽基 ETF 取数离线回归。"""
from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from sources import etf_turnover


def bar(day, volume=100_000_000):
    return {"day": day, "open": 2.0, "high": 2.0, "low": 2.0, "close": 2.0, "volume": volume}


def test_baseline_shape_tail_and_missing(monkeypatch):
    pool = [dict(code="510300", tcode="sh510300", name="甲", index="沪深300", group="core", huijin_yi=1),
            dict(code="510310", tcode="sh510310", name="乙", index="沪深300", group="core", huijin_yi=1)]
    monkeypatch.setattr(etf_turnover, "ETF_POOL", pool)
    daily = [bar(f"2026-10-{d:02d}") for d in range(1, 31)]
    five = [bar(f"2026-10-{d:02d} {9 + i // 12:02d}:{(i % 12) * 5:02d}:00", 2_000_000 if i >= 42 else 1_000_000)
            for d in range(1, 21) for i in range(48)]

    def fake(code, scale, _n):
        if code == "510310":
            raise RuntimeError("该只不可用")
        return daily if scale == 240 else five

    monkeypatch.setattr(etf_turnover, "sina_kline", fake)
    got = etf_turnover.build_etf_turnover_baseline("2026-11-04", [])
    first = got["items"][0]
    assert first["avg20_yi"] == 2.0
    assert len(first["hist"]) == 30
    assert len(first["shape"]) == 48
    assert first["shape"][-1] == 1
    assert first["tail_ratio_base"] == round(12 / 54, 6)
    assert got["missing"] == [{"code": "510310", "reason": "该只不可用"}]
    assert got["items"][1]["avg20_yi"] is None


def test_live_missing_does_not_become_zero(monkeypatch):
    monkeypatch.setattr(etf_turnover, "ETF_POOL", etf_turnover.ETF_POOL[:1])
    monkeypatch.setattr(etf_turnover, "tencent_quotes", lambda _codes: {"510300": {"price": 2, "amount_wan": 10000,
        "name": "甲", "shares": 200_000_000, "outer_lots": 60, "inner_lots": 40}})
    got = etf_turnover.build_etf_turnover_live(["588000"])
    assert got["items"][0]["amount_yi"] == 1
    assert got["items"][0]["shares"] == 2
    assert got["items"][1]["amount_yi"] is None
    assert got["missing"][0]["code"] == "588000"


def test_tencent_new_fields_and_short_share_field(monkeypatch):
    from sources import tencent

    class Reply:
        def __init__(self, values):
            self.text = 'v_sh510300="' + "~".join(values) + '";'

        def raise_for_status(self):
            return None

    values = [""] * 73
    values[1], values[3], values[4], values[7], values[8], values[30], values[37], values[72] = (
        "沪深300ETF", "4.175", "4.092", "19850941", "10622976", "20261104150000", "1256222", "44587387700")
    monkeypatch.setattr(tencent, "http_get", lambda *_a, **_k: Reply(values))
    quote = tencent.tencent_quotes(["510300"])["510300"]
    assert (quote["outer_lots"], quote["inner_lots"], quote["shares"]) == (19850941, 10622976, 44587387700)
    monkeypatch.setattr(tencent, "http_get", lambda *_a, **_k: Reply(values[:53]))
    assert tencent.tencent_quotes(["510300"])["510300"]["shares"] is None


def test_fixed_names_and_daily_amount_ohlc4(monkeypatch):
    pool = etf_turnover._pool()
    names = {x["code"]: (x["name"], x["index"]) for x in pool}
    assert names["510300"] == ("沪深300ETF华泰柏瑞", "沪深300")
    assert names["510230"] == ("金融ETF国泰", "上证180金融")
    assert names["159915"] == ("创业板ETF易方达", "创业板指")
    assert names["588000"] == ("科创50ETF华夏", "科创50")
    assert names["159338"] == ("中证A500ETF国泰", "中证A500")
    assert etf_turnover._yi({"volume": 100_000_000, "open": 1, "high": 2, "low": 3, "close": 4}) == 2.5
    monkeypatch.setattr(etf_turnover, "ETF_POOL", etf_turnover.ETF_POOL[:1])
    monkeypatch.setattr(etf_turnover, "tencent_quotes", lambda _codes: {
        "510300": {"name": "腾讯简称", "price": 2, "amount_wan": 10000},
        "588000": {"name": "腾讯观察简称", "price": 2, "amount_wan": 10000},
        "512345": {"name": "新增标的名称", "price": 2, "amount_wan": 10000},
    })
    got = etf_turnover.build_etf_turnover_live(["588000", "512345"])
    assert [x["name"] for x in got["items"]] == ["沪深300ETF华泰柏瑞", "科创50ETF华夏", "新增标的名称"]


def test_baseline_observation_only_does_not_fetch_fixed_pool(monkeypatch):
    calls = []
    daily = [bar(f"2026-10-{d:02d}") for d in range(1, 31)]

    def fake(code, scale, _n):
        calls.append((code, scale))
        return daily if scale == 240 else []

    monkeypatch.setattr(etf_turnover, "sina_kline", fake)
    got = etf_turnover.build_etf_turnover_baseline("2026-11-04", ["588000"], include_core=False)
    assert [item["code"] for item in got["items"]] == ["588000"]
    assert calls == [("588000", 240), ("588000", 5)]
    assert etf_turnover._pool([], include_core=False) == []


def test_friday_tail_uses_friday_48_bars_and_avg_excludes_friday(monkeypatch):
    from datetime import date, timedelta

    monkeypatch.setattr(etf_turnover, "ETF_POOL", etf_turnover.ETF_POOL[:1])
    friday = "2026-10-09"
    days = [(date(2026, 9, 10) + timedelta(days=i)).isoformat() for i in range(30)]
    prior = [day for day in days if date.fromisoformat(day).weekday() < 5 and day < friday][-20:]
    daily = [bar(day, 100_000_000) for day in prior] + [bar(friday, 900_000_000)]
    five = [bar(f"{day} {9 + i // 12:02d}:{(i % 12) * 5:02d}:00", 2_000_000 if day == friday and i >= 42 else 1_000_000)
            for day in [*prior, friday] for i in range(48)]
    assert len(five) == 1008 <= 1023

    def fake(_code, scale, datalen):
        assert datalen == (50 if scale == 240 else 1023)
        return daily if scale == 240 else five

    monkeypatch.setattr(etf_turnover, "sina_kline", fake)
    got = etf_turnover.build_etf_turnover_baseline(friday, [])
    assert got["items"][0]["avg20_yi"] == 2.0
    assert got["items"][0]["tail_ratio"] == round(12 / 54, 6)
    assert got["items"][0]["tail_ratio_base"] == round(6 / 48, 6)
