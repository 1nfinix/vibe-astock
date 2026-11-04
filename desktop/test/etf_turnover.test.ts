import assert from "node:assert/strict";
import test from "node:test";
import { textOf, withRenderer } from "./helpers/render.ts";
import type { EtfTurnoverViewData } from "../src/verticals/finance/shortline/EtfTurnoverView.tsx";

const view: EtfTurnoverViewData = {
  date: "2026-11-04", asof: "2026-11-04T07:00:00Z", phase: "closed", trading_day: true, poll_ms: 60000,
  watch_codes: ["588000"], previous_shares_date: "2026-11-03", shares_suspect: ["5"],
  items: [
    { code: "510300", name: "沪深300ETF", index: "沪深300", group: "core", huijin_yi: 735.13,
      price: 4.175, pct: 2.03, amount_yi: 125.6222, mktcap_yi: 1861.52, shares: 445.87,
      avg20_yi: 79.4665, hist: [10, 20, 30], ratio: 1.58, net_yi: 38.08, subscr_net_yi: null, prev_shares: 445.87, reason: null },
    { code: "588000", name: "科创50ETF", index: "—", group: "watch", huijin_yi: null,
      price: null, pct: null, amount_yi: null, mktcap_yi: null, shares: null,
      avg20_yi: null, hist: [], ratio: null, net_yi: null, subscr_net_yi: null, prev_shares: null, reason: "实时成交额未取到" },
  ],
  totals: { amount_yi: 125.6222, expected_yi: 79.4665, ratio: 1.58, net_yi: 38.08, weighted_pct: 2.03 },
  verdict: { level: "medium", title: "温和放量、偏买", reason: "历史同时点成交额的 1.58 倍，不能证明任何机构当日交易。" },
  missing: [{ code: "588000", reason: "腾讯接口超时" }], notes: ["份额源未日更：对应市场申赎暂不显示。"],
};

test("宽基 ETF 量价：结论、合计、缺数与份额状态都可见", async () => {
  await withRenderer(async (r) => {
    const { EtfTurnoverView } = await r.load("/src/verticals/finance/shortline/EtfTurnoverView.tsx");
    const text = textOf(r.html(EtfTurnoverView, { view }));
    assert.match(text, /温和放量、偏买/);
    assert.match(text, /合计成交额 125\.62 亿/);
    assert.match(text, /汇金历史组 20|汇金历史组?合计/);
    assert.match(text, /510300/);
    assert.match(text, /份额源未日更/);
    assert.match(text, /实时成交额未取到/);
    assert.match(text, /腾讯接口超时/);
    assert.match(text, /观察.*不计入判断或合计/);
    assert.doesNotMatch(text, /汪汪队|上班|国家队买了/);
  });
});
