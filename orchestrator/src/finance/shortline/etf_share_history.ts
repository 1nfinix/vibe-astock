/** 固定 20 只 ETF 的交易所官方份额历史；机器数据只留在本机文件。 */
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../../fsutil.ts";
import { fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { CORE_CODES } from "./etf_turnover.ts";

type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;
export type BackfillState = { targetDates: string[]; codes: string[]; doneTasks: string[]; doneDates: string[]; failed: ShareMissing[] };
export type ShareStore = { version: 1; dates: Record<string, Record<string, number>>; backfill?: BackfillState };
export type ShareMissing = { code: string; date?: string; reason: string };
export type ShareRange = { deltas: { date: string; d: number }[]; index: { date: string; v: number }[] };
const pending = new Map<string, Promise<ShareMissing[]>>();
const broadPending = new Map<string, Promise<void>>();
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
function saveStore(root: string, store: ShareStore): void {
  // 旧视图同步与宽基回填可能交错：每次落盘前合并同一份文件，避免各自的旧内存快照覆盖对方。
  const disk = loadShareHistory(root);
  const dates: ShareStore["dates"] = { ...disk.dates };
  for (const [day, values] of Object.entries(store.dates)) dates[day] = { ...dates[day], ...values };
  store.dates = dates;
  store.backfill ??= disk.backfill;
  writeJson(shareHistoryFile(root), store);
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
/** 只用该 ETF 实际公布的最近两期，不以其他标的的日期补出虚构的日变化。 */
export function officialSharePair(store: ShareStore, code: string, onOrBefore: string): { date: string; shares: number; previous: number } | null {
  const dates = Object.keys(store.dates).filter((d) => d <= compact(onOrBefore) && typeof store.dates[d]?.[code] === "number" && Number.isFinite(store.dates[d]?.[code])).sort();
  const current = dates.at(-1), prior = dates.at(-2);
  if (!current || !prior) return null;
  return { date: iso(current), shares: store.dates[current]![code]!, previous: store.dates[prior]![code]! };
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
    const cutoff = compact(dayOffset(today, -1150));
    store.dates = Object.fromEntries(Object.entries(store.dates).filter(([d]) => d >= cutoff));
    saveStore(ctx.dataRoot, store);
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
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (!/上交所.*没有 ETF 份额数据：非交易日或尚未发布/.test(reason)) missing.push({ code: "SH", date: iso(day), reason });
      }
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
export function resetShareHistoryState(): void { pending.clear(); broadPending.clear(); }

/** 同一份 version 1 文件内记录任务进度；旧文件没有 backfill 字段仍可直接读取。 */
export function backfillProgress(root: string): { completed: number; total: number; from: string | null; to: string | null; syncing: boolean; failed: ShareMissing[] } {
  const store = loadShareHistory(root), state = store.backfill;
  return { completed: state?.doneDates.length ?? 0, total: state?.targetDates.length ?? 0,
    from: state?.doneDates.length ? iso([...state.doneDates].sort()[0]!) : null,
    to: state?.doneDates.length ? iso([...state.doneDates].sort().at(-1)!) : null,
    syncing: broadPending.has(root), failed: state?.failed ?? [] };
}

/** 先补近期，再向前推到约三年；每次成功的交易日与单只代码任务立即落盘，重启后续跑。 */
export function startBroadShareBackfill(ctx: ServiceContext, dates: string[], codes: string[], fetch: Fetch = fetchEndpoint): void {
  if (broadPending.has(ctx.dataRoot) || !dates.length || !codes.length) return;
  const task = (async () => {
    if (pending.has(ctx.dataRoot)) await pending.get(ctx.dataRoot)?.catch(() => undefined);
    const store = loadShareHistory(ctx.dataRoot);
    const targetDates = [...new Set(dates)].sort().slice(-750).map(compact);
    const allCodes = [...new Set(codes)].sort();
    const sameCodes = JSON.stringify(store.backfill?.codes) === JSON.stringify(allCodes);
    if (!store.backfill || JSON.stringify(store.backfill.targetDates) !== JSON.stringify(targetDates) || !sameCodes) {
      const prior = store.backfill;
      store.backfill = { targetDates, codes: allCodes,
        doneTasks: sameCodes ? prior?.doneTasks ?? [] : [],
        doneDates: sameCodes ? prior?.doneDates.filter((d) => targetDates.includes(d)) ?? [] : [],
        failed: sameCodes ? prior?.failed ?? [] : [] };
    }
    const state = store.backfill;
    const save = () => saveStore(ctx.dataRoot, store);
    save();
    const sh = allCodes.filter((c) => !c.startsWith("15")), sz = allCodes.filter((c) => c.startsWith("15"));
    // 固定的 80 个自然日桶，新增交易日不会移动旧桶边界；深市每次查询不超过源端窗口。
    const buckets = new Map<number, string[]>();
    for (const day of targetDates) {
      const bucket = Math.floor(Date.parse(`${iso(day)}T00:00:00Z`) / (80 * 86400_000));
      const dates = buckets.get(bucket) ?? [];
      dates.push(day); buckets.set(bucket, dates);
    }
    for (const [bucket, window] of [...buckets].reverse()) {
      if (window.every((d) => state.doneDates.includes(d))) continue;
      for (let i = 0; i < window.length; i += 10) {
        const batch = window.slice(i, i + 10), needed = batch.filter((d) => !state.doneTasks.includes(`SH:${d}`));
        if (!needed.length || !sh.length) continue;
        try {
          const env = (await fetch(ctx, { endpoint: "cn_etf_share_history_sh", args: { dates: needed.map(iso) } })).envelope;
          const r = result(env);
          if (!r || !Array.isArray(r.rows) || !Array.isArray(r.failed)) throw new Error(reasonOf(env));
          const failed = new Set((r.failed as unknown[]).map((x) => compact(String(obj(x)?.date ?? ""))));
          for (const row of r.rows) {
            const x = obj(row), d = compact(String(x?.date ?? "")), code = String(x?.code ?? ""), v = x?.shares_10k;
            if (needed.includes(d) && sh.includes(code) && typeof v === "number" && Number.isFinite(v)) (store.dates[d] ??= {})[code] = v / 1e4;
          }
          for (const day of needed) {
            if (failed.has(day)) state.failed.push({ code: "SH", date: iso(day), reason: "上交所单日份额未取到" });
            else state.doneTasks.push(`SH:${day}`);
          }
        } catch (e) {
          for (const day of needed) state.failed.push({ code: "SH", date: iso(day), reason: e instanceof Error ? e.message : String(e) });
        }
        save();
      }
      for (const code of sz) {
        const prefix = `SZ:${bucket}:${code}:`;
        const covered = state.doneTasks.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? "";
        const needed = window.filter((d) => d > covered);
        if (!needed.length) continue;
        try {
          const env = (await fetch(ctx, { endpoint: "cn_etf_share_history_sz", args: { code, start: iso(needed[0]!), end: iso(needed.at(-1)!) } })).envelope;
          const r = result(env);
          if (!r || !Array.isArray(r.rows)) throw new Error(reasonOf(env));
          for (const row of r.rows) {
            const x = obj(row), d = compact(String(x?.date ?? "")), v = x?.shares_yi;
            if (window.includes(d) && typeof v === "number" && Number.isFinite(v)) (store.dates[d] ??= {})[code] = v;
          }
          state.doneTasks = state.doneTasks.filter((x) => !x.startsWith(prefix));
          state.doneTasks.push(`${prefix}${needed.at(-1)}`);
        } catch (e) {
          state.failed.push({ code, date: iso(needed[0]!), reason: e instanceof Error ? e.message : String(e) });
        }
        save();
      }
      const complete = window.filter((day) => (!sh.length || state.doneTasks.includes(`SH:${day}`))
        && sz.every((code) => {
          const prefix = `SZ:${bucket}:${code}:`;
          return (state.doneTasks.find((x) => x.startsWith(prefix))?.slice(prefix.length) ?? "") >= day;
        }));
      for (const day of complete) if (!state.doneDates.includes(day)) state.doneDates.push(day);
      state.failed = state.failed.filter((x) => !x.date || !complete.includes(compact(x.date)));
      save();
    }
  })().finally(() => { broadPending.delete(ctx.dataRoot); });
  broadPending.set(ctx.dataRoot, task);
  void task.catch(() => undefined);
}
