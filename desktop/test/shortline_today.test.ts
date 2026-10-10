// 情绪复盘 · 今日情绪：用 2026-10-09 收盘后真实取到的数（长列表截短）渲染，断言用户看得到什么。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { textOf, withRenderer } from "./helpers/render.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/shortline-2026-10-09.json", import.meta.url), "utf8"));
const done = (result: unknown, extra: Record<string, unknown> = {}) => ({
  state: "done", status: "ok", result, why: "", settled: (result as { settled?: boolean } | null)?.settled ?? null, cached: false, fetched_at: null, ...extra,
});
const ALL = { emotion: done(FX.emotion), facts: done(FX.facts), themes: done(FX.themes), firstboard: done(FX.firstboard), cycle: done(FX.cycle) };
const LOADING = { state: "loading" };

async function renderToday(panels: Record<string, unknown>, day: string | null = "2026-10-09") {
  return withRenderer(async (r) => {
    const { TodayTab } = await r.load("/src/verticals/finance/shortline/TodayTab.tsx");
    const { AiPageProvider } = await r.load("/src/core/ai/pageContext.tsx");
    const Page = () => createElement(AiPageProvider, null, createElement(TodayTab, { day, panels }));
    return textOf(r.html(Page, {}));
  });
}

test("今日情绪：四项读数、反馈矩阵、梯队断层、题材、首板都画出来，数字和真实数据一致", async () => {
  const t = await renderToday(ALL);
  assert.match(t, /复盘日 2026-10-09 ,对比前一交易日 2026-10-08/);
  assert.match(t, /涨停 \d+ 家\(前一交易日 \d+ 家\)/);
  // 赚钱效应：中位 +1.95%、翻红率 63%（0.628）、样本 43 只
  assert.match(t, /赚钱效应/);
  assert.match(t, /\+1\.95%/);
  assert.match(t, /63%/);
  // 梯队：最高 9 板，3/6/7/8 板缺档要标出来，不是画成 0
  for (const b of [3, 6, 7, 8]) assert.match(t, new RegExp(`${b}板 缺`), `${b} 板缺档没标`);
  assert.doesNotMatch(t, /9板 缺/);
  // 反馈矩阵：首板排第一，晋级率 24%
  assert.match(t, /昨日身份 晋级涨停 收红 小跌 跌超5% 跌停 晋级率 首板 \(33\) 8 12 11 1 1 24% 2板 \(3\)/, "反馈矩阵首板排第一");
  assert.match(t, /展开明细\(10 只,按当天表现从差到好\) 彩蝶实业/, "明细从最差的排起");
  // 封板质量两半互补、炸板率口径
  assert.match(t, /43 \+ 26 = 当天涨停 69 家/);
  // 题材事件树与首板名单
  assert.match(t, /固态电池/);
  assert.match(t, /延续/);
  assert.match(t, /远程股份/);
  assert.match(t, /09:31/);
  assert.match(t, /新华文轩[\s\S]{0,40}反包/);
  // 已收盘的一天不出「还没收盘」提示
  assert.doesNotMatch(t, /还没收盘/);
});

test("今日情绪：还在取的块写「加载中」，没取到的块写原因、并说明不代表没有；其他块照常显示", async () => {
  const loading = await renderToday({ ...ALL, facts: LOADING, themes: LOADING, firstboard: LOADING, cycle: LOADING });
  assert.match(loading, /赚钱效应/);
  assert.match(loading, /盘面事实加载中…/);
  assert.match(loading, /题材事件树加载中…/);
  assert.match(loading, /首板名单加载中…/);

  const failed = await renderToday({ ...ALL, facts: done(null, { status: "failed", why: "东财接口 502" }) });
  assert.match(failed, /盘面事实 这次没取到:东财接口 502。不代表没有/);
  assert.match(failed, /赚钱效应/, "其他块照常显示");
  assert.match(failed, /远程股份/);

  const none = await renderToday({ emotion: LOADING, facts: LOADING, themes: LOADING, firstboard: LOADING, cycle: LOADING }, null);
  assert.match(none, /情绪四项加载中…/);
  assert.doesNotMatch(none, /复盘日/, "没拿到业务日就不写日期");
});

test("今日情绪：没收盘的一天要提示数字还会变；单项没算出来写原因", async () => {
  const live = { ...FX.emotion, settled: false, consec_premium: { available: false, reason: "昨日没有 2 板以上的股票" } };
  const t = await renderToday({ ...ALL, emotion: done(live) });
  assert.match(t, /这一天还没收盘/);
  assert.match(t, /昨日没有 2 板以上的股票/);
});

test("给 AI 的文字：读数照抄、缺口明说（还在取 / 没取到不代表是零），梯队写缺档", async () => {
  await withRenderer(async (r) => {
    const { todaySummary } = await r.load("/src/verticals/finance/shortline/summary.ts");
    const all = todaySummary("2026-10-09", ALL);
    assert.match(all, /^复盘日 2026-10-09\(对比前一交易日 2026-10-08\);已收盘定稿。/);
    assert.match(all, /赚钱效应\(昨日涨停股当天收盘对收盘\):中位 \+1\.95%/);
    assert.match(all, /9板×1 .*3板缺/);
    assert.match(all, /昨日强势股反馈:首板\(33\)/, "首板排第一");
    assert.match(all, /固态电池\[延续\]/);
    assert.match(all, /首板 57 家/);

    const gaps = todaySummary("2026-10-09", { ...ALL, facts: { state: "loading" }, cycle: done(null, { status: "failed", why: "超时" }) });
    assert.match(gaps, /盘面事实:还在取,先别据此下结论/);
    assert.match(gaps, /情绪周期:这次没取到\(超时\),不代表是零/);
    assert.doesNotMatch(gaps, /封板质量/);
  });
});

test("页面块 → 面板：结果取 extra.result；failed 的结果作废只留原因；报错去掉异常类名", async () => {
  await withRenderer(async (r) => {
    const { panelOf, cleanReason } = await r.load("/src/verticals/finance/shortline/api.ts");
    const base = { id: "facts", title: "", note: "", fetched_at: "2026-10-09T08:00:00Z", cached: true, error: null, via_fallback: false, fallback_error: null };
    const ok = panelOf({ ...base, status: "ok", envelope: { extra: { result: FX.facts } } });
    assert.equal(ok.result.date, "2026-10-09");
    assert.equal(ok.settled, true);
    assert.equal(ok.cached, true);
    const partial = panelOf({ ...base, status: "partial", envelope: { extra: { result: { ...FX.facts, settled: false } } } });
    assert.equal(partial.settled, false, "partial 也用结果");
    const bad = panelOf({ ...base, status: "failed", error: "DataNotAvailable: 2026-10-04 不是交易日", envelope: { extra: { result: FX.facts } } });
    assert.equal(bad.result, null, "failed 的结果不能拿来画");
    assert.equal(bad.why, "2026-10-04 不是交易日");
    const envReason = panelOf({ ...base, status: "missing", envelope: { missing: [{ reason: "TimeoutError: 东财 30 秒没回" }] } });
    assert.equal(envReason.why, "东财 30 秒没回");
    assert.equal(panelOf(undefined).why, "这一块没有返回");
    assert.equal(cleanReason("RuntimeError: 来源坏了"), "来源坏了");
    assert.equal(cleanReason("2026-10-04 不是交易日"), "2026-10-04 不是交易日", "没有类名的原样保留");
  });
});
