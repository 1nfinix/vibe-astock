import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { EtfTurnoverViewData } from "../src/verticals/finance/shortline/EtfTurnoverView.tsx";

const view: EtfTurnoverViewData = {
  date: "2026-11-04", asof: "2026-11-04T07:00:00Z", baseline_date: "2026-11-04", baseline_generated: "2026-11-04T07:00:00Z",
  quote_time: "20261104150000", quote_date: "2026-11-04", quote_hm: "15:00", data_connected: true, stale: false,
  progress_pct: 100, avg20_total_yi: 100, daily_ratio: 1.25, core_count: 20,
  phase: "closed", trading_day: true, poll_ms: 60000,
  watch_codes: ["588000"], previous_shares_date: "2026-11-03", shares_suspect: ["5"],
  items: [
    { code: "159919", name: "沪深300ETF嘉实", index: "沪深300", group: "core", huijin_yi: 354.98,
      price: 4, pct: 0, amount_yi: 20, mktcap_yi: 300, shares: 40,
      avg20_yi: 20, hist: [10, 20], ratio: 1, net_yi: 1, subscr_net_yi: 0.001, prev_shares: 40, reason: null },
    { code: "510300", name: "沪深300ETF华泰柏瑞", index: "沪深300", group: "core", huijin_yi: 735.13,
      price: 4.175, pct: 2.03, amount_yi: 125.6222, mktcap_yi: 1861.52, shares: 445.87,
      avg20_yi: 79.4665, hist: [10, 20, 30], ratio: 1.58, net_yi: 38.08, subscr_net_yi: null, prev_shares: 445.87, reason: null },
    { code: "588000", name: "科创50ETF华夏", index: "科创50", group: "watch", huijin_yi: null,
      price: null, pct: null, amount_yi: null, mktcap_yi: null, shares: null,
      avg20_yi: null, hist: [], ratio: null, net_yi: null, subscr_net_yi: null, prev_shares: null, reason: "实时成交额未取到" },
  ],
  totals: { amount_yi: 125.6222, expected_yi: 79.4665, ratio: 1.58, net_yi: 38.08, weighted_pct: 2.03 },
  verdict: { level: "medium", title: "温和放量、偏买", reason: "成交额放大到历史同时点均值的 1.58 倍，主动净买入 38.08 亿元。这是量价现象，不能证明任何机构当日交易。" },
  missing: [{ code: "588000", reason: "腾讯接口超时" }], notes: ["份额源未日更：对应市场申赎暂不显示。"],
};

test("宽基 ETF 量价：默认顺序、合计、份额状态与缺数可见", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const text = textOf(r.html(EtfTurnoverView, { view }));
    assert.match(text, /宽基 ETF 量价跟踪.*宽基 ETF 成交额与资金动向/);
    assert.match(text, /温和放量、偏买/);
    assert.match(text, /合计成交额 125\.62 亿/);
    assert.match(text, /汇金历史持仓 → 规模优先/);
    assert.ok(text.indexOf("沪深300ETF华泰柏瑞") < text.indexOf("沪深300ETF嘉实"));
    assert.match(text, /汇金历史组合计 20 只 — 125\.62 1\.58× \+38\.08 合计口径与上方判断一致/);
    assert.match(text, /申赎 待积累/);
    assert.match(text, /份额源未日更/);
    assert.match(text, /较11-03 持平/);
    assert.match(text, /科创50ETF华夏.*—/);
    assert.match(text, /腾讯接口超时/);
    assert.match(text, /扩展观察组可编辑，仅用于对照，不计入固定名单的合计与判断/);
    assert.doesNotMatch(text, /汪汪队|国家队|上班|加仓|护盘/);
  });
});

test("观察组保存中与失败原因在编辑区可见", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const saving = textOf(r.html(EtfTurnoverView, { view, onSetWatch: () => {}, busy: true }));
    assert.match(saving, /扩展观察.*保存中….*编辑观察组/);
    const failed = textOf(r.html(EtfTurnoverView, { view, onSetWatch: () => {}, saveError: "本机接口超时" }));
    assert.match(failed, /扩展观察.*保存失败：本机接口超时/);
  });
});

