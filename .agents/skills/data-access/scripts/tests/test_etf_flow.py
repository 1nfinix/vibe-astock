"""ETF 资金页：所有上游响应都以假数据验证。"""
import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from sources import etf_flow, sina


def _bar(day, close=2.0):
    return {"day": day, "open": close, "high": close, "low": close,
            "close": close, "volume": 100_000_000}


def test_sina_one_minute_parses_and_old_scales_still_allowed(monkeypatch):
    calls = []

    class Reply:
        text = '[{"day":"2026-11-05 09:31:00","open":"1","high":"2","low":"1","close":"2","volume":"100"}]'

    def fake(_url, **kwargs):
        calls.append(kwargs["params"])
        return Reply()

    monkeypatch.setattr(sina, "http_get", fake)
    for scale in (1, 5, 240):
        bars = sina.sina_kline("510310", scale, 240)
        assert bars[0]["day"] == "2026-11-05 09:31:00"
        assert bars[0]["volume"] == 100
    assert [x["scale"] for x in calls] == [1, 5, 240]
    with pytest.raises(ValueError):
        sina.sina_kline("510310", 2, 240)


def test_minute_batch_uses_index_day_and_rejects_low_coverage(monkeypatch):
    def fake(code, scale, _n):
        assert scale == 1
        if code == "sh000001":
            return [_bar("2026-11-04 15:00:00", 3000), _bar("2026-11-05 09:31:00", 3100)]
        if code in etf_flow.BASKET[:15]:
            return [_bar("2026-11-04 15:00:00"), _bar("2026-11-05 09:31:00")]
        raise RuntimeError("源失败")

    monkeypatch.setattr(etf_flow, "sina_kline", fake)
    got = etf_flow.cn_etf_minute_batch()
    assert got["date"] == "2026-11-05"
    assert got["success_count"] == 15 and len(got["missing"]) == 5
    assert got["total"]["amount_yi"] is None
    assert "80%" in got["total"]["reason"]
    assert got["items"][etf_flow.BASKET[0]]["amount_yi"] == [2.0]
    assert got["index"]["close"] == [3100]


def test_minute_hist_groups_days_and_rejects_low_coverage(monkeypatch):
    def fake(code, scale, _n):
        assert scale == 5
        if code in etf_flow.BASKET[:15]:
            return [_bar("2026-11-04 09:35:00"), _bar("2026-11-05 09:35:00")]
        raise RuntimeError("源失败")

    monkeypatch.setattr(etf_flow, "sina_kline", fake)
    got = etf_flow.cn_etf_minute_hist()
    assert [x["date"] for x in got["days"]] == ["2026-11-04", "2026-11-05"]
    assert all(x["total"]["amount_yi"] is None for x in got["days"])
    assert all(len(x["missing"]) == 5 for x in got["days"])


def test_exact_eighty_percent_can_sum_but_reports_coverage(monkeypatch):
    def fake(code, scale, _n):
        assert scale == 1
        if code == "sh000001":
            return [_bar("2026-11-05 09:31:00", 3100)]
        if code in etf_flow.BASKET[:16]:
            return [_bar("2026-11-05 09:31:00")]
        raise RuntimeError("源失败")

    monkeypatch.setattr(etf_flow, "sina_kline", fake)
    got = etf_flow.cn_etf_minute_batch()
    assert got["total"]["amount_yi"] == [32.0]
    assert got["total"]["coverage"] == [16]
    assert "16/20" in got["total"]["reason"]
    assert "coverage" not in got["total"]["reason"]


@pytest.mark.parametrize("bad", ["51031", "600519", "1599150", "sh510310", "1599ab", 159915])
def test_extra_codes_must_match_etf_code_re(bad):
    with pytest.raises(ValueError, match="extra_codes"):
        etf_flow.cn_etf_minute_batch([bad])
    with pytest.raises(ValueError, match="extra_codes"):
        etf_flow.cn_etf_minute_hist(extra_codes=[bad])


@pytest.mark.parametrize(("index", "category"), [
    ("沪深300指数", "沪深300"), ("中证1000指数", "中证1000"),
    ("中证500指数", "中证500"), ("科创50指数", "科创50"),
    ("中证A500指数", "中证A500"), ("399006 创业板指", "创业板指"),
    ("上证50指数", "上证50"), ("上证180指数", "其他宽基"),
    ("创业板50指数", "创业板50"), ("双创50指数", "双创50"),
    ("中证2000指数", "中证2000"), ("国证2000指数", "国证2000"),
    ("中证800指数", "其他宽基"), ("深证100指数", "其他宽基"),
    ("上证综合指数", "其他宽基"), ("深证成份指数", "其他宽基"),
    ("上证科创板50成份指数", "科创50"), ("中证小盘500指数", "中证500"),
    ("中证科创创业50指数", "双创50"), ("399300 沪深300", "沪深300"),
    ("中证1000红利低波指数", None), ("中证银行指数", None),
    ("纳斯达克100指数", None), ("中债国债总指数", None),
    ("黄金价格", None), ("红利低波策略指数", None),
])
def test_twelve_categories_and_exclusions(index, category):
    assert etf_flow._category(index) == category


