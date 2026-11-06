import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServiceContext } from "../src/service.ts";
import { BASKET, MINUTE_SLOTS, SPIKE_THRESHOLD_YI, barAxisMax, calculateDaily, etfFlowClose, etfFlowCum, etfFlowDaily, etfFlowPoll, etfFlowTypical, interpolateFive, minuteCumulative, netFlow, typicalGroup } from "../src/finance/shortline/etf_flow.ts";
import { backfillProgress, loadShareHistory, officialSharePair, shareHistoryFile, startBroadShareBackfill } from "../src/finance/shortline/etf_share_history.ts";

const signal = new AbortController().signal;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "etf-flow-"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: process.cwd(), dataRoot, python: "python3", node: process.execPath });
const env = (result: unknown) => ({ status: "ok", evidence: [], extra: { result } });
const cal = (today: boolean) => ({ status: "ok", evidence: Object.entries({ last_trading_day: today ? "2026-11-05" : "2026-11-04", previous_trading_day: "2026-11-04", is_today_trading_day: today, session_phase: today ? "trading" : "non_trading_day" }).map(([field, value]) => ({ field, value, period: "2026-11-05" })) });
const fiveTimes = [
  ...Array.from({ length: 24 }, (_, i) => `${String(9 + Math.floor((35 + i * 5) / 60)).padStart(2, "0")}:${String((35 + i * 5) % 60).padStart(2, "0")}`),
  ...Array.from({ length: 24 }, (_, i) => `${String(13 + Math.floor((5 + i * 5) / 60)).padStart(2, "0")}:${String((5 + i * 5) % 60).padStart(2, "0")}`),
];
const minute = (day = "2026-11-05") => ({ date: day, index: { times: ["09:31"], close: [3000] },
  items: Object.fromEntries(BASKET.map((code) => [code, { times: ["09:31"], amount_yi: [1], close: [2] }])),
  total: { times: ["09:31"], amount_yi: [20], coverage: [20], reason: null }, success_count: 20, missing: [] });
const five = { days: ["2026-11-03", "2026-11-04"].map((date) => ({ date,
  total: { times: fiveTimes, amount_yi: Array(48).fill(2), coverage: Array(48).fill(20), reason: null } })) };
const fake = (day = "2026-11-05", trading = true) => async (_ctx: ServiceContext, req: { endpoint: string }) => {
  if (req.endpoint === "fetch_trade_calendar") return { envelope: cal(trading) };
  if (req.endpoint === "cn_etf_minute_batch") return { envelope: env(minute(day)) };
  if (req.endpoint === "cn_etf_minute_hist") return { envelope: env(five) };
  if (req.endpoint === "cn_broad_etf_universe") return { envelope: env({ items: BASKET.map((code) => ({ code, name: `基金${code}`, category: "沪深300", exchange: "SH" })) }) };
  if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: BASKET.map((code) => ({ code, name: code, pct: 1, quote_time: "20261105093100" })) }) };
  if (req.endpoint === "cn_etf_daily_batch") return { envelope: env({
    index: ["2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({ date, close: 3000 })),
    items: Object.fromEntries(BASKET.map((code) => [code, ["2026-11-03", "2026-11-04"].map((date) => ({ date, close: 1, amount_yi: 1 }))])), missing: [],
  }) };
  throw new Error(req.endpoint);
};

test("barAxisMax 档位、开盘十根抑制与极端峰值封顶", () => {
  assert.equal(barAxisMax([]), 10);
  assert.equal(barAxisMax([100, ...Array(20).fill(4)]), 25);
  assert.equal(barAxisMax(Array(20).fill(18)), 20);
  assert.equal(barAxisMax(Array(20).fill(84)), 100);
});

test("241 槽与 5 分钟精确锚点、分钟插值", () => {
  assert.equal(MINUTE_SLOTS.length, 241);
  assert.equal(MINUTE_SLOTS[0], "09:30"); assert.equal(MINUTE_SLOTS[120], "11:30");
  assert.equal(MINUTE_SLOTS[121], "13:01"); assert.equal(MINUTE_SLOTS[240], "15:00");
  const curve = interpolateFive(fiveTimes, Array(48).fill(2));
  assert.equal(curve[0], 0); assert.equal(curve[5], 2); assert.equal(curve[2], 0.8);
  assert.equal(curve[120], 48); assert.equal(curve[121], 48.4); assert.equal(curve[240], 96);
  const missing = minuteCumulative(["09:31", "09:32", "09:33"], [1, null, 3]);
  assert.equal(missing[1], 1); assert.equal(missing[2], null); assert.equal(missing[3], null);
});

