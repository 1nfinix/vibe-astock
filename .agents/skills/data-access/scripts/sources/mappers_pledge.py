"""本项目的沪深逐股质押页面映射。"""
from __future__ import annotations

from sources.mappers import ev, out
from sources.mappers_astock import _bind, _table, equity_pledge_map


def equity_pledge_market_map(result, ctx: dict) -> dict:
    return equity_pledge_map(result, ctx)


def weekly_pledge_map(result, ctx: dict) -> dict:
    rows, attrs = _table(result)
    bound = _bind(ctx, rows, attrs)
    if not rows:
        return out([], status="partial", degraded="没有可用的周度质押统计")
    evidence = []
    fields = (
        ("companies", "pledge_companies", "只"),
        ("pledged_shares_10k", "pledged_shares_observed", "万股"),
        ("pledged_mktcap_10k", "pledged_mktcap_observed", "万元"),
        ("companies_ratio_ge_50", "pledge_companies_ge_50", "只"),
        ("official_new_pledges", "official_pledge_new_count", "笔"),
        ("official_new_shares_10k", "official_pledge_new_shares", "万股"),
    )
    for row in rows:
        for key, field, unit in fields:
            if row[key] is not None:
                official = key.startswith("official_")
                evidence.append(ev(bound, field, row[key], unit, row["date"], as_of=row["date"],
                                   record_key=row["date"], source="chinaclear" if official else ctx["source"],
                                   endpoint="中国结算本期办理质押汇总" if official else ctx["endpoint"],
                                   note="沪深本期新办理质押" if official else "沪深逐股有质押记录的股票汇总"))
    incomplete = len(rows) < attrs["requested_weeks"] or any(
        row[key] for row in rows for key in ("missing_shares", "missing_mktcap", "missing_ratio", "official_error")
    )
    return out(evidence, status="partial" if incomplete else "ok",
               degraded="部分周次或字段缺失，缺值指标没有汇总" if incomplete else None,
               extra={"history": rows, "computation": {"method": attrs["method"],
                     "input_raw_refs": [r.get("raw_ref") for r in ctx.get("raws", []) if r.get("raw_ref")],
                     "requested_weeks": attrs["requested_weeks"]}})