test("竞价当日展示等待开盘，昨日行情展示最近交易日", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const auction = { ...view, phase: "auction", quote_date: view.date, quote_hm: "09:20", stale: false, waiting_open: true,
      verdict: { level: "missing", title: "等待开盘", reason: "集合竞价阶段成交额尚未形成" }, totals: { ...view.totals, expected_yi: null, ratio: null } };
    const text = textOf(r.html(EtfTurnoverView, { view: auction }));
    assert.match(text, /等待开盘 · 9:30/);
    assert.match(text, /今日结论 · 等待开盘/);
    const stale = textOf(r.html(EtfTurnoverView, { view: { ...auction, stale: true, quote_date: "2026-11-03", verdict: view.verdict } }));
    assert.match(stale, /最近交易日复盘 · 2026-11-03/);
    assert.doesNotMatch(stale, /今日结论 · 等待开盘/);
  });
});

test("迷你柱图与表头对读屏可读", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const html = r.html(EtfTurnoverView, { view });
    assert.match(html, /role="img"[^>]*aria-label="近 3 日成交额，最新 30\.00 亿元，区间最高 30\.00 亿元"/);
    assert.match(html, /aria-label="近 30 日成交额暂无"/);
    assert.equal((html.match(/scope="col"/g) ?? []).length, 9);
    assert.match(html, /scope="colgroup"/);
  });
});

test("排序时缺数排在末尾，同值按规模；观察组代码只收沪深 ETF 段", async () => {
  await withRenderer(async (r) => {
    const { filterSortEtfRows, ETF_CODE_RE } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const byRatio = filterSortEtfRows(view.items, "ratio", "all", "");
    assert.deepEqual(byRatio.map((x: { code: string }) => x.code), ["510300", "159919", "588000"]);
    const byAmountCore = filterSortEtfRows(view.items, "amount", "core", "");
    assert.deepEqual(byAmountCore.map((x: { code: string }) => x.code), ["510300", "159919"]);
    assert.deepEqual(filterSortEtfRows(view.items, "net", "all", "科创").map((x: { code: string }) => x.code), ["588000"]);
    for (const ok of ["510300", "520500", "560010", "588000", "159338"]) assert.ok(ETF_CODE_RE.test(ok), ok);
    for (const bad of ["113001", "123001", "160105", "501050", "15933", "1593380"]) assert.ok(!ETF_CODE_RE.test(bad), bad);
  });
});

test("合计行在有标的缺数时写明覆盖只数", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    assert.match(textOf(r.html(EtfTurnoverView, { view: { ...view, covered_count: 19 } })), /汇金历史组合计\s*19\/20 只有数/);
    assert.match(textOf(r.html(EtfTurnoverView, { view: { ...view, covered_count: 20 } })), /汇金历史组合计\s*20 只/);
  });
});

test("份额图展示标题、口径、区间及同步和失败状态", async () => {
  await withRenderer(async (r) => {
    const { EtfShareCharts } = await r.load("/src/verticals/finance/shortline/EtfShareCharts.tsx");
    const base = { from: "2026-11-02", to: "2026-11-03", days: 2, missing: [], ranges: { "60": null, "120": null, "242": null } };
    const syncing = textOf(r.html(EtfShareCharts, { data: { ...base, status: "syncing" } }));
    assert.match(syncing, /固定名单每日份额变化.*近3月.*近6月.*近1年/);
    assert.match(syncing, /份额历史同步中，首次约需 1–2 分钟/);
    assert.match(syncing, /固定名单份额指数/);
    assert.match(syncing, /区间首日 = 100/);
    assert.match(textOf(r.html(EtfShareCharts, { data: { ...base, status: "failed", reason: "官方接口超时" } })), /官方接口超时/);
    assert.match(textOf(r.html(EtfShareCharts, { data: { ...base, status: "empty" } })), /至少需要两个交易日/);
    const points = { deltas: [{ date: "2026-11-03", d: 1 }], index: [{ date: "2026-11-02", v: 100 }, { date: "2026-11-03", v: 101 }] };
    const ready = textOf(r.html(EtfShareCharts, { data: { ...base, status: "ready", ranges: { "60": points, "120": points, "242": points } } }));
    assert.match(ready, /区间 2026-11-03 ~ 2026-11-03（1 个交易日）/);
    const partial = textOf(r.html(EtfShareCharts, { data: { ...base, status: "ready", missing: [{ code: "510300", date: "2026-11-03", reason: "官方接口超时" }], ranges: { "60": points, "120": points, "242": points } } }));
    assert.match(partial, /缺数 1 处：2026-11-03 510300 官方接口超时/);
    assert.doesNotMatch(ready, /汪汪队|国家队|上班|加仓|护盘/);
  });
});
