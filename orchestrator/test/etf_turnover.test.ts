import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServiceContext } from "../src/service.ts";
import { FINANCE_SCHEDULE } from "../src/finance/schedule.ts";
import { CORE_CODES, ETF_CODE_RE, MIN_PROGRESS, calcItem, dayProgress, etfTurnoverAct, etfTurnoverClose, etfTurnoverPoll, loadWatch, previousShares, resetEtfTurnoverCalendar, resetEtfTurnoverState, saveShares, saveWatch, shapeAt, sharesSuspect, timeAnnotation, validateWatch, verdict } from "../src/finance/shortline/etf_turnover.ts";

const signal = new AbortController().signal;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "etf-turnover-"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: process.cwd(), dataRoot, python: "python3", node: process.execPath });
const env = (result: unknown) => ({ status: "ok", evidence: [], extra: { result } });
const calendarEnv = (day: string) => ({ status: "ok", evidence: Object.entries({ last_trading_day: day, previous_trading_day: "2026-10-09", is_today_trading_day: true, session_phase: "trading" }).map(([field, value]) => ({ field, value, period: day })) });
const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
  if (req.endpoint === "fetch_trade_calendar") return { envelope: { status: "failed" } };
  if (req.endpoint === "cn_etf_turnover_baseline") return { envelope: env({ date: "2026-10-12", items: (req.args?.include_core === false ? req.args.extra_codes as string[] : [...CORE_CODES]).map((code) => ({ code, name: code, group: req.args?.include_core === false ? "watch" : "core", avg20_yi: 10, shape: Array(48).fill(0.5), hist: [] })), missing: [] }) };
  if (req.endpoint === "cn_etf_turnover_live") { assert.equal(req.args?.trade_date, undefined); return { envelope: env({ items: CORE_CODES.map((code) => ({ code, name: code, group: "core", price: 2, pct: -1, amount_yi: 20, mktcap_yi: 100, shares: 2, outer_lots: 60, inner_lots: 40, quote_time: "20261009150000" })), missing: [] }) }; }
  throw new Error(req.endpoint);
};

test("五档判断带数字，附句只出现在偏买档", () => {
  assert.deepEqual([[1.8, 1], [1.3, 1], [1.8, -1], [1.3, -1], [1.29, 1]].map(([r, n]) => verdict(r!, n!, null, null, null).level), ["strong", "medium", "sell", "unclear", "quiet"]);
  const starts = ["固定名单成交额达到", "成交额放大到", "成交额放大到", "成交额达到", "成交额只有"];
  [[2, 3], [1.5, 3], [2, -3], [1.5, -3], [1, 3]].forEach(([r, n], i) => {
    const reason = verdict(r!, n!, 0.3, 0.2, -0.6).reason;
    assert.match(reason, new RegExp(starts[i]!)); assert.match(reason, new RegExp(r!.toFixed(2)));
    assert.match(reason, new RegExp(n!.toFixed(2))); assert.match(reason, /这是量价现象，不能证明任何机构当日交易/);
    if (i < 2) { assert.match(reason, /尾盘半小时成交占全天 30.0%/); assert.match(reason, /池内规模加权涨跌 -0.60%/); }
    else { assert.doesNotMatch(reason, /尾盘半小时|下跌日放量/); }
  });
  assert.match(verdict(1.5, 3, null, null, null).reason, /1.8×/);
  assert.match(verdict(2, -3, null, null, null).reason, /更像换手或卖出/);
  assert.match(verdict(1.5, -3, null, null, null).reason, /方向不清晰/);
  assert.match(verdict(1, 3, null, null, null).reason, /量价平静/);
  // 只写已发生的量价现象，不推断「护盘」意图
  const strong = verdict(2, 3, 0.3, 0.2, -0.6).reason;
  assert.match(strong, /放量与主动净买入同向。/); assert.match(strong, /放量发生在下跌日/);
  assert.doesNotMatch(strong, /护盘/);
});

