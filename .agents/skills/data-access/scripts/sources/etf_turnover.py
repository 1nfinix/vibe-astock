"""宽基 ETF 的公开量价数据。历史名单只作为固定观察口径。"""
from __future__ import annotations

from collections import defaultdict
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from sources.sina import sina_kline
from sources.tencent import tencent_prefix, tencent_quotes

_CORE = [
    ("510300", "沪深300ETF", "沪深300", 735.13), ("510310", "沪深300ETF易方达", "沪深300", 558.94),
    ("510050", "上证50ETF", "上证50", 487.59), ("510330", "沪深300ETF华夏", "沪深300", 420.28),
    ("159919", "沪深300ETF嘉实", "沪深300", 354.98), ("512100", "中证1000ETF", "中证1000", 221.69),
    ("588080", "科创50ETF易方达", "科创50", 216.07), ("159915", "创业板ETF", "创业板", 170.2),
    ("510500", "中证500ETF", "中证500", 142.17), ("159845", "中证1000ETF易方达", "中证1000", 137.26),
    ("560010", "中证1000ETF广发", "中证1000", 105.5), ("510180", "上证180ETF", "上证180", 52.32),
    ("159629", "中证1000ETF富国", "中证1000", 36.34), ("510230", "金融ETF", "沪深300金融", 25.64),
    ("159922", "中证500ETF嘉实", "中证500", 23.11), ("512500", "中证500ETF华夏", "中证500", 20.51),
    ("515800", "800ETF", "中证800", 13.08), ("159952", "创业板ETF广发", "创业板", 10.91),
    ("588050", "科创50ETF工银", "科创50", 9.7), ("159901", "深证100ETF", "深证100", 7.19),
]
DEFAULT_WATCH = ["588000", "512050", "159338", "159339"]
ETF_POOL = [dict(code=c, tcode=tencent_prefix(c), name=n, index=i, group="core", huijin_yi=h) for c, n, i, h in _CORE]
CORE_CODES = {x["code"] for x in ETF_POOL}
POOL_NOTE = "汇金组来自 2025 年报前十大持有人历史披露；信披规则变化后，名单不能证明当日持仓或交易。"


def _pool(extra_codes=None):
    codes = DEFAULT_WATCH if extra_codes is None else extra_codes
    if not isinstance(codes, list) or len(codes) > 30 or any(not isinstance(c, str) or not re.fullmatch(r"[51]\d{5}", c) for c in codes):
        raise ValueError("观察组限 30 只沪深 ETF 六位代码")
    return ETF_POOL + [dict(code=c, tcode=tencent_prefix(c), name=c, index="—", group="watch", huijin_yi=None)
                       for c in dict.fromkeys(codes) if c not in CORE_CODES]


def _day():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


def _yi(bar):
    return float(bar["volume"]) * (float(bar["open"]) + float(bar["high"]) + float(bar["low"]) + float(bar["close"])) / 4e8


def _shape(bars, trade_date):
    by_day = defaultdict(list)
    for bar in bars:
        day = str(bar["day"])[:10]
        if day < trade_date:
            by_day[day].append(bar)
    complete = [sorted(v, key=lambda x: x["day"]) for _, v in sorted(by_day.items()) if len(v) == 48][-20:]
    shapes, tails = [], []
    for day_bars in complete:
        amounts = [_yi(b) for b in day_bars]
        total = sum(amounts)
        if total <= 0:
            continue
        cumulative, points = 0.0, []
        for amount in amounts:
            cumulative += amount
            points.append(cumulative / total)
        shapes.append(points)
        tails.append(sum(amounts[-6:]) / total)
    if not shapes:
        return None, None
    return [round(sum(x[i] for x in shapes) / len(shapes), 6) for i in range(48)], round(sum(tails) / len(tails), 6)


def build_etf_turnover_baseline(trade_date=None, extra_codes=None):
    day = trade_date or _day()
    items, missing = [], []
    for item in _pool(extra_codes):
        code = item["code"]
        try:
            daily = sorted(sina_kline(code, 240, 50), key=lambda b: b["day"])
            before = [b for b in daily if b["day"][:10] < day]
            if len(before) < 20:
                raise ValueError(f"日 K 仅有 {len(before)} 根，少于 20 根")
            hist = [round(_yi(b), 4) for b in before[-30:]]
            avg20 = sum(_yi(b) for b in before[-20:]) / 20
            five = sina_kline(code, 5, 1023)
            shape, tail_base = _shape(five, day)
            current = sorted((b for b in five if b["day"][:10] == day), key=lambda b: b["day"])
            tail = None
            if len(current) == 48:
                amounts = [_yi(b) for b in current]
                if sum(amounts) > 0:
                    tail = sum(amounts[-6:]) / sum(amounts)
            items.append({**item, "avg20_yi": round(avg20, 4), "hist": hist, "shape": shape,
                          "tail_ratio_base": tail_base, "tail_ratio": None if tail is None else round(tail, 6)})
        except Exception as exc:
            missing.append({"code": code, "reason": str(exc)[:180]})
            items.append({**item, "avg20_yi": None, "hist": [], "shape": None, "tail_ratio_base": None, "tail_ratio": None})
    return {"date": day, "items": items, "missing": missing, "pool_note": POOL_NOTE}


def build_etf_turnover_live(extra_codes=None):
    pool = _pool(extra_codes)
    quotes = tencent_quotes([x["code"] for x in pool])
    items, missing = [], []
    for item in pool:
        code = item["code"]
        quote = quotes.get(code)
        if not quote or quote.get("price") is None or quote.get("amount_wan") is None:
            missing.append({"code": code, "reason": "腾讯行情缺少现价或成交额"})
            items.append({**item, "price": None, "amount_yi": None})
            continue
        items.append({**item, "name": quote.get("name") or item["name"], "price": quote["price"],
                      "prev_close": quote.get("last_close"), "pct": quote.get("change_pct"),
                      "amount_yi": quote["amount_wan"] / 10000, "mktcap_yi": quote.get("mcap_yi"),
                      "shares": None if quote.get("shares") is None else quote["shares"] / 1e8, "outer_lots": quote.get("outer_lots"),
                      "inner_lots": quote.get("inner_lots"), "quote_time": quote.get("quote_time")})
    return {"date": _day(), "items": items, "missing": missing}
