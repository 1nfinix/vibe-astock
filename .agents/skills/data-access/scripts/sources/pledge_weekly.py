"""中国结算逐股质押统计的周度汇总，原始响应由 astock_ported 的东财入口捕获。"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
from lxml import html

from sources import astock_ported as pledge_source
from sources._http import http_post


OFFICIAL_WEEK_URL = "https://biz.chinaclear.cn/gpzy/queryStockPledgeInfoWeek"


def official_week(day: str) -> tuple[int, float]:
    response = http_post(OFFICIAL_WEEK_URL, data={"queryDate": day.replace("-", ".")}, timeout=15)
    response.raise_for_status()
    document = html.fromstring(response.content)
    matches = document.xpath(f'//tr[td[normalize-space()="{day.replace("-", "")}"]]')
    if len(matches) != 1:
        raise ValueError(f"中国结算 {day} 本期办理质押数据缺失")
    cells = [cell.text_content().strip().replace(",", "") for cell in matches[0].xpath("./td")]
    if len(cells) != 3:
        raise ValueError(f"中国结算 {day} 本期办理质押字段数量变化")
    count, shares = int(cells[1]), float(cells[2])
    if count < 0 or shares < 0:
        raise ValueError(f"中国结算 {day} 本期办理质押数值无效")
    return count, shares


def weekly_pledge(weeks: int = 12, before: str | None = None):
    if isinstance(weeks, bool) or not isinstance(weeks, int) or not 2 <= weeks <= 26:
        raise ValueError("weeks 必须是 2–26 的整数")
    if before is not None:
        day = date.fromisoformat(before).isoformat()
    else:
        day = None

    rows = []
    for _ in range(weeks):
        condition = f"(TRADE_DATE<='{day}')" if day else ""
        latest = pledge_source._em_event_rows(
            "RPT_CSDC_LIST", condition, "TRADE_DATE,SECURITY_CODE", "-1,1", 1,
            narrowed=bool(day),
        )
        if not latest:
            break
        published = pledge_source._em_day(latest[0]["TRADE_DATE"])
        if day and published > day:
            raise RuntimeError("东财返回了查询截止日之后的质押统计")
        frame = pledge_source.equity_pledge(date=published)
        if len(frame) >= 5000:
            raise RuntimeError(f"{published} 逐股质押记录达到 5000 行上限，不能汇总")
        if frame.empty or frame["code"].duplicated().any() or frame["date"].ne(published).any():
            raise RuntimeError(f"{published} 逐股质押记录不完整或重复")
        required = ("pledged_shares_10k", "pledged_mktcap_10k", "pledge_ratio_pct")
        if frame[list(required)].lt(0).any().any():
            raise RuntimeError(f"{published} 逐股质押记录有负数，不能汇总")
        shares = frame["pledged_shares_10k"]
        value = frame["pledged_mktcap_10k"]
        ratio = frame["pledge_ratio_pct"]
        official_error: str | None
        try:
            official_count, official_shares = official_week(published)
        except (OSError, ValueError) as exc:
            official_count, official_shares = None, None
            official_error = str(exc)[:160]
        else:
            official_error = None
        rows.append({
            "date": published,
            "companies": len(frame),
            "pledged_shares_10k": float(shares.sum()) if shares.notna().all() else None,
            "pledged_mktcap_10k": float(value.sum()) if value.notna().all() else None,
            "companies_ratio_ge_50": int(ratio.ge(50).sum()) if ratio.notna().all() else None,
            "missing_shares": int(shares.isna().sum()),
            "missing_mktcap": int(value.isna().sum()),
            "missing_ratio": int(ratio.isna().sum()),
            "official_new_pledges": official_count,
            "official_new_shares_10k": official_shares,
            "official_error": official_error,
        })
        day = (date.fromisoformat(published) - timedelta(days=1)).isoformat()
    if not rows:
        raise ValueError("截止日之前没有可用的质押统计")
    result = pd.DataFrame(rows).sort_values("date")
    result.attrs["requested_weeks"] = weeks
    result.attrs["method"] = "逐期完整逐股表求和；高质押公司定义为质押比例 ≥50%；本期办理量来自中国结算官网，单列"
    return result
