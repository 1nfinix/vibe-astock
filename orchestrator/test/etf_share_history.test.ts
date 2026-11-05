import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServiceContext } from "../src/service.ts";
import { CORE_CODES } from "../src/finance/shortline/etf_turnover.ts";
import { loadShareHistory, officialSharePair, previousHistoryShares, shareHistoryFile, shareSeries, syncShareHistory, resetShareHistoryState, type ShareStore } from "../src/finance/shortline/etf_share_history.ts";

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "etf-share-"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: process.cwd(), dataRoot, python: "python3", node: process.execPath });
const env = (result: unknown) => ({ status: "ok", extra: { result }, evidence: [] });
const days = ["2026-11-02", "2026-11-03", "2026-11-04"];
function fake(calls: string[], failDate?: string) {
  return async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
    calls.push(`${req.endpoint}:${req.args?.code ?? req.args?.date ?? ""}:${req.args?.start ?? ""}`);
    if (req.endpoint === "cn_etf_share_history_sz") return { envelope: env({ rows: days.filter((d) => d >= String(req.args?.start)).map((d, i) => ({ date: d, shares_yi: 100 + i })) }) };
    if (req.endpoint === "etf_shares") {
      if (req.args?.date === failDate) throw Error("上交所暂不可用");
      return { envelope: env({ rows: CORE_CODES.filter((c) => !c.startsWith("159")).map((code) => ({ code, shares_10k: 2_000_000 })) }) };
    }
    throw Error(req.endpoint);
  };
}
test("首次回补、增量缺口与单日失败保留成功数据", async () => {
  const dir = root(), calls: string[] = [];
  try {
    const missing = await syncShareHistory(ctx(dir), fake(calls, "2026-11-03"), "2026-11-04");
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.date, "2026-11-03");
    const first = loadShareHistory(dir);
    assert.equal(first.dates["20261103"]?.["159919"], 101);
    assert.equal(first.dates["20261103"]?.["510300"], undefined);
    calls.length = 0;
    await syncShareHistory(ctx(dir), fake(calls), "2026-11-04");
    assert.equal(calls.filter((x) => x.startsWith("etf_shares")).length, 1);
    assert.equal(calls.filter((x) => x.startsWith("cn_etf_share_history_sz")).length, 0);
    assert.equal(loadShareHistory(dir).dates["20261103"]?.["510300"], 200);
  } finally { resetShareHistoryState(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("前值顺延、差值、指数和窗口截断", () => {
  const store: ShareStore = { version: 1, dates: {} };
  for (let i = 0; i < 245; i++) {
    const day = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10).replaceAll("-", "");
    store.dates[day] = { "510300": 100 + i, ...(i % 3 ? {} : { "159919": 10 }) };
  }
  for (const [n, size] of [[60, 60], [120, 120], [242, 242]] as const) {
    const series = shareSeries(store, n)!;
    assert.equal(series.deltas.length, size);
    assert.equal(series.index.length, size + 1);
    assert.equal(series.index[0]?.v, 100);
    assert.ok(Math.abs(series.deltas[0]!.d - 1) < 1e-9);
  }
  assert.equal(shareSeries({ version: 1, dates: { "20261103": { "510300": 1 } } }, 60), null);
  assert.equal(shareSeries({ version: 1, dates: { "20261102": { "510300": 100 }, "20261103": {}, "20261104": { "510300": 102 } } }, 60)?.deltas[0]?.d, 0);
  assert.equal(shareSeries({ version: 1, dates: { "20261102": { "510300": 100 }, "20261103": {}, "20261104": { "510300": 102 } } }, 60)?.index.at(-1)?.v, 102);
  assert.ok(previousHistoryShares(store, "2026-11-04").date);
});
test("同 dataRoot 单飞", async () => {
  const dir = root(), calls: string[] = [];
  try {
    const f = fake(calls);
    const a = syncShareHistory(ctx(dir), f, "2026-11-04");
    const b = syncShareHistory(ctx(dir), f, "2026-11-04");
    assert.equal(a, b);
    await a;
    assert.equal(calls.filter((x) => x.startsWith("cn_etf_share_history_sz")).length, CORE_CODES.filter((c) => c.startsWith("159")).length);
  } finally { resetShareHistoryState(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("行情申赎列在没有本地快照时回退到官方历史份额", async () => {
  const dir = root();
  try {
    fs.mkdirSync(path.join(dir, "shortline", "etf_turnover"), { recursive: true });
    fs.writeFileSync(path.join(dir, "shortline", "etf_turnover", "share_history.json"), JSON.stringify({ version: 1, dates: { "20261103": { "510300": 100 } } }));
    const { etfTurnoverPoll, resetEtfTurnoverState } = await import("../src/finance/shortline/etf_turnover.ts");
    const fetch = async (_ctx: ServiceContext, req: { endpoint: string }) => {
      if (req.endpoint === "fetch_trade_calendar") return { envelope: { status: "failed" } };
      if (req.endpoint === "cn_etf_turnover_baseline") return { envelope: env({ date: "2026-11-04", items: CORE_CODES.map((code) => ({ code, group: "core", avg20_yi: 10, shape: Array(48).fill(0.5), hist: [] })), missing: [] }) };
      if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: [{ code: "510300", price: 2, amount_yi: 10, shares: 101, outer_lots: 10, inner_lots: 10, quote_time: "20261104100000" }], missing: [] }) };
      throw Error(req.endpoint);
    };
    const view = await etfTurnoverPoll(ctx(dir), new AbortController().signal, fetch, new Date("2026-11-04T02:00:00Z"));
    assert.equal(view.previous_shares_date, "2026-11-03");
    assert.equal(view.items.find((x) => x.code === "510300")?.prev_shares, 100);
    resetEtfTurnoverState();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("申赎对比取日期更近的一份：官方历史比本地快照新时用历史", async () => {
  const { etfTurnoverPoll, resetEtfTurnoverState, saveShares, CORE_CODES } = await import("../src/finance/shortline/etf_turnover.ts");
  const { shareHistoryFile } = await import("../src/finance/shortline/etf_share_history.ts");
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  resetEtfTurnoverState();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "etf-prev-"));
  try {
    saveShares(folder, "2026-10-08", CORE_CODES.map((code) => ({ code, shares: 1 })));
    fs.mkdirSync(path.dirname(shareHistoryFile(folder)), { recursive: true });
    fs.writeFileSync(shareHistoryFile(folder), JSON.stringify({ version: 1, dates: { "20261009": Object.fromEntries(CORE_CODES.map((c) => [c, 2])) } }));
    const env = (result: unknown) => ({ status: "ok", evidence: [], extra: { result } });
    const fetch = async (_c: unknown, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "fetch_trade_calendar") return { envelope: { status: "failed" } };
      if (req.endpoint === "cn_etf_turnover_baseline") return { envelope: env({ date: "2026-10-12", items: [], missing: [] }) };
      return { envelope: env({ items: CORE_CODES.map((code) => ({ code, price: 2, amount_yi: 20, shares: 3, outer_lots: 6, inner_lots: 4, quote_time: "20261012100000" })) }) };
    };
    const v = await etfTurnoverPoll({ repoRoot: process.cwd(), dataRoot: folder, python: "python3", node: process.execPath } as never, new AbortController().signal, fetch as never, new Date("2026-10-12T02:00:00Z"), 5);
    assert.equal(v.previous_shares_date, "2026-10-09");
    assert.equal(v.items[0]?.prev_shares, 2);
    assert.equal(v.items[0]?.subscr_net_yi, 2);
    assert.equal(v.items[0]?.official_shares_date, undefined);
  } finally { resetEtfTurnoverState(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test("增量空区间和沪市尚未发布不记缺数，真实源错误仍记缺数", async () => {
  const dir = root();
  try {
    fs.mkdirSync(path.dirname(shareHistoryFile(dir)), { recursive: true });
    fs.writeFileSync(shareHistoryFile(dir), JSON.stringify({ version: 1, dates: { "20261104": { "159919": 1 } } }));
    const request = (error: string) => async (_ctx: ServiceContext, req: { endpoint: string }) => ({ envelope: req.endpoint === "etf_shares"
      ? { status: "failed", errors: [{ error }] }
      : env({ rows: [] }) });
    const unpublished = await syncShareHistory(ctx(dir), request("ValueError: 上交所 2026-11-04 没有 ETF 份额数据：非交易日或尚未发布"), "2026-11-05");
    assert.deepEqual(unpublished, []);
    const broken = await syncShareHistory(ctx(dir), request("RuntimeError: 上交所返回结构异常"), "2026-11-05");
    assert.equal(broken.length, 1);
    assert.match(broken[0]!.reason, /结构异常/);
    const deepFailed = await syncShareHistory(ctx(dir), async (_ctx, req) => ({ envelope: req.endpoint === "cn_etf_share_history_sz"
      ? { status: "failed", errors: [{ error: "HTTP 503" }] }
      : env({ rows: CORE_CODES.filter((code) => !code.startsWith("159")).map((code) => ({ code, shares_10k: 10_000 })) }) }), "2026-11-05");
    assert.equal(deepFailed.length, CORE_CODES.filter((code) => code.startsWith("159")).length);
  } finally { resetShareHistoryState(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("固定名单按两期官方份额估算，观察组仍按本机快照", async () => {
  const dir = root();
  try {
    const { etfTurnoverPoll, resetEtfTurnoverState, saveShares } = await import("../src/finance/shortline/etf_turnover.ts");
    saveShares(dir, "2026-11-03", [{ code: "588000", shares: 8 }, { code: "510300", shares: 1 }]);
    const before = Object.fromEntries(CORE_CODES.map((code) => [code, 100]));
    const after = { ...before, "510300": 105, "159919": 90 };
    fs.mkdirSync(path.dirname(shareHistoryFile(dir)), { recursive: true });
    fs.writeFileSync(shareHistoryFile(dir), JSON.stringify({ version: 1, dates: { "20261102": before, "20261103": after } }));
    assert.deepEqual(officialSharePair(loadShareHistory(dir), "510300", "2026-11-03"), { date: "2026-11-03", shares: 105, previous: 100 });
    assert.equal(officialSharePair(loadShareHistory(dir), "510300", "2026-11-02"), null);
    const fetch = async (_ctx: ServiceContext, req: { endpoint: string; args?: Record<string, unknown> }) => {
      if (req.endpoint === "fetch_trade_calendar") return { envelope: { status: "failed" } };
      if (req.endpoint === "cn_etf_turnover_baseline") return { envelope: env({ date: "2026-11-04", items: (req.args?.include_core === false ? ["588000"] : [...CORE_CODES]).map((code) => ({ code, group: code === "588000" ? "watch" : "core", avg20_yi: 10, shape: Array(48).fill(0.5), hist: [] })), missing: [] }) };
      if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: [...CORE_CODES, "588000"].map((code) => ({ code, price: 2, amount_yi: 10, shares: code === "588000" ? 9 : after[code as keyof typeof after], outer_lots: 10, inner_lots: 10, quote_time: "20261104100000" })), missing: [] }) };
      throw Error(req.endpoint);
    };
    const view = await etfTurnoverPoll(ctx(dir), new AbortController().signal, fetch, new Date("2026-11-04T02:00:00Z"));
    const core = view.items.find((item) => item.code === "510300")!;
    assert.equal(core.shares, 105);
    assert.equal(core.prev_shares, 100);
    assert.equal(core.subscr_net_yi, 10);
    assert.equal(core.official_shares_date, "2026-11-03");
    assert.equal(view.items.find((item) => item.code === "159919")?.subscr_net_yi, -20);
    const watch = view.items.find((item) => item.code === "588000")!;
    assert.equal(watch.prev_shares, 8);
    assert.equal(watch.subscr_net_yi, 2);
    assert.equal(watch.official_shares_date, undefined);
    assert.deepEqual(view.shares_suspect, []);
    resetEtfTurnoverState();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
