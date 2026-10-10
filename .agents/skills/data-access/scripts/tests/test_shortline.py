"""短线情绪的计算型端点(cn_shortline_emotion / cn_shortline_cycle / cn_shortline_facts / cn_shortline_daily)。全程不联网。

行为沿用 Vibe AStock v2.0.0 的测试(test_core_logic.py 里情绪指标 / 盘面事实那几组),改成本仓库的行形状;
另加三处本仓库的修正:主板 ST 按 2026-07-06 起 10%、分制度表不漏没有涨停的制度、炸板池取不到整天不算。
"""
from __future__ import annotations

import json
import os

import pytest

from test_registry_sources import _ctx
from sources import mappers_shortline as M
from sources import shortline as S
from sources import shortline_emotion as E
from sources import shortline_facts as F
from sources._http import DataNotAvailable

REGISTRY = os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "datasources", "registry.json")


def _mctx(ep_id: str, **kw):
    return _ctx(symbol="MARKET", market="CN", source="eastmoney+calc", ep={"id": ep_id}, **kw)


def _zt(code: str, boards: int = 1, *, name: str = "", sector: str = "甲", first: str = "093000", last: str = "",
        broken: int = 0, ret: float = 10.0) -> dict:
    return {"code": code, "name": name or f"股{code}", "board": S.board_of(code, name), "ret": ret, "boards": boards,
            "sector": sector, "first_seal": first, "last_seal": last or first, "broken_times": broken, "turnover": 5.0}


def _zb(code: str, *, name: str = "", sector: str = "甲", broken: int = 1, ret: float = 3.0) -> dict:
    return {"code": code, "name": name or f"股{code}", "board": S.board_of(code, name), "ret": ret, "sector": sector,
            "first_seal": "100000", "broken_times": broken, "turnover": 8.0}


def _dt(code: str, *, name: str = "", consec: int = 1) -> dict:
    return {"code": code, "name": name or f"股{code}", "board": S.board_of(code, name), "ret": -10.0, "sector": "乙",
            "consec_dt": consec, "turnover": 3.0}


# ================================================================ 涨跌幅制度
class TestLimitRules:
    def test_board_and_limit_pct(self):
        assert S.board_of("600000") == "10cm" and S.limit_pct("600000") == 10.0
        assert S.board_of("300750") == "20cm" and S.limit_pct("300750") == 20.0
        assert S.board_of("688981") == "20cm" and S.board_of("689009") == "20cm"
        for c in ("430047", "830799", "870508", "889999", "920627"):
            assert S.board_of(c) == "北交所" and S.limit_pct(c) == 30.0, c
        # 创业板 / 科创板 ST 也是 20%
        assert S.board_of("300001", "*ST甲") == "20cm(ST)" and S.limit_pct("300001", "*ST甲") == 20.0

    def test_main_board_st_switches_to_10pct_on_2026_07_06(self):
        """2026 修订的交易规则 7 月 6 日起施行:主板 ST 涨跌幅 5% → 10%。VA 原版一律 5%。"""
        assert S.limit_pct("600001", "ST甲", "2026-07-03") == 5.0
        assert S.limit_pct("600001", "ST甲", "2026-07-06") == 10.0
        assert S.limit_pct("600001", "ST甲") == 10.0      # 不给日期 = 现行规则

    def test_chinext_was_10pct_before_2020_08_24(self):
        assert S.limit_pct("300750", "", "2020-08-21") == 10.0
        assert S.limit_pct("300750", "", "2020-08-24") == 20.0
        assert S.limit_pct("688981", "", "2020-08-21") == 20.0   # 科创板一开板就是 20%

    def test_fullwidth_st_is_recognized(self):
        """东财名称里有全角字符(实测「张  裕Ａ」),全角 ＳＴ 不能漏。"""
        assert S.board_of("600002", "ＳＴ乙") == "主板ST"

    def test_limit_up_prefers_actual_limit_price(self):
        # 涨 9.6% 但收在涨停价(四舍五入的票)→ 算涨停;涨 9.9% 但没收在涨停价 → 不算
        assert S.is_limit_up_row({"code": "600000", "ret": 9.6, "close": 10.96, "limit_price": 10.96}) is True
        assert S.is_limit_up_row({"code": "600000", "ret": 9.9, "close": 10.98, "limit_price": 11.0}) is False

    def test_limit_up_by_regime_when_price_missing(self):
        assert S.is_limit_up_row({"code": "300750", "ret": 15.0}) is False, "20cm 涨 15% 不是涨停"
        assert S.is_limit_up_row({"code": "300750", "ret": 19.9}) is True
        assert S.is_limit_up_row({"code": "600001", "name": "ST甲", "ret": 5.0}, "2026-07-03") is True
        assert S.is_limit_up_row({"code": "600001", "name": "ST甲", "ret": 5.0}, "2026-10-09") is False
        assert S.is_limit_up_row({"code": "600000"}) is None, "没有涨跌幅就是不知道"

    def test_limit_down_by_regime(self):
        assert not S.is_limit_down_row({"code": "300750", "ret": -12.0}), "20cm 跌 12% 不是跌停"
        assert S.is_limit_down_row({"code": "300750", "ret": -20.0})
        assert S.is_limit_down_row({"code": "600000", "ret": -10.0})
        assert S.is_limit_down_row({"code": "600001", "name": "ST甲", "ret": -5.0}, "2026-07-03")
        assert not S.is_limit_down_row({"code": "600001", "name": "ST甲", "ret": -5.0}, "2026-10-09")
        assert not S.is_limit_down_row({"code": "600000"})