test("时点括注覆盖旧日、午休、盘中与非交易时段", () => {
  assert.match(timeAnnotation("stale", "2026-11-03", "15:00", 100), /实时行情不是今日数据.*2026-11-03 周二.*全天基准/);
  assert.match(timeAnnotation("lunch", "2026-11-04", "11:30", 50), /午间休市.*11:30.*50.0%/);
  assert.match(timeAnnotation("intraday", "2026-11-04", "10:30", 27), /10:30.*27.0%.*分母已同比例缩小/);
  assert.match(timeAnnotation("closed", "2026-11-03", "15:00", 100), /非交易时段.*2026-11-03 周二.*开盘后自动切换实时/);
  assert.equal(timeAnnotation("none", "2026-11-04", "15:00", 100), "");
  assert.match(verdict(1.5, 3, null, null, null, timeAnnotation("lunch", "2026-11-04", "11:30", 50)).reason, /）。这是量价现象/);
});

test("午休锁与旧日全天比", () => {
  const shape = Array.from({ length: 48 }, (_, i) => (i + 1) / 48);
  assert.equal(shapeAt(shape, "11:30"), shapeAt(shape, "12:30"));
  assert.equal(dayProgress("09:30", null), 0.12);
  assert.equal(dayProgress("09:35", Array(48).fill(0.05)), 0.05);
  // 曲线值很小时照用曲线，不再跳到 0.12；开盘第一分钟有下限防除以 0
  assert.equal(dayProgress("09:35", Array(48).fill(0.01)), 0.01);
  assert.equal(dayProgress("09:30", Array(48).fill(0.05)), MIN_PROGRESS);
  // 跨 0.02 前后连续：09:31 与 09:32 的进度差应与曲线插值一致，没有 4 倍跳变
  const early = Array.from({ length: 48 }, (_, i) => Math.min(1, 0.05 + i * 0.02));
  const p1 = dayProgress("09:31", early), p2 = dayProgress("09:32", early);
  assert.ok(Math.abs(p1 - 0.01) < 1e-9 && Math.abs(p2 - 0.02) < 1e-9);
  assert.equal(dayProgress("10:00", shape, true), 1);
  const item = calcItem({ code: "510300", group: "core", avg20_yi: 10, shape }, { code: "510300", price: 2, amount_yi: 20, outer_lots: 60, inner_lots: 40 }, null, "10:00", true);
  assert.equal(item.ratio, 2); assert.equal(item.net_yi, 4);
  assert.equal(calcItem({ code: "510300", name: "沪深300ETF华泰柏瑞", group: "core" }, { code: "510300", name: "腾讯简称" }, null, "10:00", false).name, "沪深300ETF华泰柏瑞");
  assert.equal(calcItem({ code: "512345", name: "512345", group: "watch" }, { code: "512345", name: "新增标的名称" }, null, "10:00", false).name, "新增标的名称");
});