test("poll 只在今日交易且分钟日期一致时标今日；cum 对比日与均值", async () => {
  const folder = root();
  try {
    const now = new Date("2026-11-05T02:00:00Z");
    const poll = await etfFlowPoll(ctx(folder), signal, fake() as never, now);
    assert.equal(poll.is_today, true); assert.equal(poll.poll_ms, 60_000);
    assert.equal(poll.ranking.length, 20); assert.equal(poll.ranking[0]?.name, `基金${BASKET[0]}`);
    assert.equal(poll.ranking[0]?.share_pct, 5);
    assert.equal(poll.ranking[0]?.pct, 100, "涨跌幅按分钟末价和前一交易日收盘价计算");
    const oneThinMinute = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_minute_batch"
      ? { envelope: env({ ...minute(), total: { ...minute().total, coverage: [19] } }) }
      : fake()(c, req);
    const thin = await etfFlowPoll(ctx(folder), signal, oneThinMinute as never, now);
    assert.equal(thin.ranking[0]?.share_pct, 5);
    assert.equal(thin.bars.reason, "有 1 个分钟点不足 20 只 ETF，按已取到的合计");
    assert.doesNotMatch(thin.bars.reason ?? "", /coverage/);
    const oneMissingMinute = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_minute_batch"
      ? { envelope: env({ ...minute(), success_count: 19, total: { ...minute().total, amount_yi: null },
        items: Object.fromEntries(BASKET.slice(1).map((code) => [code, minute().items[code]])) }) }
      : fake()(c, req);
    const missingShare = await etfFlowPoll(ctx(folder), signal, oneMissingMinute as never, now);
    assert.equal(missingShare.ranking[0]?.share_pct, null);
    assert.match(missingShare.ranking[0]?.reason ?? "", /无法计算占比/);
    const old = await etfFlowPoll(ctx(folder), signal, fake("2026-11-04") as never, now);
    assert.equal(old.is_today, false);
    assert.equal(old.ranking[0]?.pct, 100, "盘前保留上一交易日的实际涨跌幅");
    const noPrior = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_daily_batch"
      ? { envelope: env({ index: [{ date: "2026-11-05", close: 3000 }], items: {}, missing: [] }) }
      : fake()(c, req);
    const noPriorPoll = await etfFlowPoll(ctx(folder), signal, noPrior as never, now);
    assert.equal(noPriorPoll.ranking[0]?.pct, null);
    assert.match(noPriorPoll.ranking[0]?.pct_reason ?? "", /上一交易日/);
    const holiday = await etfFlowPoll(ctx(folder), signal, fake("2026-11-04", false) as never, now);
    assert.equal(holiday.is_today, false); assert.equal(holiday.poll_ms, 300_000);
    const cum = await etfFlowCum(ctx(folder), undefined, signal, fake() as never, now);
    assert.equal(cum.today.length, 241); assert.equal(cum.today[0], 0); assert.equal(cum.today[1], 20); assert.equal(cum.today[2], null);
    assert.equal(cum.comparison.date, "2026-11-04"); assert.equal(cum.average20.n, 2);
    const beforeOpen = await etfFlowCum(ctx(folder), undefined, signal, fake("2026-11-04") as never, new Date("2026-11-05T01:00:00Z"));
    assert.equal(beforeOpen.comparison.date, "2026-11-04"); assert.equal(beforeOpen.average20.n, 2);
    assert.equal(beforeOpen.today.every((x) => x === null), true);
    await assert.rejects(etfFlowCum(ctx(folder), "2026-11-06", signal, fake() as never, now), /对比日/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("申赎 T-1、缺份额不按零、放量阈值和近期三日同组", () => {
  assert.equal(netFlow(10, 9, 2), 2);
  assert.equal(netFlow(null, 9, 2), null);
  const code = BASKET[0];
  const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const prices = new Map(BASKET.map((c) => [c, new Map(dates.map((date) => [date, { date, close: 2, amount_yi: 5 }]))] as const));
  const allShares = Object.fromEntries(BASKET.map((c) => [c, 10]));
  const shares = { version: 1 as const, dates: { "20261102": allShares, "20261103": { ...allShares, [code]: 61 },
    "20261104": { ...allShares, [code]: 61, [BASKET[1]]: undefined as unknown as number }, "20261105": allShares } };
  const out = calculateDaily(dates, new Map(dates.map((d) => [d, 3000])), prices,
    BASKET.map((c) => ({ code: c, name: "基金", category: "沪深300", exchange: "SH" })), shares, "2026-11-05");
  assert.equal(out.rows[1]?.basket.net_yi, 102); assert.ok(out.rows[1]!.basket.net_yi! > SPIKE_THRESHOLD_YI);
  assert.deepEqual(out.spike_dates, ["2026-11-03"]);
  assert.equal(out.rows[2]?.basket.net_yi, null); assert.equal(out.rows[2]?.basket.missing_count, 1);
  assert.equal(out.rows[2]?.categories["沪深300"]?.net_yi, null);
  assert.equal(out.rows[2]?.basket.status, "待公布");
  assert.equal(out.rows[3]?.basket.status, "待公布"); assert.equal(out.rows[3]?.basket.net_yi, null);
  assert.deepEqual(out.recent_dates, ["2026-11-03", "2026-11-04", "2026-11-05"]);
  assert.deepEqual(out.recent_month_categories.slice(-3).map((r) => r.date), out.recent_dates);
  prices.get(code)?.delete("2026-11-03");
  const noPrice = calculateDaily(dates, new Map(dates.map((d) => [d, 3000])), prices,
    BASKET.map((c) => ({ code: c, name: "基金", category: "沪深300", exchange: "SH" })), shares, "2026-11-05");
  assert.equal(noPrice.rows[1]?.basket.net_yi, null);
  assert.equal(noPrice.rows[1]?.basket.price_missing_count, 1);
  assert.equal(noPrice.rows[1]?.categories["沪深300"]?.net_yi, null);
});

test("较早交易日缺份额标缺失，最近交易日仅缺份额标待公布", () => {
  const dates = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
  const prices = new Map(BASKET.map((code) => [code, new Map(dates.map((date) => [date, { date, close: 2, amount_yi: 1 }]))] as const));
  const full = Object.fromEntries(BASKET.map((code) => [code, 10]));
  const shares = { version: 1 as const, dates: { "20261102": full, "20261103": { ...full, [BASKET[0]]: undefined as unknown as number },
    "20261104": { ...full, [BASKET[1]]: undefined as unknown as number } } };
  const rows = calculateDaily(dates, new Map(), prices,
    BASKET.map((code) => ({ code, name: code, category: "沪深300", exchange: "SH" })), shares, "2026-11-05").rows;
  assert.equal(rows[1]?.basket.status, "份额缺失");
  assert.equal(rows[2]?.basket.status, "待公布");
  assert.equal(rows[2]?.basket.net_yi, null);
});

test("daily 与 typical 复用日线结果，收盘档案匹配交易日时优先读取", async () => {
  const folder = root();
  try {
    let dailyCalls = 0;
    const fetch = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "cn_etf_daily_batch") {
        dailyCalls++;
        return { envelope: env({ items: Object.fromEntries((req.args?.codes as string[]).map((code) => [code,
          ["2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({ date, close: 2, amount_yi: 1 }))])),
          index: ["2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({ date, close: 3000 })), missing: [] }) };
      }
      if (req.endpoint === "cn_etf_share_history_sh") return { envelope: env({ rows: [], failed: [] }) };
      if (req.endpoint === "cn_etf_share_history_sz") return { envelope: env({ rows: [] }) };
      return fake()(c, req);
    };
    const now = new Date("2026-11-05T02:00:00Z");
    await etfFlowDaily(ctx(folder), signal, fetch as never, now);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
    await etfFlowDaily(ctx(folder), signal, fetch as never, now);
    const first = dailyCalls;
    await etfFlowTypical(ctx(folder), signal, fetch as never, now);
    assert.equal(dailyCalls, first);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
    const cachedFile = path.join(folder, "shortline", "etf_flow", "daily.json");
    fs.mkdirSync(path.dirname(cachedFile), { recursive: true });
    const cached = await etfFlowDaily(ctx(folder), signal, fetch as never, now);
    fs.writeFileSync(cachedFile, JSON.stringify(cached));
    await etfFlowDaily(ctx(folder), signal, fetch as never, now);
    assert.equal(dailyCalls, first);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("typical 样本不足返回 null 和明确原因", () => {
  assert.deepEqual(typicalGroup([]), { n: 0, values: null, reason: "样本不足（n=0）" });
  assert.equal(typicalGroup([Array(48).fill(1), Array(48).fill(2)]).values, null);
  const enough = typicalGroup([Array(48).fill(1), Array(48).fill(2), Array(48).fill(3)]);
  assert.equal(enough.n, 3); assert.equal(enough.values?.[0]?.p25, 1.5); assert.equal(enough.values?.[47]?.cumulative, 96);
});

test("旧 share_history.json 可读，宽基回填断点续传并报告交易日进度", async () => {
  const folder = root();
  try {
    const file = shareHistoryFile(folder);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, dates: { "20261103": { "510300": 10 }, "20261104": { "510300": 11 } } }));
    assert.equal(officialSharePair(loadShareHistory(folder), "510300", "2026-11-04")?.previous, 10);
    const calls: string[] = [];
    const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      calls.push(`${req.endpoint}:${JSON.stringify(req.args)}`);
      if (req.endpoint === "cn_etf_share_history_sh") return { envelope: env({ rows: [{ date: "2026-11-03", code: "510300", shares_10k: 100000 }, { date: "2026-11-04", code: "510300", shares_10k: 110000 }], failed: [] }) };
      if (req.endpoint === "cn_etf_share_history_sz") return { envelope: env({ rows: [{ date: "2026-11-04", shares_yi: 20 }] }) };
      throw new Error(req.endpoint);
    };
    startBroadShareBackfill(ctx(folder), ["2026-11-03", "2026-11-04"], ["510300", "159915"], fetch as never);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual([backfillProgress(folder).completed, backfillProgress(folder).total], [2, 2]);
    assert.equal(loadShareHistory(folder).dates["20261104"]?.["159915"], 20);
    const first = calls.length;
    startBroadShareBackfill(ctx(folder), ["2026-11-03", "2026-11-04"], ["510300", "159915"], fetch as never);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
    assert.equal(calls.length, first, "已完成的日期和代码不再拉取");
    startBroadShareBackfill(ctx(folder), ["2026-11-03", "2026-11-04", "2026-11-05"], ["510300", "159915"], fetch as never);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual([backfillProgress(folder).completed, backfillProgress(folder).total], [3, 3]);
    assert.equal(calls.length, first + 2, "新增一天只补上交所这天和深交所这天");
    assert.ok(calls.at(-1)?.includes('"start":"2026-11-05"'));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("份额回填重复失败按代码与日期去重并保留最新原因", async () => {
  const folder = root();
  try {
    let attempt = 0;
    const fetch = async () => { throw new Error(`失败 ${++attempt}`); };
    for (let i = 0; i < 2; i++) {
      startBroadShareBackfill(ctx(folder), ["2026-11-04"], ["510300"], fetch as never);
      for (let j = 0; j < 20 && backfillProgress(folder).syncing; j++) await new Promise((r) => setTimeout(r, 1));
    }
    assert.deepEqual(backfillProgress(folder).failed, [{ code: "SH", date: "2026-11-04", reason: "失败 2" }]);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("15:40 收盘任务写日度缓存和当日分钟档案，不重跑旧份额同步", async () => {
  const folder = root();
  try {
    const calls: string[] = [];
    const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      calls.push(req.endpoint);
      if (req.endpoint === "cn_broad_etf_universe") return { envelope: env({ items: BASKET.map((code) => ({ code, name: code, category: "沪深300", exchange: code.startsWith("15") ? "SZ" : "SH" })) }) };
      if (req.endpoint === "cn_etf_daily_batch") return { envelope: env({
        items: Object.fromEntries((req.args?.codes as string[]).map((code) => [code, ["2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({ date, close: 2, amount_yi: 1 }))])),
        index: req.args?.include_index ? ["2026-11-03", "2026-11-04", "2026-11-05"].map((date) => ({ date, close: 3000 })) : null, missing: [] }) };
      if (req.endpoint === "cn_etf_minute_hist") return { envelope: env({ days: [{ date: "2026-11-05", total: { times: fiveTimes, amount_yi: Array(48).fill(1), coverage: Array(48).fill(20), reason: null } }] }) };
      if (req.endpoint === "cn_etf_share_history_sh") return { envelope: env({ rows: [], failed: [] }) };
      if (req.endpoint === "cn_etf_share_history_sz") return { envelope: env({ rows: [] }) };
      throw new Error(req.endpoint);
    };
    const job = { ctx: ctx(folder), day: "2026-11-05", now: new Date("2026-11-05T07:40:00Z"), signal, state: undefined, manual: false };
    const result = await etfFlowClose(job, fetch as never);
    assert.match(result.note ?? "", /日度缓存与 5 分钟档案已更新/);
    assert.ok(fs.existsSync(path.join(folder, "shortline", "etf_flow", "minute", "20261105.json")));
    assert.ok(fs.existsSync(path.join(folder, "shortline", "etf_flow", "daily.json")));
    assert.equal(calls.includes("etf_shares"), false);
    for (let i = 0; i < 20 && backfillProgress(folder).syncing; i++) await new Promise((r) => setTimeout(r, 1));
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