class TestBoardLabel:
    """反包票要写「N天M板」,不能被东财连板数 = 1 抹成「1板」(欢瑞世纪 2026-07-31)。两种写法都认。"""

    def test_fanbao_uses_zt_stat(self):
        assert S.board_label(1, "3天2板") == "3天2板"
        assert S.board_label(1, "3/2") == "3天2板"
        assert S.board_label(1, "4/2") == "4天2板"

    def test_normal_consec_uses_boards(self):
        assert S.board_label(3, "3天3板") == "3板"
        assert S.board_label(9, "9/9") == "9板"
        assert S.board_label(2, None) == "2板"
        assert S.board_label(1, "") == "1板"

    def test_garbage_stat_falls_back(self):
        assert S.board_label(2, "乱码") == "2板"
        assert S.stat_boards("3天2板") == 2 and S.stat_boards("3/2") == 2
        assert S.stat_boards(None) == 0


# ================================================================ 交易日与「收没收盘」
class TestSessionDates:
    @staticmethod
    def _today(monkeypatch, today: str, hm: tuple[int, int], trade_day: bool = True):
        import datetime as _dt
        monkeypatch.setattr(S, "today_sh", lambda: today)
        monkeypatch.setattr(S, "now_sh", lambda: _dt.datetime(int(today[:4]), int(today[5:7]), int(today[8:]), *hm, tzinfo=S.TZ_SH))
        monkeypatch.setattr(S, "is_trade_day", lambda d: trade_day if S.iso(d) == today else True)
        monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08" if S.iso(d) == "2026-10-09" else "2026-10-09")

    def test_settled_rules(self, monkeypatch):
        self._today(monkeypatch, "2026-10-09", (15, 6))
        assert S.is_settled("2026-10-08")
        assert S.is_settled("2026-10-09")
        assert not S.is_settled("2026-10-12")
        self._today(monkeypatch, "2026-10-09", (14, 0))
        assert not S.is_settled("2026-10-09"), "盘中数据还会变"

    def test_review_day_defaults_to_last_settled_session(self, monkeypatch):
        self._today(monkeypatch, "2026-10-12", (10, 30))
        assert S.review_day(None) == "2026-10-09", "盘中不拿半天的数冒充复盘"
        self._today(monkeypatch, "2026-10-12", (15, 30))
        assert S.review_day("") == "2026-10-12"

    def test_review_day_rejects_future_and_non_trading_days(self, monkeypatch):
        """上游对这两种返回空池,下游会如实算出「涨停 0 家」,读起来像真实行情。"""
        self._today(monkeypatch, "2026-10-09", (16, 0))
        with pytest.raises(ValueError):
            S.review_day("20261012")
        monkeypatch.setattr(S, "is_trade_day", lambda d: False)
        with pytest.raises(DataNotAvailable):
            S.review_day("2026-10-04")

    def test_live_quotes_refused_for_unsettled_and_older_sessions(self, monkeypatch):
        self._today(monkeypatch, "2026-10-09", (14, 0))
        ok, why = S.live_quotes_are_close_of("2026-10-09")
        assert not ok and "还没收盘" in why
        self._today(monkeypatch, "2026-10-12", (10, 0))
        ok, why = S.live_quotes_are_close_of("2026-10-08")
        assert not ok and "不能冒充历史收盘" in why

    def test_live_gate_docstring_points_at_settled_path(self):
        """它的拒绝理由不能读成「整块不可用」:已收盘场次走定稿记录照样能算。"""
        assert "定稿记录" in (S.live_quotes_are_close_of.__doc__ or "")