def test_universe_requires_both_sources(monkeypatch):
    monkeypatch.setattr(etf_flow, "_sse_etfs", lambda: [
        {"code": "510300", "name": "300ETF", "index": "沪深300指数", "exchange": "SH"},
        {"code": "588370", "name": "科创50增强ETF", "index": "上证科创板50成份指数", "exchange": "SH"},
    ])
    monkeypatch.setattr(etf_flow, "_szse_etfs", lambda: [{"code": "159915", "name": "创业板ETF", "index": "399006 创业板指", "exchange": "SZ"}])
    got = etf_flow.cn_broad_etf_universe()
    assert got["counts"] == {"沪深300": 1, "创业板指": 1}
    def fail():
        raise RuntimeError("官方接口失败")
    monkeypatch.setattr(etf_flow, "_szse_etfs", fail)
    with pytest.raises(RuntimeError, match="官方接口失败"):
        etf_flow.cn_broad_etf_universe()


def test_exchange_list_parsers_and_new_sse_code_segment(monkeypatch):
    class Reply:
        def __init__(self, payload):
            self.payload = payload
        def raise_for_status(self):
            pass
        def json(self):
            return self.payload

    def fake(url, **_kwargs):
        if "sse.com.cn" in url:
            return Reply({"result": [{"FUND_CODE": "530800", "FUND_EXPANSION_ABBR": "上180ETF",
                                      "INDEX_NAME": "上证180指数", "CATEGORY": "F111"},
                                     {"FUND_CODE": "501001", "FUND_EXPANSION_ABBR": "LOF",
                                      "INDEX_NAME": "沪深300指数", "CATEGORY": "F213"}],
                          "pageHelp": {"total": 2}})
        return Reply([{"metadata": {"pagecount": 1, "recordcount": 1, "subname": "2026-11-05"},
                       "data": [{"sys_key": "<u>159915</u>", "kzjcurl": "<u>创业板ETF</u>",
                                 "nhzs": "399006 创业板指"}]}])

    monkeypatch.setattr(etf_flow, "http_get", fake)
    assert [r["code"] for r in etf_flow._sse_etfs()] == ["530800"]
    assert etf_flow._szse_etfs()[0]["index"] == "399006 创业板指"


def test_sh_share_backfill_keeps_daily_failures(monkeypatch):
    from sources import astock_ported

    class Frame:
        def to_dict(self, _kind):
            return [{"date": "2026-11-05", "code": "510300", "shares_10k": 100}]

    def fake(day, exchange):
        assert exchange == "SH"
        if day == "2026-11-04":
            raise RuntimeError("HTTP 503")
        return Frame()

    monkeypatch.setattr(astock_ported, "etf_shares", fake)
    monkeypatch.setattr(etf_flow.time, "sleep", lambda _s: None)
    got = etf_flow.cn_etf_share_history_sh("2026-11-04", "2026-11-05")
    assert len(got["rows"]) == 1
    assert got["failed"] == [{"date": "2026-11-04", "reason": "HTTP 503"}]
    with pytest.raises(ValueError):
        etf_flow.cn_etf_share_history_sh(date(2026, 11, 5), "2026-11-05")


def test_sh_share_backfill_accepts_calendar_dates(monkeypatch):
    from sources import astock_ported
    seen = []
    class Frame:
        def to_dict(self, _kind): return []
    def fake(day, exchange):
        seen.append(day)
        assert exchange == "SH"
        return Frame()
    monkeypatch.setattr(astock_ported, "etf_shares", fake)
    monkeypatch.setattr(etf_flow.time, "sleep", lambda _s: None)
    got = etf_flow.cn_etf_share_history_sh(dates=["2026-10-09", "2026-10-12"])
    assert seen == got["dates"] == ["2026-10-09", "2026-10-12"]
    with pytest.raises(ValueError, match="工作日"):
        etf_flow.cn_etf_share_history_sh(dates=["2026-10-10"])
    with pytest.raises(ValueError, match="二选一"):
        etf_flow.cn_etf_share_history_sh(start="2026-10-09", dates=["2026-10-09"])


def test_etf_daily_batch_parses_close_and_amount(monkeypatch):
    calls = []
    def fake(code, scale, count):
        calls.append((code, scale, count))
        return [_bar("2026-11-05", 2)]
    monkeypatch.setattr(etf_flow, "sina_kline", fake)
    got = etf_flow.cn_etf_daily_batch(["510300"], include_index=True)
    assert got["items"]["510300"] == [{"date": "2026-11-05", "close": 2, "amount_yi": 2}]
    assert got["index"] == [{"date": "2026-11-05", "close": 2}]
    assert calls == [("510300", 240, 1023), ("sh000001", 240, 1023)]