test("份额自检与快照读写", () => {
  const folder = root();
  try {
    saveShares(folder, "2026-10-09", [{ code: "510300", shares: 2 }, { code: "510310", shares: 3 }]);
    assert.deepEqual(previousShares(folder, "2026-10-12"), { date: "2026-10-09", shares: { "510300": 2, "510310": 3 } });
    assert.deepEqual([...sharesSuspect([{ code: "510300", shares: 2.001, prev_shares: 2 }, { code: "510310", shares: 3.002, prev_shares: 3 }])], []);
    assert.deepEqual([...sharesSuspect([{ code: "510300", shares: 2.001, prev_shares: 2 }, { code: "510310", shares: 3.002, prev_shares: 3 }, { code: "510050", shares: 4.002, prev_shares: 4 }])], ["5"]);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("固定名单不可编辑，观察组不入合计", async () => {
  assert.throws(() => validateWatch(["000001"])); assert.throws(() => validateWatch(["510300"]));
  assert.deepEqual(validateWatch(["588000", "588000"]), ["588000"]);
  const folder = root();
  try {
    assert.equal(loadWatch(folder).length, 4); saveWatch(folder, ["588000"]); assert.deepEqual(loadWatch(folder), ["588000"]);
    const view = await etfTurnoverPoll(ctx(folder), signal, fetch, new Date("2026-10-12T02:00:00Z"));
    assert.equal(view.totals.amount_yi, 400); assert.equal(view.totals.ratio, 2);
    assert.equal(view.items.filter((x) => x.group === "watch").length, 1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("固定组 baseline 参数稳定，观察组单独取数；同日收盘无括注", async () => {
  const folder = root();
  try {
    const calls: Record<string, unknown>[] = [];
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "cn_etf_turnover_baseline") calls.push(req.args ?? {});
      if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: CORE_CODES.map((code) => ({ code, name: code, group: "core", price: 2, amount_yi: 20, outer_lots: 60, inner_lots: 40, quote_time: "20261012150000" })), missing: [] }) };
      return fetch(c, req);
    };
    saveWatch(folder, ["588000"]);
    const first = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T07:30:00Z"));
    saveWatch(folder, ["588000", "512345"]);
    const second = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T07:31:00Z"));
    assert.deepEqual(calls, [
      { trade_date: "2026-10-12", extra_codes: [] }, { trade_date: "2026-10-12", extra_codes: ["588000"], include_core: false },
      { trade_date: "2026-10-12", extra_codes: [] }, { trade_date: "2026-10-12", extra_codes: ["588000", "512345"], include_core: false },
    ]);
    assert.equal(first.items.filter((x) => x.group === "core").length, 20);
    assert.equal(second.items.filter((x) => x.group === "watch").length, 2);
    assert.doesNotMatch(second.verdict.reason, /非交易时段|（/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("ETF 日历同日成功 30 分钟内复用，过期与跨日重新取", async () => {
  resetEtfTurnoverCalendar();
  const folder = root();
  try {
    let calls = 0;
    let day = "2026-10-12";
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "fetch_trade_calendar") { calls++; return { envelope: calendarEnv(day) }; }
      return fetch(c, req);
    };
    const poll = (iso: string) => etfTurnoverPoll(ctx(folder), signal, tracked, new Date(iso));
    await poll("2026-10-12T02:00:00Z");
    await poll("2026-10-12T02:01:00Z");
    assert.equal(calls, 1);
    await poll("2026-10-12T02:30:00Z");
    assert.equal(calls, 2);
    day = "2026-10-13";
    await poll("2026-10-13T02:00:00Z");
    assert.equal(calls, 3);
  } finally { resetEtfTurnoverCalendar(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("ETF 日历失败后 60 秒内不重试，过期再取", async () => {
  resetEtfTurnoverCalendar();
  const folder = root();
  try {
    let calls = 0;
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "fetch_trade_calendar") { calls++; return { envelope: { status: "failed" } }; }
      return fetch(c, req);
    };
    const poll = (iso: string) => etfTurnoverPoll(ctx(folder), signal, tracked, new Date(iso));
    await poll("2026-10-12T02:00:00Z");
    await poll("2026-10-12T02:00:59Z");
    assert.equal(calls, 1);
    await poll("2026-10-12T02:01:00Z");
    assert.equal(calls, 2);
  } finally { resetEtfTurnoverCalendar(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("实时端点返回失败时保留上一轮读数并标记连接断开", async () => {
  const folder = root();
  try {
    const first = await etfTurnoverPoll(ctx(folder), signal, fetch, new Date("2026-10-12T02:00:00Z"));
    const failed = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_live"
      ? { envelope: { status: "failed", errors: [{ message: "接口失败" }] } } : fetch(c, req);
    const second = await etfTurnoverPoll(ctx(folder), signal, failed, new Date("2026-10-12T02:01:00Z"));
    assert.equal(second.totals.amount_yi, first.totals.amount_yi);
    assert.equal(second.data_connected, false);
    assert.match(second.notes.at(-1) ?? "", /实时行情未取到/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("收盘作业 fresh 取数并同步官方份额历史", async () => {
  assert.ok(FINANCE_SCHEDULE.jobs.some((x) => x.id === "etf_turnover_close" && x.at === "15:35"));
  const folder = root();
  try {
    const calls: string[] = [];
    const tracked = async (c: ServiceContext, req: { endpoint: string; consistency?: { mode: string } }) => { calls.push(`${req.endpoint}:${req.consistency?.mode}`); return fetch(c, req); };
    const result = await etfTurnoverClose({ ctx: ctx(folder), day: "2026-10-12", now: new Date(), signal, state: undefined, manual: true }, tracked);
    assert.match(result.note ?? "", /份额快照 20 只/);
    assert.match(result.note ?? "", /今日官方份额尚未全部发布/);
    assert.deepEqual(calls.slice(0, 3), ["cn_etf_turnover_baseline:fresh", "cn_etf_turnover_baseline:fresh", "cn_etf_turnover_live:fresh"]);
    assert.equal(calls.filter((x) => x.startsWith("cn_etf_share_history_sz:")).length, CORE_CODES.filter((x) => x.startsWith("159")).length);
    assert.equal(previousShares(folder, "2026-10-13").shares["510300"], 2);
    assert.equal(fs.existsSync(path.join(folder, "ledger")), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test("慢基准按上限返回，后台完成后复用；请求取消不影响基准", async () => {
  resetEtfTurnoverState();
  const folder = root(), request = new AbortController();
  try {
    let release!: (value: ReturnType<typeof env>) => void;
    const delayed = new Promise<ReturnType<typeof env>>((resolve) => { release = resolve; });
    const tracked = async (c: ServiceContext, req: { endpoint: string; signal?: AbortSignal }) => {
      if (req.endpoint === "cn_etf_turnover_baseline") { assert.equal(req.signal?.aborted, false); return { envelope: await delayed }; }
      return fetch(c, req);
    };
    const started = Date.now();
    const first = await etfTurnoverPoll(ctx(folder), request.signal, tracked, new Date("2026-10-12T02:00:00Z"), 10);
    assert.ok(Date.now() - started < 500);
    assert.equal(first.items[0]?.avg20_yi, null);
    assert.match(first.notes.join(" "), /近 20 日基准计算中，稍后自动刷新/);
    request.abort();
    release(env({ date: "2026-10-12", items: CORE_CODES.map((code) => ({ code, group: "core", avg20_yi: 10 })), missing: [] }));
    await delayed;
    const second = await etfTurnoverPoll(ctx(folder), signal, fetch, new Date("2026-10-12T02:01:00Z"), 10);
    assert.equal(second.items[0]?.avg20_yi, 10);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("partial 基准后台 fresh 重取，十分钟内只重试一次", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    let fresh = 0;
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown>; consistency?: { mode: string } }) => {
      if (req.endpoint !== "cn_etf_turnover_baseline") return fetch(c, req);
      const isFresh = req.consistency?.mode === "fresh";
      if (isFresh) fresh++;
      const codes = req.args?.include_core === false ? req.args.extra_codes as string[] : [...CORE_CODES];
      return { envelope: env({ date: req.args?.trade_date, items: codes.map((code) => ({ code, group: req.args?.include_core === false ? "watch" : "core", avg20_yi: isFresh ? 12 : 10 })), missing: isFresh ? [] : [{ code: codes[0], reason: "缺数" }] }) };
    };
    await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T02:00:00Z"));
    await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T02:01:00Z"));
    assert.equal(fresh, 2);
    const view = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T02:02:00Z"));
    assert.equal(view.items[0]?.avg20_yi, 12);
    assert.equal(fresh, 2);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("取数 reject 与 failed 信封按失败处理", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    await etfTurnoverPoll(ctx(folder), signal, fetch, new Date("2026-10-12T02:00:00Z"));
    const rejected = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_live" ? Promise.reject(new Error("网络断开")) : fetch(c, req);
    const fallback = await etfTurnoverPoll(ctx(folder), signal, rejected, new Date("2026-10-12T02:01:00Z"));
    assert.equal(fallback.data_connected, false);
    assert.match(fallback.notes.join(" "), /实时行情未取到/);
    const failed = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_live"
      ? { envelope: { ...env({ items: [{ code: "510300", amount_yi: 20 }] }), status: "failed" } } : req.endpoint === "cn_etf_turnover_baseline"
        ? { envelope: { ...env({ items: [{ code: "510300", avg20_yi: 10 }] }), status: "failed" } } : fetch(c, req);
    const view = await etfTurnoverPoll(ctx(folder), signal, failed, new Date("2026-10-13T02:00:00Z"));
    assert.equal(view.data_connected, false);
    assert.match(view.notes.join(" "), /基准未取到.*实时行情未取到/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("基准 reject 不使 poll 失败，已有基准任务超时用上次结果", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    const baselineRejected = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_baseline" ? Promise.reject(new Error("历史源断开")) : fetch(c, req);
    const missing = await etfTurnoverPoll(ctx(folder), signal, baselineRejected, new Date("2026-10-12T02:00:00Z"), 10);
    assert.equal(missing.items[0]?.avg20_yi, null);
    assert.match(missing.notes.join(" "), /基准未取到.*历史源断开/);
    await etfTurnoverPoll(ctx(folder), signal, fetch, new Date("2026-10-12T02:01:00Z"));
    const never = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_baseline"
      ? new Promise<{ envelope: ReturnType<typeof env> }>(() => {}) : fetch(c, req);
    const cached = await etfTurnoverPoll(ctx(folder), signal, never, new Date("2026-10-12T02:02:00Z"), 10);
    assert.equal(cached.items[0]?.avg20_yi, 10);
    assert.match(cached.notes.join(" "), /近 20 日基准计算中，暂用上次结果/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("竞价当天等待开盘，昨日行情保留 stale；周六基准按周五行情日", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    const calls: string[] = [];
    let quote = "20261012092000";
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "cn_etf_turnover_baseline") calls.push(String(req.args?.trade_date));
      if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: CORE_CODES.map((code) => ({ code, group: "core", amount_yi: 20, outer_lots: 60, inner_lots: 40, quote_time: quote })) }) };
      return fetch(c, req);
    };
    const auction = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T01:20:00Z"));
    assert.equal(auction.verdict.title, "等待开盘"); assert.equal(auction.waiting_open, true); assert.equal(auction.totals.ratio, null); assert.equal(auction.totals.expected_yi, null); assert.equal(auction.items[0]?.ratio, null);
    quote = "20261009150000";
    const stale = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T01:10:00Z"));
    assert.equal(stale.stale, true); assert.notEqual(stale.verdict.title, "等待开盘");
    // 周五收盘作业已写周五快照、更早有周四快照：周六看周五行情时，申赎应对比周四
    saveShares(folder, "2026-10-08", CORE_CODES.map((code) => ({ code, shares: 1 })));
    saveShares(folder, "2026-10-09", CORE_CODES.map((code) => ({ code, shares: 1.5 })));
    const saturday = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-10T02:00:00Z"));
    assert.equal(saturday.baseline_date, "2026-10-09");
    assert.ok(calls.includes("2026-10-09"));
    assert.equal(saturday.previous_shares_date, "2026-10-08");
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("收盘 failed 基准与份额按状态判定，保存观察组后刷新失败仍返回视图", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    const failedBase = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_baseline"
      ? { envelope: { ...env({ items: [] }), status: "failed", errors: [{ source: "基准源", error: "失败" }] } } : fetch(c, req);
    const job = { ctx: ctx(folder), day: "2026-10-12", now: new Date(), signal, state: undefined, manual: true };
    const partial = await etfTurnoverClose(job, failedBase);
    assert.match(partial.note ?? "", /基准失败.*基准源 失败.*份额快照 20 只/);
    const allFailed = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_live"
      ? { envelope: { ...env({ items: [{ code: "510300", shares: 2 }] }), status: "failed" } } : failedBase(c, req);
    await assert.rejects(etfTurnoverClose(job, allFailed), /基准与份额均失败/);
    const failedLive = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_live" ? Promise.reject(new Error("网络断开")) : fetch(c, req);
    const saved = await etfTurnoverAct(ctx(folder), { action: "set_watch", codes: ["588000"] }, signal, failedLive, new Date("2026-10-12T02:00:00Z"));
    assert.deepEqual(saved.watch_codes, ["588000"]);
    assert.ok(loadWatch(folder).includes("588000"));
    assert.match(saved.notes.join(" "), /观察组已保存，行情刷新失败：/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("合计口径：成交额、倍数、净买入用同一批标的", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    // 第一只缺内外盘：净买入算不出，它的成交额也不进合计
    const oneNoLots = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint !== "cn_etf_turnover_live") return fetch(c, req);
      return { envelope: env({ items: CORE_CODES.map((code, i) => ({ code, group: "core", price: 2, pct: 1, amount_yi: 20, mktcap_yi: 100, outer_lots: i === 0 ? null : 60, inner_lots: i === 0 ? null : 40, quote_time: "20261012100000" })) }) };
    };
    const v = await etfTurnoverPoll(ctx(folder), signal, oneNoLots, new Date("2026-10-12T02:00:00Z"));
    assert.equal(v.covered_count, CORE_CODES.length - 1);
    assert.equal(v.totals.amount_yi, 20 * (CORE_CODES.length - 1));
    assert.ok(Math.abs(v.totals.net_yi! - 4 * (CORE_CODES.length - 1)) < 1e-9);
    assert.match(v.notes.join(" "), /20 只中 1 只缺基准、成交额或内外盘；成交额、倍数和净买入只合计其余 19 只/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("观察组清空时不取观察组基准；收盘作业不误报失败", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    saveWatch(folder, []);
    const calls: Record<string, unknown>[] = [];
    const tracked = async (c: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "cn_etf_turnover_baseline") calls.push(req.args ?? {});
      return fetch(c, req);
    };
    const v = await etfTurnoverPoll(ctx(folder), signal, tracked, new Date("2026-10-12T02:00:00Z"));
    assert.ok(calls.every((a) => a.include_core !== false));
    assert.doesNotMatch(v.notes.join(" "), /观察组/);
    calls.length = 0;
    const job = { ctx: ctx(folder), day: "2026-10-12", now: new Date(), signal, state: undefined, manual: true };
    const done = await etfTurnoverClose(job, tracked);
    assert.ok(calls.every((a) => a.include_core !== false));
    assert.match(done.note ?? "", /基准已更新/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("基准首次计算中只报一条，不再叠加「N 只缺基准」", async () => {
  resetEtfTurnoverState();
  const folder = root();
  try {
    const never = async (c: ServiceContext, req: { endpoint: string }) => req.endpoint === "cn_etf_turnover_baseline" ? new Promise<{ envelope: ReturnType<typeof env> }>(() => {}) : fetch(c, req);
    const v = await etfTurnoverPoll(ctx(folder), signal, never, new Date("2026-10-12T02:00:00Z"), 5);
    assert.match(v.notes.join(" "), /固定名单近 20 日基准计算中，稍后自动刷新/);
    assert.doesNotMatch(v.notes.join(" "), /只缺基准/);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("观察组代码只收沪深 ETF 段", () => {
  for (const ok of ["520500", "560010", "588000", "159338"]) assert.ok(ETF_CODE_RE.test(ok), ok);
  for (const bad of ["113001", "123001", "160105", "501050"]) assert.throws(() => validateWatch([bad]), /51\/52\/56\/58\/159/, bad);
  assert.deepEqual(validateWatch(["588000", "588000", "159338"]), ["588000", "159338"]);
});