# ================================================================ 东财原始行 → 统一行
class TestRows:
    def test_raw_pool_rows(self, monkeypatch):
        raw = {
            "getTopicZTPool": [{"c": "600825", "n": "新华传媒", "p": 8800, "zdp": 10.012, "hs": 4.7, "amount": 1e9, "ltsz": 9e9, "fund": 2e8,
                                "fbt": 92500, "lbt": 92500, "zbc": 0, "lbc": 9, "hybk": "出版", "zttj": {"days": 9, "ct": 9}},
                               {"c": "", "n": "空代码行"}],
            "getTopicZBPool": [{"c": "920627", "n": "力王股份", "p": 12340, "zdp": 24.1, "ztp": 12900, "fbt": 105812, "zbc": 2, "zf": 30.0, "hybk": "电池"}],
            "getTopicDTPool": [{"c": "603073", "n": "彩蝶实业", "p": 9000, "zdp": -10.01, "fund": 1e7, "lbt": 0, "days": 2, "oc": 1}],
        }
        S._POOL.clear()
        monkeypatch.setattr(S.em, "_em_zt_api", lambda api, sort, d: raw[api])
        try:
            zt, zb, dt = S.pool("zt", "20261009"), S.pool("zb", "2026-10-09"), S.pool("dt", "20261009")
        finally:
            S._POOL.clear()
        assert len(zt) == 1, "空代码行要丢掉"
        r = zt[0]
        assert r["close"] == 8.8 and r["ret"] == 10.012 and r["boards"] == 9 and r["zt_stat"] == "9天9板"
        assert r["first_seal"] == "092500" and r["sector"] == "出版" and r["board"] == "10cm"
        assert zb[0]["board"] == "北交所" and zb[0]["limit_price"] == 12.9 and zb[0]["broken_times"] == 2
        assert dt[0]["consec_dt"] == 2 and dt[0]["last_seal"] == "", "封板时间 0 = 没有"

    def test_pools_never_turn_a_failure_into_an_empty_table(self, monkeypatch):
        def boom(kind, day):
            if kind == "zb":
                raise ConnectionError("炸板池断了")
            return [_zt("600000")]
        monkeypatch.setattr(S, "pool", boom)
        assert S.pools("2026-10-09") is None
        monkeypatch.setattr(S, "pool", lambda kind, day: [])
        assert S.pools("2026-10-09") is None, "涨停池空 = 非交易日或数据还没出,不是「0 家涨停」"


# ================================================================ 情绪四项
def _settled_rows() -> list[dict]:
    """3 只:首板涨、2 板跌 6.5%、3 板封板。够覆盖分档与四种结果。"""
    return [
        {"code": "000001", "name": "甲", "board": "10cm", "ret": 3.2, "prev_boards": 1, "close": 10.3, "limit_price": 11.0, "sector": "甲行业"},
        {"code": "000002", "name": "乙", "board": "10cm", "ret": -6.5, "prev_boards": 2, "close": 9.35, "limit_price": 11.0, "sector": "乙行业"},
        {"code": "000003", "name": "丙", "board": "10cm", "ret": 10.0, "prev_boards": 3, "close": 11.0, "limit_price": 11.0, "sector": "丙行业"},
    ]


@pytest.fixture
def settled(monkeypatch):
    """定稿记录可取;同时把实时那条路堵死 —— 证明结果真来自定稿。"""
    monkeypatch.setattr(S, "settled_pool", lambda d: _settled_rows())
    monkeypatch.setattr(S, "zt_pool", lambda d: [_zt("000003", 4)])
    monkeypatch.setattr(S, "pools", lambda d: {"zt": [_zt("000003", 4)], "zb": [], "dt": []})
    monkeypatch.setattr(S, "live_quotes_are_close_of", lambda d: (False, "实时行情属于别的场次"))
    monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-07-28")
    monkeypatch.setattr(S, "batch_pct", lambda *a, **k: pytest.fail("定稿路径不该去拉实时行情"))


