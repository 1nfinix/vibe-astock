"""ETF 资金页的公开分钟量价、交易所名录与份额回填。"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta
from html import unescape
import re
import time

from sources._http import http_get
from sources.etf_turnover import ETF_CODE_RE, _yi, szse_fund_share_history
from sources.sina import sina_kline


BASKET = (
    "510310", "588000", "159915", "510300", "563360", "159352", "512100", "159338",
    "510500", "159949", "588080", "510050", "510210", "159845", "159952", "159361",
    "512050", "159633", "560010", "159919",
)
INDEX_CODE = "sh000001"
_MIN_SUCCESS = 0.8


def _codes(extra_codes):
    if extra_codes is None:
        extra_codes = []
    if (not isinstance(extra_codes, list) or len(extra_codes) > 30
            or any(not isinstance(c, str) or not re.fullmatch(ETF_CODE_RE, c) for c in extra_codes)):
        raise ValueError("extra_codes 限 30 只沪深六位 ETF 代码")
    return list(dict.fromkeys([*BASKET, *extra_codes]))


def _series(bars):
    ordered = sorted(bars, key=lambda b: b["day"])
    if not ordered or len({b["day"] for b in ordered}) != len(ordered):
        raise ValueError("K 线为空或时间重复")
    return {"times": [b["day"][11:16] for b in ordered],
            "amount_yi": [round(_yi(b), 6) for b in ordered],
            "close": [b["close"] for b in ordered]}


def _aggregate(items, codes, times):
    count = len(items)
    coverage = count / len(codes)
    if coverage < _MIN_SUCCESS:
        return {"times": times, "amount_yi": None, "coverage": None,
                "reason": f"ETF 成功 {count}/{len(codes)}，低于 80%"}
    by_time: dict[str, float] = defaultdict(float)
    at_time: Counter[str] = Counter()
    for item in items.values():
        for t, amount in zip(item["times"], item["amount_yi"]):
            by_time[t] += amount
            at_time[t] += 1
    values = [round(by_time[t], 6) if at_time[t] / len(codes) >= _MIN_SUCCESS else None for t in times]
    notes = []
    if count < len(codes):
        notes.append(f"仅汇总成功的 {count}/{len(codes)} 只 ETF")
    if any(at_time[t] < len(codes) for t in times):
        notes.append("部分分钟缺 ETF 数据，逐分钟覆盖数见 coverage")
    if None in values:
        notes.append("部分分钟覆盖不足 80%，该分钟合计为空")
    return {"times": times, "amount_yi": values, "coverage": [at_time[t] for t in times],
            "reason": "；".join(notes) or None}


def cn_etf_minute_batch(extra_codes=None):
    """指数最新交易日的 1 分钟数据；成交额单位亿元，来源成交量×OHLC 均价。"""
    codes = _codes(extra_codes)
    index_bars = sina_kline(INDEX_CODE, 1, 240)
    day = max(b["day"] for b in index_bars)[:10]
    index = _series([b for b in index_bars if b["day"][:10] == day])
    items, missing = {}, []
    for code in codes:
        try:
            bars = [b for b in sina_kline(code, 1, 240) if b["day"][:10] == day]
            items[code] = _series(bars)
        except Exception as exc:
            missing.append({"code": code, "reason": str(exc)[:180]})
    times = sorted({t for item in items.values() for t in item["times"]})
    return {"date": day, "unit": "亿元", "codes": codes, "index_code": INDEX_CODE,
            "index": index, "items": items, "success_count": len(items), "missing": missing,
            "total": _aggregate(items, codes, times)}


def cn_etf_minute_hist(days=20, extra_codes=None):
    """新浪最多 1023 根 5 分钟 K，按可回溯交易日分组。"""
    if isinstance(days, bool) or not isinstance(days, int) or days < 1:
        raise ValueError("days 必须为正整数")
    codes = _codes(extra_codes)
    fetched, missing = {}, []
    for code in codes:
        try:
            bars = sina_kline(code, 5, 1023)
            if not bars:
                raise ValueError("5 分钟 K 线为空")
            fetched[code] = bars
        except Exception as exc:
            missing.append({"code": code, "reason": str(exc)[:180]})
    dates = sorted({b["day"][:10] for bars in fetched.values() for b in bars})[-days:]
    grouped = []
    for day in dates:
        items, day_missing = {}, list(missing)
        for code, bars in fetched.items():
            one = [b for b in bars if b["day"][:10] == day]
            if one:
                items[code] = _series(one)
            else:
                day_missing.append({"code": code, "reason": f"{day} 无 5 分钟 K"})
        times = sorted({t for item in items.values() for t in item["times"]})
        grouped.append({"date": day, "items": items, "success_count": len(items),
                        "missing": day_missing, "total": _aggregate(items, codes, times)})
    return {"unit": "亿元", "codes": codes, "days": grouped, "missing": missing,
            "max_bars_per_code": 1023}


# 仅精确匹配跟踪指数；策略、行业、主题、跨境等相似名称不会被前缀误收。
_NAMED = {
    "沪深300": ("沪深300", "000300"), "中证1000": ("中证1000", "000852"),
    "中证500": ("中证500", "000905"), "科创50": ("科创50", "000688"),
    "中证A500": ("中证A500", "000510"), "创业板指": ("创业板指", "399006"),
    "上证50": ("上证50", "000016"), "创业板50": ("创业板50", "399673"),
    "双创50": ("双创50", "931643"), "中证2000": ("中证2000", "932000"),
    "国证2000": ("国证2000", "399303"),
}
_OTHER = {
    "上证180": "000010", "中证800": "000906", "深证100": "399330",
    "上证综合": "000001", "上证指数": "000001", "深证成份": "399001",
    "深证成指": "399001", "上证380": "000009", "中证A100": "000903",
    "中证A50": "930050", "中证全指": "000985", "国证A指": "399317",
}
_ALIASES = {"上证科创板50成份": "科创50", "上证科创50成份": "科创50",
            "中证小盘500": "中证500", "中证科创创业50": "双创50"}


def _category(index):
    raw = str(index or "").strip()
    code_match = re.fullmatch(r"(\d{6})(?:\s+(.+))?", raw)
    code = code_match.group(1) if code_match else None
    name = ((code_match.group(2) if code_match else raw) or "").strip().replace(" ", "")
    if name in _OTHER:
        return "其他宽基"
    name = re.sub(r"(?:收益指数|指数)$", "", name)
    if name in _ALIASES:
        return _ALIASES[name]
    if code == "399300":
        return "沪深300"
    for category, (label, known_code) in _NAMED.items():
        if name == label or code == known_code:
            return category
    if name in _OTHER or code in _OTHER.values():
        return "其他宽基"
    return None


def _sse_etfs():
    url = "https://query.sse.com.cn/commonQuery.do"
    rows, page, total = [], 1, None
    while total is None or len(rows) < total:
        response = http_get(url, params={"sqlId": "COMMON_JJZWZ_JJLB_L", "isPagination": "true",
                                         "pageHelp.pageSize": 2000, "pageHelp.pageNo": page,
                                         "pageHelp.beginPage": page, "pageHelp.cacheSize": 1,
                                         "pageHelp.endPage": page, "CATEGORY": "F000", "type": "inParams"},
                            headers={"Referer": "https://etf.sse.com.cn/fundlist/", "User-Agent": "Mozilla/5.0"},
                            timeout=20, ext="json")
        response.raise_for_status()
        payload = response.json()
        part = payload.get("result") if isinstance(payload, dict) else None
        meta = payload.get("pageHelp") if isinstance(payload, dict) else None
        if not isinstance(part, list) or not isinstance(meta, dict) or not part:
            raise RuntimeError("上交所基金列表结构异常或为空")
        reported = int(meta["total"])
        if total is not None and reported != total:
            raise RuntimeError("上交所基金列表翻页时总数变化")
        total = reported
        rows.extend(part)
        page += 1
    if len(rows) != total:
        raise RuntimeError("上交所基金列表记录数不完整")
    return [{"code": r["FUND_CODE"], "name": r["FUND_EXPANSION_ABBR"],
             "index": r["INDEX_NAME"], "exchange": "SH"} for r in rows
            if re.fullmatch(r"5\d{5}", str(r.get("FUND_CODE", "")))
            and str(r.get("CATEGORY", "")).startswith("F1")]


def _szse_etfs():
    url = "https://fund.szse.cn/api/report/ShowReport/data"
    rows, page, first = [], 1, None
    while first is None or page <= first[0]:
        response = http_get(url, params={"SHOWTYPE": "JSON", "CATALOGID": "fund_etf",
                                         "TABKEY": "tab1", "PAGENO": page},
                            headers={"Referer": "https://fund.szse.cn/"}, timeout=20, ext="json")
        response.raise_for_status()
        payload = response.json()
        table = payload[0] if isinstance(payload, list) and len(payload) == 1 else None
        meta = table.get("metadata") if isinstance(table, dict) else None
        part = table.get("data") if isinstance(table, dict) else None
        if not isinstance(meta, dict) or not isinstance(part, list) or not part:
            raise RuntimeError(f"深交所 ETF 列表第 {page} 页结构异常或为空")
        snapshot = (int(meta["pagecount"]), int(meta["recordcount"]), meta.get("subname"))
        if first is not None and snapshot != first:
            raise RuntimeError("深交所 ETF 列表翻页时快照变化")
        first = snapshot
        for rec in part:
            code = re.search(r"<u>(\d{6})</u>", rec["sys_key"])
            name = re.search(r"<u>(.*?)</u>", rec["kzjcurl"])
            if not code or not name:
                raise RuntimeError("深交所 ETF 列表代码或简称格式变化")
            rows.append({"code": code.group(1), "name": unescape(name.group(1)),
                         "index": str(rec.get("nhzs") or "").strip(), "exchange": "SZ"})
        page += 1
    if len(rows) != first[1]:
        raise RuntimeError("深交所 ETF 列表记录数不完整")
    return rows


def cn_broad_etf_universe():
    """只接受交易所直接给出的跟踪指数精确白名单。"""
    rows = _sse_etfs() + _szse_etfs()
    if not rows:
        raise RuntimeError("沪深交易所 ETF 列表均为空")
    result = [{**r, "category": category} for r in rows
              if "增强" not in r["name"] and (category := _category(r["index"]))]
    codes = [r["code"] for r in result]
    if not result or len(codes) != len(set(codes)):
        raise RuntimeError("宽基 ETF 名录为空或代码重复")
    return {"items": sorted(result, key=lambda r: (r["category"], r["code"])),
            "counts": dict(Counter(r["category"] for r in result)), "source_count": len(rows)}


def cn_etf_share_history_sh(start=None, end=None):
    """上交所按工作日逐日回填；单日失败记录下来，不中断整个区间。"""
    from sources.astock_ported import etf_shares

    try:
        begin, finish = date.fromisoformat(start), date.fromisoformat(end)
    except (TypeError, ValueError) as exc:
        raise ValueError("日期必须为 YYYY-MM-DD") from exc
    if begin.isoformat() != start or finish.isoformat() != end or begin > finish:
        raise ValueError("日期范围无效")
    days = [begin + timedelta(days=i) for i in range((finish - begin).days + 1)]
    rows, failed = [], []
    for day in days:
        if day.weekday() >= 5:
            continue
        try:
            frame = etf_shares(day.isoformat(), "SH")
            rows.extend(frame.to_dict("records"))
        except Exception as exc:
            failed.append({"date": day.isoformat(), "reason": str(exc)[:180]})
        time.sleep(0.2)
    return {"start": start, "end": end, "rows": rows, "failed": failed}
