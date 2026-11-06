"""宽基 ETF 的公开量价数据。历史名单只作为固定观察口径。"""
from __future__ import annotations

from collections import defaultdict
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from sources.sina import sina_kline
from sources.tencent import tencent_prefix, tencent_quotes

_CORE = [
    ("510300", "沪深300ETF华泰柏瑞", "沪深300", 735.13), ("510310", "沪深300ETF易方达", "沪深300", 558.94),
    ("510050", "上证50ETF华夏", "上证50", 487.59), ("510330", "沪深300ETF华夏", "沪深300", 420.28),
    ("159919", "沪深300ETF嘉实", "沪深300", 354.98), ("512100", "中证1000ETF南方", "中证1000", 221.69),
    ("588080", "科创50ETF易方达", "科创50", 216.07), ("159915", "创业板ETF易方达", "创业板指", 170.2),
    ("510500", "中证500ETF南方", "中证500", 142.17), ("159845", "中证1000ETF华夏", "中证1000", 137.26),
    ("560010", "中证1000ETF广发", "中证1000", 105.5), ("510180", "上证180ETF华安", "上证180", 52.32),
    ("159629", "中证1000ETF富国", "中证1000", 36.34), ("510230", "金融ETF国泰", "上证180金融", 25.64),
    ("159922", "中证500ETF嘉实", "中证500", 23.11), ("512500", "中证500ETF华夏", "中证500", 20.51),
    ("515800", "中证800ETF汇添富", "中证800", 13.08), ("159952", "创业板ETF广发", "创业板指", 10.91),
    ("588050", "科创50ETF工银", "科创50", 9.7), ("159901", "深证100ETF易方达", "深证100", 7.19),
]
_DEFAULT_WATCH_INFO = {
    "588000": ("科创50ETF华夏", "科创50"),
    "159338": ("中证A500ETF国泰", "中证A500"),
    "512050": ("A500ETF华夏", "中证A500"),
    "159339": ("A500ETF银华", "中证A500"),
}
# 沪深场内 ETF 代码段：沪市 51/52/56/58 开头，深市 159 开头；可转债（11/12）、LOF（16/50）等不收
ETF_CODE_RE = r"(?:5[1268]\d{4}|159\d{3})"
DEFAULT_WATCH = list(_DEFAULT_WATCH_INFO)
ETF_POOL = [dict(code=c, tcode=tencent_prefix(c), name=n, index=i, group="core", huijin_yi=h) for c, n, i, h in _CORE]
CORE_CODES = {x["code"] for x in ETF_POOL}
POOL_NOTE = "汇金组来自 2025 年报前十大持有人历史披露；信披规则变化后，名单不能证明当日持仓或交易。"


def _pool(extra_codes=None, include_core=True):
    codes = DEFAULT_WATCH if extra_codes is None else extra_codes
    if not isinstance(codes, list) or len(codes) > 30 or any(not isinstance(c, str) or not re.fullmatch(ETF_CODE_RE, c) for c in codes):
        raise ValueError("观察组限 30 只沪深 ETF（51/52/56/58/159 开头）")
    if not isinstance(include_core, bool):
        raise ValueError("include_core 必须是布尔值")
    return (ETF_POOL if include_core else []) + [dict(code=c, tcode=tencent_prefix(c), name=_DEFAULT_WATCH_INFO.get(c, (c, "—"))[0], index=_DEFAULT_WATCH_INFO.get(c, (c, "—"))[1], group="watch", huijin_yi=None)
                       for c in dict.fromkeys(codes) if c not in CORE_CODES]


def _day():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


def _yi(bar):
    # 原页历史成交额口径：量 × OHLC 四价均值；2026-11-03 的 510300 三个对账锚点误差均为 0%。
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