class TestEmotion:
    def test_money_effect_works_for_a_past_session(self, settled):
        r = E.money_effect("2026-07-29")
        assert r["available"] is True and r["source"] == "settled"
        assert r["sample"] == 3 and r["median"] == 3.2
        assert r["limit_up_again_rate"] == round(1 / 3, 3), "丙在今天的涨停池里"

    def test_consec_premium_only_counts_two_boards_and_up(self, settled):
        r = E.consec_premium("2026-07-29")
        assert r["available"] is True and r["source"] == "settled" and r["sample"] == 2

    def test_no_settled_record_falls_back_to_the_live_gate(self, monkeypatch):
        """定稿记录取不到时走实时那条路,连同它的拒绝理由,不静默出错。"""
        monkeypatch.setattr(S, "settled_pool", lambda d: None)
        monkeypatch.setattr(S, "live_quotes_are_close_of", lambda d: (False, "轮到实时那条路了"))
        monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-07-28")
        r = E.money_effect("2026-07-29")
        assert r["available"] is False and r["reason"] == "轮到实时那条路了"

    def test_live_fallback_low_coverage_is_refused(self, monkeypatch):
        """数据源半死不活时只回来几只票:拿 3 只冒充全体赚钱效应,数字看着完全正常。"""
        monkeypatch.setattr(S, "settled_pool", lambda d: None)
        monkeypatch.setattr(S, "live_quotes_are_close_of", lambda d: (True, ""))
        monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-07-28")
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt(f"6000{i:02d}") for i in range(10)])
        monkeypatch.setattr(S, "batch_pct", lambda codes, d, **k: {c: 1.0 for c in list(codes)[:3]})
        r = E.money_effect("2026-07-29")
        assert r["available"] is False and "3/10" in r["reason"]

    def test_coverage_gate(self):
        assert E.coverage([1.0] * 50, 50)["partial"] is False
        c = E.coverage([1.0] * 30, 50)
        assert c["partial"] is True and c["sample"] == 30 and c["expected_sample"] == 50
        note = E._cov_note({"partial": True, "sample": 3, "expected_sample": 50})
        assert "3/50" in note and "样本不全" in note
        assert E._cov_note({"partial": False}) == ""

    def test_promotion_rates(self, monkeypatch):
        prev = [_zt("600001", 1), _zt("600002", 1), _zt("600003", 2), _zt("600004", 5)]
        today = [_zt("600001", 2), _zt("600004", 6), _zt("600009", 1)]
        monkeypatch.setattr(S, "zt_pool", lambda d: prev if d == "2026-10-08" else today)
        r = E.promotion_rates("2026-10-09", "2026-10-08")
        assert r["tiers"]["1进2"] == {"base": 2, "promoted": 1, "rate": 0.5}
        assert r["tiers"]["2进3"] == {"base": 1, "promoted": 0, "rate": 0.0}
        assert r["tiers"]["3板以上晋级"]["promoted"] == 1
        assert r["overall"] == {"base": 4, "promoted": 2, "rate": 0.5}
        assert r["limit_up_count"] == 3 and r["prev_limit_up_count"] == 4

    def test_ladder_gap_direction(self, monkeypatch):
        """有 5 板和 2 板、缺 3-4 板 = 最高标**下方**断层;写成「上方悬空」是把信号说反了。"""
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt(f"60000{i}", b) for i, b in enumerate([5, 2, 2, 2])])
        r = E.ladder_gap("2026-10-09")
        assert r["continuous"] is False and r["gaps"] == [3, 4]
        assert "下方" in r["note"] and "上方" not in r["note"] and "承接" in r["note"]

    def test_ladder_continuous_and_empty(self, monkeypatch):
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt(f"60000{i}", b) for i, b in enumerate([4, 4, 3, 2, 2])])
        r = E.ladder_gap("2026-10-09")
        assert r["continuous"] is True and r["gaps"] == [] and r["highest"] == 4
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt("600000", 1)])
        assert E.ladder_gap("2026-10-09")["tiers"] == {}
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        assert E.ladder_gap("2026-10-09")["available"] is False

    def test_day_without_broken_pool_is_dropped_not_zeroed(self, monkeypatch):
        """VA 原来炸板池失败时按 0 家算,炸板率写成 0%,看着是情绪最好的一天。"""
        def pool(kind, day):
            if kind == "zb":
                raise ConnectionError("断了")
            return [_zt("600000", 2)]
        monkeypatch.setattr(S, "pool", pool)
        assert E.day_summary("2026-10-09") is None

    def test_cycle_window_ends_at_target_date(self, monkeypatch):
        window = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]
        calls = []
        monkeypatch.setattr(S, "trade_dates_ending_at", lambda end, n=10: calls.append(end) or window)
        monkeypatch.setattr(E, "day_summary", lambda d: {"limit_up": 30 + window.index(d) * 10, "highest_consec": 3, "broken_rate": 0.2})
        r = E.cycle_position("2026-06-05", lookback=5)
        assert calls == ["2026-06-05"], "窗口必须以目标日为终点取"
        assert r["available"] and r["trough_date"] == "2026-06-01" and r["day_n"] == 5
        assert r["current_date"] == "2026-06-05" and r["trend"] == "连续两日走强"
        assert "到 2026-06-05 是第 5 天" in E.render_cycle(r)

    def test_cycle_needs_three_days(self, monkeypatch):
        monkeypatch.setattr(S, "trade_dates_ending_at", lambda end, n=10: ["2026-06-04", "2026-06-05"])
        assert E.cycle_position("2026-06-05")["available"] is False

    def test_lookback_is_bounded(self, monkeypatch):
        monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
        with pytest.raises(ValueError):
            E.build_cycle("2026-10-09", lookback=60)


