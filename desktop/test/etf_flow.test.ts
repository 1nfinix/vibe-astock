import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { EtfFlowCumData, EtfFlowDailyData, EtfFlowPollData, EtfFlowTypicalData } from "../src/verticals/finance/shortline/EtfFlowTypes.ts";

const poll: EtfFlowPollData = {
  date: "2026-11-05", asof: "2026-11-05T02:00:00Z", is_today: true, phase: "morning", trading_day: true, poll_ms: 60_000, success_count: 20,
  bars: { times: ["09:31"], amount_yi: [20], coverage: [19], reason: "有 1 个分钟点不足 20 只 ETF，按已取到的合计", barAxisMax: 25 },
  index: { times: ["09:31"], close: [3010] }, missing: [],
  ranking: [
    { code: "510300", name: "沪深300ETF", amount_yi: 3, share_pct: 15, pct: 1, reason: null },
    { code: "588000", name: "科创50ETF", amount_yi: 8, share_pct: 40, pct: -1, reason: null },
    { code: "159915", name: "创业板ETF", amount_yi: null, share_pct: null, pct: null, pct_reason: "上一交易日收盘价未取到", reason: "分钟成交额未取到" },
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
    const { EtfFlowBackfill, EtfFlowSignal } = await r.load("/src/verticals/finance/shortline/EtfFlowSignal.tsx");
    const { EtfFlowBroad, CATEGORY_COLORS } = await r.load("/src/verticals/finance/shortline/EtfFlowBroad.tsx");
    const intraday = textOf(r.html(EtfFlowIntraday, { poll, cum, typical, comparisonDate: "", onComparisonDate: () => {}, onRefresh: () => {}, auto: true, onAuto: () => {}, error: null, previousIndexClose: 2990 }));
    const signal = textOf(r.html(EtfFlowSignal, { data: daily }));
    const broad = textOf(r.html(EtfFlowBroad, { data: daily }));
    const backfill = textOf(r.html(EtfFlowBackfill, { data: daily }));
    assert.match(intraday, /第一部分 · 盘中分钟观测/);
    assert.match(signal, /第二部分 · 放量记录/);
    assert.match(broad, /第三部分 · 日度资金全景/);
    assert.equal(new Set(CATEGORY_COLORS).size, 12, "12 类宽基各有固定颜色");
    assert.match(intraday, /样本不足（n=2）/);
    assert.match(intraday, /近 20 日均值：实际 18 天 · 2026-10-09 至 2026-11-04/);
    assert.ok(intraday.indexOf("科创50ETF") < intraday.indexOf("沪深300ETF"));
    assert.match(intraday, /159915 创业板ETF 分钟成交额未取到/);
    assert.match(intraday, /上一交易日收盘价未取到/);
    assert.match(intraday, /有 1 个分钟点不足 20 只 ETF，按已取到的合计/);
    assert.doesNotMatch(intraday, /159915 创业板ETF 0\.00/);
    assert.match(signal, /待公布/);
    assert.match(broad, /待公布/);
    const monthTable = broad.split("最近一个月 · 12 类日度净流入")[1] ?? "";
    assert.ok(monthTable.indexOf("2026-11-05") < monthTable.indexOf("2026-11-04"), "月度明细按最新日期在前");
    assert.match(backfill, /官方份额历史正在回填：已完成 12 \/ 750 个交易日/);
    assert.match(backfill, /进度只统计宽基份额回填任务完成的交易日/);
    assert.equal((`${backfill} ${signal} ${broad}`.match(/官方份额历史正在回填/g) ?? []).length, 1);
    assert.doesNotMatch(`${intraday} ${signal} ${broad}`, /Choice|汪汪队|联系人/);
  });
});

