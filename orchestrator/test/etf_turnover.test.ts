import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServiceContext } from "../src/service.ts";
import { FINANCE_SCHEDULE } from "../src/finance/schedule.ts";
import { CORE_CODES, calcItem, dayProgress, etfTurnoverClose, etfTurnoverPoll, loadWatch, previousShares, saveShares, saveWatch, shapeAt, sharesSuspect, validateWatch, verdict } from "../src/finance/shortline/etf_turnover.ts";

const signal = new AbortController().signal;
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "etf-turnover-"));
const ctx = (dataRoot: string): ServiceContext => ({ repoRoot: process.cwd(), dataRoot, python: "python3", node: process.execPath });
const env = (result: unknown) => ({ status: "ok", evidence: [], extra: { result } });
const fetch = async (_ctx: ServiceContext, req: { endpoint: string }) => {
  if (req.endpoint === "fetch_trade_calendar") return { envelope: { status: "failed" } };
  if (req.endpoint === "cn_etf_turnover_baseline") return { envelope: env({ items: CORE_CODES.map((code) => ({ code, name: code, group: "core", avg20_yi: 10, shape: Array(48).fill(0.5), hist: [] })), missing: [] }) };
  if (req.endpoint === "cn_etf_turnover_live") return { envelope: env({ items: CORE_CODES.map((code) => ({ code, name: code, group: "core", price: 2, pct: -1, amount_yi: 20, mktcap_yi: 100, shares: 2, outer_lots: 60, inner_lots: 40, quote_time: "20261009150000" })), missing: [] }) };
  throw new Error(req.endpoint);
};

test("五档判断与附句", () => {
  assert.deepEqual([[1.8, 1], [1.3, 1], [1.8, -1], [1.3, -1], [1.29, 1]].map(([r, n]) => verdict(r!, n!, null, null, null).level), ["strong", "medium", "sell", "unclear", "quiet"]);
  const reason = verdict(2, 3, 0.3, 0.2, -0.6).reason;
  assert.match(reason, /1.25 倍/); assert.match(reason, /价格回落/); assert.match(reason, /不能证明任何机构当日交易/);
});

test("午休锁与旧日全天比", () => {
  const shape = Array.from({ length: 48 }, (_, i) => (i + 1) / 48);
  assert.equal(shapeAt(shape, "11:30"), shapeAt(shape, "12:30"));
  assert.equal(dayProgress("09:30", null), 0.12);
  assert.equal(dayProgress("10:00", shape, true), 1);
  const item = calcItem({ code: "510300", group: "core", avg20_yi: 10, shape }, { code: "510300", price: 2, amount_yi: 20, outer_lots: 60, inner_lots: 40 }, null, "10:00", true);
  assert.equal(item.ratio, 2); assert.equal(item.net_yi, 4);
});

test("份额自检与快照读写", () => {
  const folder = root();
  try {
    saveShares(folder, "2026-10-09", [{ code: "510300", shares: 2 }, { code: "510310", shares: 3 }]);
    assert.deepEqual(previousShares(folder, "2026-10-12"), { date: "2026-10-09", shares: { "510300": 2, "510310": 3 } });
    assert.deepEqual([...sharesSuspect([{ code: "510300", shares: 2.001, prev_shares: 2 }, { code: "510310", shares: 3.002, prev_shares: 3 }])], ["5"]);
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

test("收盘作业 fresh 取数，只写份额快照", async () => {
  assert.ok(FINANCE_SCHEDULE.jobs.some((x) => x.id === "etf_turnover_close" && x.at === "15:35"));
  const folder = root();
  try {
    const calls: string[] = [];
    const tracked = async (c: ServiceContext, req: { endpoint: string; consistency?: { mode: string } }) => { calls.push(`${req.endpoint}:${req.consistency?.mode}`); return fetch(c, req); };
    const result = await etfTurnoverClose({ ctx: ctx(folder), day: "2026-10-12", now: new Date(), signal, state: undefined, manual: true }, tracked);
    assert.match(result.note ?? "", /份额快照 20 只/);
    assert.deepEqual(calls, ["cn_etf_turnover_baseline:fresh", "cn_etf_turnover_live:fresh"]);
    assert.equal(previousShares(folder, "2026-10-13").shares["510300"], 2);
    assert.equal(fs.existsSync(path.join(folder, "ledger")), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