# ================================================================ 六张事实表
class TestFacts:
    def test_loss_effect_says_what_it_cannot_cover(self, settled):
        r = F.loss_effect("2026-07-29")
        assert r["available"] is True and r["source"] == "settled"
        assert r["deep_loss_5_count"] == 1 and r["worst"] == -6.5
        # 覆盖不到的要给 None 并说明,不能默默当成 0
        assert r["prev_broken_recovery"] is None and r["market_limit_down"] == 0
        assert "未覆盖" in r["note"]

    def test_feedback_matrix_buckets_by_prev_boards(self, settled):
        r = F.feedback_matrix("2026-07-29")
        assert r["available"] is True and r["source"] == "settled"
        assert set(r["matrix"]) == {"首板", "2板", "3板"}
        assert r["matrix"]["3板"]["晋级涨停"] == 1
        assert r["matrix"]["2板"]["跌超5%"] == 1
        assert r["matrix"]["首板"]["收红"] == 1 and r["matrix"]["首板"]["晋级率"] == 0.0
        assert "炸板" in r["note"], "缺的那一档要说出来"

    def test_by_board_counts_regimes_without_limit_ups(self, monkeypatch):
        """VA 原版只给当天有涨停的制度数炸板 / 跌停:2026-10-09 北交所 0 涨停、1 炸板,被写成 0 炸板。"""
        today = {"zt": [_zt("600000", 2), _zt("300750", 1)], "zb": [_zb("920627"), _zb("600100")], "dt": [_dt("600200", name="ST丙")]}
        monkeypatch.setattr(S, "pools", lambda d: today)
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt("600000", 1), _zt("920001", 1)])
        r = F.by_board("2026-10-09", "2026-10-08")
        b = r["boards"]
        assert b["北交所"]["broken"] == 1 and b["北交所"]["limit_up"] == 0 and b["北交所"]["prev_base"] == 1
        assert b["主板ST"]["limit_down"] == 1, "只有跌停的制度也要出现"
        assert b["10cm"]["promoted"] == 1 and b["10cm"]["promotion_rate"] == 1.0
        assert r["prev_available"] is True and "10%" in r["note"]

    def test_by_board_says_when_prev_pool_is_missing(self, monkeypatch):
        monkeypatch.setattr(S, "pools", lambda d: {"zt": [_zt("600000")], "zb": [], "dt": []})
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        r = F.by_board("2026-10-09", "2026-10-08")
        assert r["prev_available"] is False and "晋级未算" in r["note"]
        assert r["boards"]["10cm"]["promotion_rate"] is None

    def test_events_and_themes(self, monkeypatch):
        today = {"zt": [_zt("600001", 5, sector="电池", first="092500"), _zt("600002", 1, sector="电池", first="101500", broken=3),
                        _zt("600003", 1, sector="出版", first="140100")],
                 "zb": [_zb("600010", sector="电池"), _zb("600011", sector="其他")], "dt": [_dt("600020")]}
        monkeypatch.setattr(S, "pools", lambda d: today)
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt("600001", 4), _zt("600010", 3), _zt("600020", 2)])
        ev = F.event_ledger("2026-10-09", "2026-10-08")
        tags = {(e["tag"], e["code"]) for e in ev["events"]}
        assert ("最高标", "600001") in tags and ("反复开板", "600002") in tags
        assert ("高位断板", "600010") in tags, "昨天 3 板今天炸板未回封"
        assert ("高标跌停", "600020") in tags and ("炸板", "600011") in tags
        assert {e["code"] for e in ev["split_events"]} == {"600002"}
        th = F.theme_structure("2026-10-09")
        top = th["themes"][0]
        assert top["sector"] == "电池" and top["limit_up"] == 2 and top["broken"] == 1 and top["broken_rate"] == round(1 / 3, 3)
        assert th["theme_count"] == 2 and th["concentration"] == round(2 / 3, 3)
        assert [s["count"] for s in th["timeline"]] == [1, 0, 1, 0, 1]

    def test_render_facts_names_every_block(self, settled):
        facts = {"date": "2026-07-29", "prev_date": "2026-07-28", "seal_quality": {"available": False, "reason": "池子没取到"},
                 "loss_effect": F.loss_effect("2026-07-29"), "feedback": F.feedback_matrix("2026-07-29"),
                 "themes": {"available": False}, "events": {"available": False}, "by_board": {"available": False}}
        text = F.render_facts(facts)
        assert "封板质量：不可用（池子没取到）" in text and "亏钱效应" in text and "首板 1 只" in text


