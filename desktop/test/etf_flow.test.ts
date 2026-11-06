import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { EtfFlowCumData, EtfFlowDailyData, EtfFlowPollData, EtfFlowTypicalData } from "../src/verticals/finance/shortline/EtfFlowTypes.ts";

const poll: EtfFlowPollData = {
  date: "2026-11-05", asof: "2026-11-05T02:00:00Z", is_today: true, poll_ms: 60_000, success_count: 20,
  bars: { times: ["09:31"], amount_yi: [20], coverage: [19], reason: "部分分钟覆盖不足", barAxisMax: 25 },
  index: { times: ["09:31"], close: [3010] }, missing: [],
  ranking: [
    { code: "510300", name: "沪深300ETF", amount_yi: 3, share_pct: 15, pct: 1, reason: null },
    { code: "588000", name: "科创50ETF", amount_yi: 8, share_pct: 40, pct: -1, reason: null },
    { code: "159915", name: "创业板ETF", amount_yi: null, share_pct: null, pct: null, reason: "分钟成交额未取到" },
  ],
};
const cum: EtfFlowCumData = { date: "2026-11-05", slots: ["09:30", "09:31"], today: [0, 20],
  comparison: { date: "2026-11-04", values: [0, 18], reason: null },
  average20: { values: [0, 16], n: 18, from: "2026-10-09", to: "2026-11-04" }, comparison_dates: ["2026-11-03", "2026-11-04"] };
const typical: EtfFlowTypicalData = { times: ["09:35"], spike: { n: 2, values: null, reason: "样本不足（n=2）" },
  normal: { n: 4, values: [{ mean: 2, p25: 1, p75: 3, cumulative: 2 }], reason: null }, available_dates: [] };
const metric = (value: number | null, status = "已公布") => ({ net_yi: value, missing_count: value === null ? 1 : 0, status });
const categories = Object.fromEntries(["沪深300", "中证1000", "中证500", "科创50", "中证A500", "创业板指", "上证50", "其他宽基", "创业板50", "双创50", "中证2000", "国证2000"].map((c) => [c, metric(1)]));
const daily: EtfFlowDailyData = {
  date: "2026-11-05", spike_dates: ["2026-11-03"], recent_dates: ["2026-11-03", "2026-11-04", "2026-11-05"], spike_complete: false, spike_window_from: "2026-11-03",
  backfill: { completed: 12, total: 750, from: "2026-10-10", to: "2026-11-04", syncing: true, failed: [] },
  rows: [
    { date: "2026-11-03", turnover_yi: 120, turnover_missing_count: 0, basket: metric(101), categories, index_close: 3000, cumulative_ytd: Object.fromEntries(Object.keys(categories).map((c) => [c, 2])) },
    { date: "2026-11-04", turnover_yi: 90, turnover_missing_count: 0, basket: metric(12), categories, index_close: 3010, cumulative_ytd: Object.fromEntries(Object.keys(categories).map((c) => [c, 3])) },
    { date: "2026-11-05", turnover_yi: 80, turnover_missing_count: 0, basket: metric(null, "待公布"), categories: Object.fromEntries(Object.keys(categories).map((c) => [c, metric(null, "待公布")])), index_close: 3020 },
  ],
  recent_month_categories: [
    { date: "2026-11-04", categories },
    { date: "2026-11-05", categories: Object.fromEntries(Object.keys(categories).map((c) => [c, metric(null, "待公布")])) },
  ],
};

test("ETF 资金三部分、待公布、样本不足、回填进度与排行缺数可见", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowIntraday } = await r.load("/src/verticals/finance/shortline/EtfFlowIntraday.tsx");
    const { EtfFlowSignal } = await r.load("/src/verticals/finance/shortline/EtfFlowSignal.tsx");
    const { EtfFlowBroad } = await r.load("/src/verticals/finance/shortline/EtfFlowBroad.tsx");
    const intraday = textOf(r.html(EtfFlowIntraday, { poll, cum, typical, comparisonDate: "", onComparisonDate: () => {}, onRefresh: () => {}, auto: true, onAuto: () => {}, error: null, previousIndexClose: 2990 }));
    const signal = textOf(r.html(EtfFlowSignal, { data: daily }));
    const broad = textOf(r.html(EtfFlowBroad, { data: daily }));
    assert.match(intraday, /第一部分 · 盘中分钟观测/);
    assert.match(signal, /第二部分 · 放量记录/);
    assert.match(broad, /第三部分 · 日度资金全景/);
    assert.match(intraday, /样本不足（n=2）/);
    assert.match(intraday, /近 20 日均值：实际 18 天 · 2026-10-09 至 2026-11-04/);
    assert.ok(intraday.indexOf("科创50ETF") < intraday.indexOf("沪深300ETF"));
    assert.match(intraday, /159915 创业板ETF 分钟成交额未取到/);
    assert.doesNotMatch(intraday, /159915 创业板ETF 0\.00/);
    assert.match(signal, /待公布/);
    assert.match(broad, /待公布/);
    assert.match(signal, /官方份额回填中：已完成 12 \/ 750 个交易日/);
    assert.match(broad, /当前可用范围：2026-10-10 至 2026-11-04/);
    assert.doesNotMatch(`${intraday} ${signal} ${broad}`, /Choice|汪汪队|联系人/);
  });
});
