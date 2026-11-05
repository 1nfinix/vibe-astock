import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServiceContext } from "../src/service.ts";
import { CORE_CODES } from "../src/finance/shortline/etf_turnover.ts";
import { loadShareHistory, previousHistoryShares, shareSeries, syncShareHistory, resetShareHistoryState, type ShareStore } from "../src/finance/shortline/etf_share_history.ts";

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