# ================================================================ 每日六项读数
@pytest.fixture
def daily(monkeypatch):
    """10-09:今天 3 只涨停(最高 4 板)、1 只炸板;昨天 3 只首板 + 1 只 2 板;定稿记录 3 只。"""
    today = [_zt("000003", 4), _zt("600001", 2), _zt("600009", 1)]
    prev = [_zt("600001", 1), _zt("600002", 1), _zt("600005", 1), _zt("000003", 3)]
    pools = {("zt", "2026-10-09"): today, ("zb", "2026-10-09"): [_zb("600010")]}
    monkeypatch.setattr(S, "pool", lambda kind, day: pools[(kind, day)])
    monkeypatch.setattr(S, "zt_pool", lambda d: prev if d == "2026-10-08" else today)
    monkeypatch.setattr(S, "settled_pool", lambda d: _settled_rows())
    monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08")
    monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
    monkeypatch.setattr(S, "is_settled", lambda d: True)
    return pools


class TestDaily:
    def test_six_readings(self, daily):
        r = E.daily_readings("2026-10-09")
        assert (r["limit_up"], r["highest_board"], r["broken_rate"]) == (3, 4, 0.25)
        assert (r["money_effect"], r["deep_loss"], r["sample"]) == (3.2, 1, 3), "跌超 5% 只有乙(−6.5%)"
        assert (r["promotion_1to2"], r["promotion_base"], r["promotion_promoted"]) == (0.333, 3, 1)
        assert r["reasons"] == {}

    def test_promotion_is_the_same_number_as_the_emotion_block(self, daily):
        """昨天的首板不在今天的「昨日涨停池」里(10-08 的新亚制程就是这样):VA 旧版把它从分母里拿掉,
        情绪四项按涨停池成员算它没晋级 —— 同一页上不能出现两个 1进2。"""
        r = E.daily_readings("2026-10-09")
        tier = E.promotion_rates("2026-10-09")["tiers"]["1进2"]
        assert (r["promotion_1to2"], r["promotion_base"]) == (tier["rate"], tier["base"])

    def test_each_reading_can_be_missing_without_zeroing(self, daily, monkeypatch):
        def no_zb(kind, day):
            if kind == "zb":
                raise RuntimeError("HTTP 502")
            return daily[(kind, day)]
        monkeypatch.setattr(S, "pool", no_zb)
        monkeypatch.setattr(S, "settled_pool", lambda d: None)
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        r = E.daily_readings("2026-10-09")
        for k in ("limit_up", "highest_board", "broken_rate", "money_effect", "deep_loss", "promotion_1to2"):
            assert r[k] is None, f"{k} 取不到要写 None,不能是 0"
        assert set(r["reasons"]) == {"summary", "settled", "promotion"}

    def test_no_first_board_yesterday_is_not_a_zero_rate(self, daily, monkeypatch):
        monkeypatch.setattr(S, "zt_pool", lambda d: [_zt("000003", 3)] if d == "2026-10-08" else [_zt("000003", 4)])
        r = E.daily_readings("2026-10-09")
        assert r["promotion_1to2"] is None and r["reasons"]["promotion"] == "前一交易日没有首板"

    def test_mapper_uses_the_emotion_field_names(self, daily):
        d = M.shortline_daily_map(E.build_daily("2026-10-09"), _mctx("cn_shortline_daily"))
        assert d.get("status") is None and not d["missing"]
        got = {(e["field"], e.get("record_key")): e["value"] for e in d["evidence"]}
        assert got[("limit_up_count", None)] == 3 and got[("ladder_highest", None)] == 4
        assert got[("broken_rate", None)] == 0.25 and got[("loss_deep5_count", None)] == 1
        emo = M.shortline_emotion_map(E.build_metrics("2026-10-09"), _mctx("cn_shortline_emotion"))
        same = {(e["field"], e.get("record_key")): e["value"] for e in emo["evidence"] if e["period"] == "2026-10-09"}
        for k in (("limit_up_count", None), ("promotion_rate", "1进2"), ("money_effect_median_ret", None), ("ladder_highest", None)):
            assert got[k] == same[k], f"{k} 两个端点同一天必须是同一个数"
        assert "1进2 33%" in d["extra"]["text"]

    def test_mapper_missing_unsettled_and_empty(self, daily, monkeypatch):
        monkeypatch.setattr(S, "settled_pool", lambda d: None)
        r = M.shortline_daily_map(E.build_daily("2026-10-09"), _mctx("cn_shortline_daily"))
        assert r["status"] == "partial" and [m["field"] for m in r["missing"]] == ["money_effect_median_ret"]
        assert "未取到" in r["extra"]["text"]
        monkeypatch.setattr(S, "is_settled", lambda d: False)
        r = M.shortline_daily_map(E.build_daily("2026-10-09"), _mctx("cn_shortline_daily"))
        assert r["status"] == "partial" and "不缓存" in r["degraded"]
        monkeypatch.setattr(S, "pool", lambda kind, day: [])
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        r = M.shortline_daily_map(E.build_daily("2026-10-09"), _mctx("cn_shortline_daily"))
        assert r["status"] == "failed" and not r["evidence"] and len(r["missing"]) == 3