def build_etf_turnover_baseline(trade_date=None, extra_codes=None, include_core=True):
    day = trade_date or _day()
    items, missing = [], []
    for item in _pool(extra_codes, include_core):
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
        items.append({**item, "name": item["name"] if code in CORE_CODES or code in _DEFAULT_WATCH_INFO else quote.get("name") or item["name"], "price": quote["price"],
                      "prev_close": quote.get("last_close"), "pct": quote.get("change_pct"),
                      "amount_yi": quote["amount_wan"] / 10000, "mktcap_yi": quote.get("mcap_yi"),
                      "shares": None if quote.get("shares") is None else quote["shares"] / 1e8, "outer_lots": quote.get("outer_lots"),
                      "inner_lots": quote.get("inner_lots"), "quote_time": quote.get("quote_time")})
    return {"date": _day(), "items": items, "missing": missing}



def szse_fund_share_history(code=None, start=None, end=None):
    """深交所基金规模历史，按 80 天分段、逐页核对，返回升序亿份。"""
    import math
    import time
    from datetime import date, timedelta
    from sources._http import http_get

    if not isinstance(code, str) or not re.fullmatch(r"15[89]\d{3}", code):
        raise ValueError("深交所份额历史只接受 158/159 开头的六位代码")
    try:
        begin, finish = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError) as exc:
        raise ValueError("日期必须为 YYYY-MM-DD") from exc
    if begin.isoformat() != start or finish.isoformat() != end or begin > finish:
        raise ValueError("日期范围无效")
    rows, requests = [], 0
    window_start = begin
    while window_start <= finish:
        window_end = min(finish, window_start + timedelta(days=79))
        first, page, part = None, 1, []
        while True:
            if requests:
                time.sleep(0.3)
            requests += 1
            response = http_get("https://fund.szse.cn/api/report/ShowReport/data",
                                params={"SHOWTYPE": "JSON", "CATALOGID": "fund_jjgm", "TABKEY": "tab1",
                                        "loading": "first", "txtDm": code, "txtStart": window_start.isoformat(),
                                        "txtEnd": window_end.isoformat(), "PAGENO": page},
                                headers={"Referer": "https://fund.szse.cn/"}, timeout=20, ext="json")
            response.raise_for_status()
            payload = response.json()
            table = payload[0] if isinstance(payload, list) and len(payload) == 1 else None
            meta = table.get("metadata") if isinstance(table, dict) else None
            data = table.get("data") if isinstance(table, dict) else None
            if not isinstance(meta, dict) or not isinstance(data, list):
                raise RuntimeError(f"深交所基金规模第 {page} 页结构异常")
            try:
                counts = tuple(int(meta[k]) for k in ("pagecount", "recordcount", "pagesize"))
            except (KeyError, TypeError, ValueError) as exc:
                raise RuntimeError("深交所基金规模分页信息异常") from exc
            if counts[0] < 0 or counts[1] < 0 or counts[2] < 1 or (counts[1] and (counts[0] < 1 or not data)):
                raise RuntimeError("深交所基金规模分页信息与数据不符")
            if first is None:
                first = counts
            elif counts != first:
                raise RuntimeError("深交所基金规模翻页期间记录数变化")
            for row in data:
                if not isinstance(row, dict) or row.get("fund_code") != code:
                    raise RuntimeError("深交所基金规模返回其他代码或异常记录")
                try:
                    day = date.fromisoformat(row["size_date"]).isoformat()
                    shares = float(str(row["current_size"]).replace(",", "")) / 1e4
                except (KeyError, TypeError, ValueError) as exc:
                    raise RuntimeError("深交所基金规模日期或份额格式异常") from exc
                if day < window_start.isoformat() or day > window_end.isoformat() or not math.isfinite(shares) or shares < 0:
                    raise RuntimeError("深交所基金规模日期或份额越界")
                part.append({"date": day, "shares_yi": shares})
            if page >= max(first[0], 1):
                break
            page += 1
        if len(part) != first[1]:
            raise RuntimeError(f"深交所基金规模取到 {len(part)} 条，与自报 {first[1]} 条不符")
        rows.extend(part)
        window_start = window_end + timedelta(days=1)
    if len({r["date"] for r in rows}) != len(rows):
        raise RuntimeError("深交所基金规模日期重复")
    return sorted(rows, key=lambda r: r["date"])