test("ETF 分钟行情标明盘中、收盘和未开盘的数据时间", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowIntraday } = await r.load("/src/verticals/finance/shortline/EtfFlowIntraday.tsx");
    const render = (value: EtfFlowPollData, auto = true, curve = cum) => textOf(r.html(EtfFlowIntraday, { poll: value, cum: curve, typical, comparisonDate: "", onComparisonDate: () => {}, onRefresh: () => {}, auto, onAuto: () => {}, error: null, previousIndexClose: null }));
    assert.match(render({ ...poll, bars: { ...poll.bars, times: ["10:42"] } }), /行情 10:42 · 自动刷新中/);
    assert.match(render({ ...poll, bars: { ...poll.bars, times: ["10:42"] } }, false), /行情 10:42 · 已暂停/);
    assert.match(render({ ...poll, phase: "closed", bars: { ...poll.bars, times: ["15:00"] } }), /行情 2026-11-05 15:00 · 已收盘/);
    assert.match(render({ ...poll, date: "2026-11-04", is_today: false, phase: "pre_open", bars: { ...poll.bars, times: ["15:00"] } }), /未开盘 · 显示 2026-11-04 收盘数据/);
    assert.match(render({ ...poll, date: "2026-11-04", is_today: false, phase: "weekend", trading_day: false, bars: { ...poll.bars, times: ["15:00"] } }), /休市中 · 显示 2026-11-04 收盘数据/);
    assert.match(render({ ...poll, date: "2026-11-04", is_today: false, phase: "weekend", trading_day: false }), /收盘分钟未取到/);
    assert.match(render({ ...poll, bars: { ...poll.bars, times: [] } }), /分钟行情时间未取到/);
    assert.match(render(poll), /上一交易日（2026-11-04）/);
    assert.match(render({ ...poll, date: "2026-11-04", is_today: false }, true, { ...cum, date: "2026-11-04" }), /2026-11-04分钟累计成交额/);
  });
});

test("ETF 月表显示已取类别小计、缺数说明并合并连续全缺日", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowBroad } = await r.load("/src/verticals/finance/shortline/EtfFlowBroad.tsx");
    const partial = { ...categories, 沪深300: metric(null, "份额缺失") };
    const missing = Object.fromEntries(Object.keys(categories).map((c) => [c, metric(null, "待公布")]));
    const data = { ...daily, recent_month_categories: [
      { date: "2026-11-05", categories: missing }, { date: "2026-11-04", categories: missing }, { date: "2026-11-03", categories: partial },
    ] };
    const html = r.html(EtfFlowBroad, { data });
    const visible = textOf(html);
    assert.match(visible, /2026-11-04 至 2026-11-05 待公布/);
    assert.match(html, /colSpan="13"/);
    assert.match(visible, /\+11\.00 · 缺 1 类/);
    assert.match(visible, /份额缺失＝交易所份额未取到/);
    assert.match(visible, /待公布＝最近交易日份额尚未发布/);
    assert.match(visible, /日线缺失＝ETF 当日日 K 未取到/);
    assert.match(html, /sr-only[^>]*>沪深300：份额缺失/);
  });
});

test("ETF 放量图全空显示原因，净流入滞后多日标明交易日数", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowSignal } = await r.load("/src/verticals/finance/shortline/EtfFlowSignal.tsx");
    const rows = daily.rows.map((x) => ({ ...x, turnover_yi: null, basket: x.date === "2026-11-03" ? x.basket : metric(null, "待公布") }));
    const visible = textOf(r.html(EtfFlowSignal, { data: { ...daily, rows } }));
    assert.match(visible, /近期 ETF 日线成交额未取到/);
    assert.match(visible, /最新已公布净流入（2026-11-03 · 滞后 2 个交易日）/);
  });
});

test("ETF 回填暂停和失败原因在顶部状态中可读", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowBackfill } = await r.load("/src/verticals/finance/shortline/EtfFlowSignal.tsx");
    const html = r.html(EtfFlowBackfill, { data: { ...daily, backfill: { ...daily.backfill, syncing: false, failed: [
      { code: "510300", date: "2026-11-03", reason: "交易所无响应" },
      { code: "510500", reason: "份额字段缺失" },
    ] } } });
    const visible = textOf(html);
    assert.match(visible, /官方份额历史未在回填/);
    assert.match(visible, /失败 2 处：2026-11-03 510300 交易所无响应；510500 份额字段缺失/);
    assert.match(html, /aria-valuemin="0"/);
  });
});

test("ETF 回填完成且无失败时不显示状态条", async () => {
  await withRenderer(async (r) => {
    const { EtfFlowBackfill, EtfFlowSignal } = await r.load("/src/verticals/finance/shortline/EtfFlowSignal.tsx");
    const { EtfFlowBroad } = await r.load("/src/verticals/finance/shortline/EtfFlowBroad.tsx");
    const complete = { ...daily, backfill: { ...daily.backfill, completed: 750, total: 750, syncing: false, failed: [] } };
    const page = [r.html(EtfFlowBackfill, { data: complete }), r.html(EtfFlowSignal, { data: complete }), r.html(EtfFlowBroad, { data: complete })].join("");
    assert.doesNotMatch(textOf(page), /官方份额历史|已完成 750 \/ 750/);
  });
});
