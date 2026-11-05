/** 固定 20 只 ETF 的交易所官方份额历史；机器数据只留在本机文件。 */
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../../fsutil.ts";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { CORE_CODES } from "./etf_turnover.ts";

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;
export type ShareStore = { version: 1; dates: Record<string, Record<string, number>> };
export type ShareMissing = { code: string; date?: string; reason: string };
export type ShareRange = { deltas: { date: string; d: number }[]; index: { date: string; v: number }[] };
const pending = new Map<string, Promise<ShareMissing[]>>();
export const shareHistoryFile = (root: string) => path.join(root, "shortline", "etf_turnover", "share_history.json");
const iso = (day: string) => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
const compact = (day: string) => day.replaceAll("-", "");
const dayOffset = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const obj = (x: unknown): Record<string, unknown> | null => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : null;
const result = (env: unknown): Record<string, unknown> | null => {
  const e = obj(env);
  return e?.status === "failed" ? null : obj(obj(e?.extra)?.result);
};
const reasonOf = (env: unknown) => {
  const e = obj(env);
  const errors = Array.isArray(e?.errors) ? e.errors : [];
  return String(e?.reason ?? obj(errors[0])?.error ?? e?.degraded_reason ?? "数据源没有返回有效份额");
};
export function loadShareHistory(root: string): ShareStore {
  try {
    const x = JSON.parse(fs.readFileSync(shareHistoryFile(root), "utf8")) as ShareStore;
    if (x.version === 1 && x.dates && typeof x.dates === "object") return x;
  } catch { /* 尚未回补 */ }
  return { version: 1, dates: {} };
}
export function previousHistoryShares(store: ShareStore, day: string): { date: string | null; shares: Record<string, number> } {
  const dates = Object.keys(store.dates).filter((d) => d < compact(day)).sort();
  const key = dates.at(-1);
  if (!key) return { date: null, shares: {} };
  const shares: Record<string, number> = {};
  for (const d of dates) for (const code of CORE_CODES) {
    const value = store.dates[d]?.[code];
    if (typeof value === "number" && Number.isFinite(value)) shares[code] = value;
  }
  return { date: iso(key), shares };
}
export function shareSeries(store: ShareStore, requested: number): ShareRange | null {
  const dates = Object.keys(store.dates).sort();
  if (dates.length < 2) return null;
  const n = Math.min(requested, dates.length - 1);
  const selected = dates.slice(-(n + 1));
  const known = new Map<string, number>();
  // 窗口开始前已知份额也可顺延，不能把第一天缺的标的当 0。
  for (const day of dates.filter((d) => d < selected[0]!)) {
    for (const code of CORE_CODES) {
      const value = store.dates[day]?.[code];
      if (typeof value === "number" && Number.isFinite(value)) known.set(code, value);
    }
  }
  const totals = selected.map((day) => {
    for (const code of CORE_CODES) {
      const value = store.dates[day]?.[code];
      if (typeof value === "number" && Number.isFinite(value)) known.set(code, value);
    }
    return [...known.values()].reduce((a, b) => a + b, 0);
  });
  if (!totals[0]) return null;
  return {
    deltas: selected.slice(1).map((day, i) => ({ date: iso(day), d: totals[i + 1]! - totals[i]! })),
    index: selected.map((day, i) => ({ date: iso(day), v: 100 * totals[i]! / totals[0]! })),
  };
}
async function doSync(ctx: ServiceContext, fetch: Fetch, today: string): Promise<ShareMissing[]> {
  const store = loadShareHistory(ctx.dataRoot), missing: ShareMissing[] = [];
  const deep = CORE_CODES.filter((c) => c.startsWith("159"));
  const sh = CORE_CODES.filter((c) => !c.startsWith("159"));
  const start = dayOffset(today, -370), lower = compact(start);
  const days = new Set(Object.keys(store.dates).filter((d) => d >= lower));
  const save = () => {
    const cutoff = compact(dayOffset(today, -400));
    store.dates = Object.fromEntries(Object.entries(store.dates).filter(([d]) => d >= cutoff));
    writeJson(shareHistoryFile(ctx.dataRoot), store);
  };
  await Promise.all(deep.map(async (code) => {
    const last = Object.keys(store.dates).filter((d) => d >= lower && store.dates[d]?.[code] !== undefined).sort().at(-1);
    const from = last ? dayOffset(iso(last), 1) : start;
    if (from > today) return;
    try {
      const env = (await fetch(ctx, { endpoint: "cn_etf_share_history_sz", args: { code, start: from, end: today } })).envelope;
      const r = result(env);
      if (!r || !Array.isArray(r.rows)) throw new Error(reasonOf(env));
      for (const row of r.rows) {
        const x = obj(row), date = String(x?.date ?? ""), value = x?.shares_yi;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof value !== "number" || !Number.isFinite(value)) throw new Error("深交所份额记录格式异常");
        const key = compact(date);
        (store.dates[key] ??= {})[code] = value;
        days.add(key);
      }
    } catch (e) { missing.push({ code, reason: e instanceof Error ? e.message : String(e) }); }
  }));
  save();
  const queue = [...days].filter((day) => day >= lower && day <= compact(today) && sh.some((code) => store.dates[day]?.[code] === undefined)).sort();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (next < queue.length) {
      const day = queue[next++]!;
      try {
        const env = (await fetch(ctx, { endpoint: "etf_shares", args: { date: iso(day), exchange: "SH", codes: sh.join(",") } })).envelope;
        const r = result(env);
        if (!r || !Array.isArray(r.rows)) throw new Error(reasonOf(env));
        for (const row of r.rows) {
          const x = obj(row), code = String(x?.code ?? ""), value = x?.shares_10k;
          if (sh.includes(code as typeof sh[number]) && typeof value === "number" && Number.isFinite(value)) (store.dates[day] ??= {})[code] = value / 1e4;
        }
        for (const code of sh) if (store.dates[day]?.[code] === undefined) missing.push({ code, date: iso(day), reason: "上交所当天未返回该 ETF 份额" });
      } catch (e) { missing.push({ code: "SH", date: iso(day), reason: e instanceof Error ? e.message : String(e) }); }
      save();
    }
  }));
  return missing;
}
export function syncShareHistory(ctx: ServiceContext, fetch: Fetch = fetchEndpoint, today: string, _signal?: AbortSignal): Promise<ShareMissing[]> {
  const existing = pending.get(ctx.dataRoot);
  if (existing) return existing;
  const task = doSync(ctx, fetch, today).finally(() => { if (pending.get(ctx.dataRoot) === task) pending.delete(ctx.dataRoot); });
  pending.set(ctx.dataRoot, task);
  return task;
}
export function shareHistorySyncing(root: string): boolean { return pending.has(root); }
export function resetShareHistoryState(): void { pending.clear(); }