# ================================================================ 映射成证据
def _metrics(**over) -> dict:
    m = {"date": "2026-10-09", "prev_date": "2026-10-08", "settled": True,
         "money_effect": {"available": True, "sample": 43, "coverage_rate": 1.0, "partial": False, "avg": 3.11, "median": 1.95,
                          "positive_rate": 0.628, "limit_up_again_rate": 0.279, "source": "settled"},
         "promotion": {"available": True, "tiers": {"1进2": {"base": 33, "promoted": 8, "rate": 0.242}, "2进3": {"base": 3, "promoted": 0, "rate": 0.0},
                                                    "3板以上晋级": {"base": 7, "promoted": 4, "rate": 0.571}},
                       "overall": {"base": 43, "promoted": 12, "rate": 0.279}, "limit_up_count": 69, "prev_limit_up_count": 43},
         "consec_premium": {"available": True, "sample": 10, "avg": 3.89, "median": 5.86, "positive_rate": 0.7, "source": "settled"},
         "ladder_gap": {"available": True, "highest": 9, "tiers": {"9": 1, "2": 8}, "gaps": [3, 4, 5, 6, 7, 8], "continuous": False, "note": "板位缺档"}}
    m.update(over)
    return m


class TestMappers:
    def test_emotion_evidence_shape(self):
        r = M.shortline_emotion_map(_metrics(), _mctx("cn_shortline_emotion"))
        assert r.get("status") is None and not r["missing"]
        evs = r["evidence"]
        assert len({e["id"] for e in evs}) == len(evs), "同名证据必须靠 record_key 区分"
        rate = next(e for e in evs if e["field"] == "promotion_rate" and e["record_key"] == "1进2")
        assert rate["value"] == 0.242 and rate["unit"] == "小数", "比例按小数入证据,数字闸门对「24%」按比例比"
        assert next(e for e in evs if e["field"] == "money_effect_avg_ret")["unit"] == "%"
        lu = [e for e in evs if e["field"] == "limit_up_count"]
        assert {(e["period"], e["value"]) for e in lu} == {("2026-10-09", 69), ("2026-10-08", 43)}
        assert "晋级率：1进2 8/33（24%）" in r["extra"]["text"]

    def test_unsettled_day_is_partial_so_it_is_never_cached(self):
        """取数服务只缓存 exit 0 的结果:盘中算出来的数若被缓存住,晚上打开还是下午两点的样子。"""
        r = M.shortline_emotion_map(_metrics(settled=False), _mctx("cn_shortline_emotion"))
        assert r["status"] == "partial" and "不缓存" in r["degraded"]

    def test_unavailable_block_becomes_missing(self):
        r = M.shortline_emotion_map(_metrics(consec_premium={"available": False, "reason": "昨日无 2 板以上个股"}), _mctx("cn_shortline_emotion"))
        assert r["status"] == "partial"
        assert r["missing"] == [{"field": "consec_premium", "period": "2026-10-09", "reason": "昨日无 2 板以上个股"}]

    def test_partial_coverage_is_named(self):
        me = dict(_metrics()["money_effect"], partial=True, sample=30, expected_sample=50)
        r = M.shortline_emotion_map(_metrics(money_effect=me), _mctx("cn_shortline_emotion"))
        assert r["status"] == "partial" and "30/50" in r["degraded"]

    def test_nothing_available_fails(self):
        na = {"available": False, "reason": "涨停池取数失败"}
        r = M.shortline_emotion_map(_metrics(money_effect=na, promotion=na, consec_premium=na, ladder_gap=na), _mctx("cn_shortline_emotion"))
        assert r["status"] == "failed" and not r["evidence"] and len(r["missing"]) == 4

    def test_cycle_flags_a_missing_target_day(self):
        series = [{"date": d, "limit_up": 50, "highest_consec": 3, "broken_rate": 0.2, "score": 0.5} for d in ("2026-10-07", "2026-10-08")]
        cy = {"available": True, "window": 2, "requested_window": 10, "trough_date": "2026-10-07", "trough_score": 0.5, "current_score": 0.5,
              "current_date": "2026-10-08", "day_n": 2, "trend": "样本不足", "pctile": None, "series": series}
        r = M.shortline_cycle_map({"date": "2026-10-09", "settled": True, "cycle": cy}, _mctx("cn_shortline_cycle", args={"lookback": 10}))
        assert r["status"] == "partial"
        assert "截至 2026-10-08" in r["degraded"] and "2/10" in r["degraded"]
        per = {e["period"] for e in r["evidence"] if e["field"] == "cycle_current_score"}
        assert per == {"2026-10-07..2026-10-08"}
        assert len({e["id"] for e in r["evidence"]}) == len(r["evidence"])

    def test_facts_evidence_ids_unique_and_prev_gap_named(self, monkeypatch):
        today = {"zt": [_zt("600001", 2), _zt("600002", 1)], "zb": [_zb("920627")], "dt": [_dt("600020")]}
        monkeypatch.setattr(S, "pools", lambda d: today)
        monkeypatch.setattr(S, "zt_pool", lambda d: None)
        monkeypatch.setattr(S, "settled_pool", lambda d: None)
        monkeypatch.setattr(S, "live_quotes_are_close_of", lambda d: (False, "实时行情属于别的场次"))
        monkeypatch.setattr(S, "review_day", lambda d: "2026-10-09")
        monkeypatch.setattr(S, "prev_trade_date", lambda d: "2026-10-08")
        monkeypatch.setattr(S, "is_settled", lambda d: True)
        r = M.shortline_facts_map(F.build_facts("2026-10-09"), _mctx("cn_shortline_facts"))
        evs = r["evidence"]
        assert len({e["id"] for e in evs}) == len(evs)
        assert r["status"] == "partial"
        fields = {m["field"] for m in r["missing"]}
        assert {"loss_effect", "feedback", "board_promotion_rate"} <= fields
        leaked = [e for e in evs if e["field"] in ("board_promotion_rate", "board_prev_base", "board_promoted")]
        assert not leaked, "前一天的池子没取到,不能写成「前一天 0 只涨停、晋级 0 只」"


def test_registry_entries_resolve():
    reg = json.load(open(REGISTRY, encoding="utf-8"))
    by_id = {e["id"]: e for e in reg["endpoints"]}
    import importlib
    for ep_id, args in (("cn_shortline_emotion", {"date"}), ("cn_shortline_cycle", {"date", "lookback"}), ("cn_shortline_facts", {"date"}), ("cn_shortline_daily", {"date"}),
                         ("cn_shortline_themes", {"date", "top"}), ("cn_shortline_firstboard", {"date"})):
        e = by_id[ep_id]
        assert e["symbol_kind"] == "none" and e["computed"] is True and set(e["args"]) == args
        assert "cache_max_age_sec" not in e, "已收盘的日子结果不变;没收盘的靠 partial 不进缓存"
        mod = importlib.import_module(f"sources.{e['module']}")
        maps = importlib.import_module(f"sources.{e['mapper_module']}")
        assert callable(getattr(mod, e["function"])) and callable(getattr(maps, e["mapper"]))
