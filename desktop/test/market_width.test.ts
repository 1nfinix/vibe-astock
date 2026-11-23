import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";

test("市场宽度页面显示实际分子分母、历史范围和缺口", async () => {
  await withRenderer(async (r) => {
    const { MarketWidthView, MarketWidthTab } = await r.load("/src/verticals/finance/shortline/MarketWidthTab.tsx");
    const controls = textOf(r.html(MarketWidthTab, { day: "2026-11-20" }));
    assert.match(controls, /回填近 60 个交易日/);
    assert.match(controls, /采集这一天的盘后数据/);
    const base = {
      available: true, date: "2026-11-20", coverage: { from: "2025-08-12", to: "2026-11-20", days: 309 },
      source: { name: "通达信盘后包", rows: 5577, archive_sha256: "a".repeat(64) }, calendar_status: "ready",
      markets: {
        sh: { observed: 2319, valid: 2314, up: 156, down: 2145, flat: 13 },
        sz: { observed: 2902, valid: 2902, up: 141, down: 2752, flat: 9 },
        bj: { observed: 356, valid: 356, up: 16, down: 339, flat: 1 },
      },
      width: {
        sh: { "20": { eligible: 2308, above: 246 }, "60": { eligible: 2281, above: 239 } },
        sz: { "20": { eligible: 2894, above: 178 }, "60": { eligible: 2856, above: 166 } },
        bj: { "20": { eligible: 353, above: 7 }, "60": { eligible: 338, above: 3 } },
        all: { "20": { eligible: 5555, above: 431 }, "60": { eligible: 5475, above: 408 } },
      },
      window_reason: { "20": null, "60": null },
      series: [
        { date: "2026-11-19", status: "ok", observed: 5577, valid: 5572, up: 2900, down: 2600, flat: 72 },
        { date: "2026-11-20", status: "ok", observed: 5577, valid: 5572, up: 313, down: 5236, flat: 23 },
      ],
    };
    const text = textOf(r.html(MarketWidthView, { data: base }));
    assert.match(text, /2026-11-20 · 已观察到的沪深京 A 股/);
    assert.match(text, /本地已导入 309 个交易日/);
    assert.match(text, /431\/5555/);
    assert.match(text, /408\/5475/);
    assert.match(text, /313 \/ 5236 \/ 23/);
    assert.match(text, /近 2 个交易日 · 上涨股票占比/);

    const gap = textOf(r.html(MarketWidthView, { data: {
      ...base, calendar_status: "incomplete", window_reason: { "20": "交易日历未完整取得", "60": "交易日历未完整取得" },
      width: Object.fromEntries(Object.keys(base.width).map((m) => [m, { "20": { eligible: null, above: null }, "60": { eligible: null, above: null } }])),
      series: [], series_reason: "交易日历未完整取得，不能确认连续交易日序列",
    } }));
    assert.match(gap, /交易日历未完整取得/);
    assert.match(gap, /不能确认连续交易日序列/);

    const empty = textOf(r.html(MarketWidthView, { data: { available: false, reason: "市场历史数据尚未导入" } }));
    assert.equal(empty, "市场历史数据尚未导入");
  });
});
