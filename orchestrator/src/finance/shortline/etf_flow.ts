/** ETF 资金看板：公开量价与交易所申赎份额的确定性整理。 */
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../../fsutil.ts";
import type { JobContext, JobResult } from "../../notify.ts";
import { ServiceError, fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { failedNote } from "../schedule.ts";
import { clockOf, fetchTodayCalendar } from "./intraday.ts";
import { phaseOf } from "./watch.ts";
import { backfillProgress, loadShareHistory, startBroadShareBackfill } from "./etf_share_history.ts";

export const BASKET = ["510310", "588000", "159915", "510300", "563360", "159352", "512100", "159338", "510500", "159949", "588080", "510050", "510210", "159845", "159952", "159361", "512050", "159633", "560010", "159919"] as const;
export const CATEGORIES = ["沪深300", "中证1000", "中证500", "科创50", "中证A500", "创业板指", "上证50", "其他宽基", "创业板50", "双创50", "中证2000", "国证2000"] as const;
export const SPIKE_THRESHOLD_YI = 100;
export const MIN_TYPICAL_SAMPLES = 3;
type Raw = Record<string, unknown>;
type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope">>;
const obj = (x: unknown): Raw | null => x && typeof x === "object" && !Array.isArray(x) ? x as Raw : null;
const arr = (x: unknown): Raw[] => Array.isArray(x) ? x.map(obj).filter((v): v is Raw => v !== null) : [];
const str = (x: unknown): string => typeof x === "string" ? x : "";
const num = (x: unknown): number | null => typeof x === "number" && Number.isFinite(x) ? x : null;
const nums = (x: unknown): (number | null)[] => Array.isArray(x) ? x.map(num) : [];
const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : [];
const result = (env: unknown): Raw | null => obj(env)?.status === "failed" ? null : obj(obj(obj(env)?.extra)?.result);
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const compact = (d: string) => d.replaceAll("-", "");
const dailyMemory = new Map<string, { date: string; at: number; value: DailyResult }>();
const dailyPending = new Map<string, Promise<DailyResult>>();
type DailyResult = Awaited<ReturnType<typeof computeDaily>>;

/** 上午 121 槽含 09:30，下午 120 槽从 13:01 开始。 */
export const MINUTE_SLOTS = [
  ...Array.from({ length: 121 }, (_, i) => `${String(9 + Math.floor((30 + i) / 60)).padStart(2, "0")}:${String((30 + i) % 60).padStart(2, "0")}`),
  ...Array.from({ length: 120 }, (_, i) => `${String(13 + Math.floor((1 + i) / 60)).padStart(2, "0")}:${String((1 + i) % 60).padStart(2, "0")}`),
];
const SLOT_INDEX = new Map(MINUTE_SLOTS.map((t, i) => [t, i]));
const TIERS = [10, 15, 20, 25, 30, 40, 50, 60, 80];
const tier = (x: number) => TIERS.find((v) => v >= x) ?? Math.ceil(x / 20) * 20;
export function barAxisMax(bars: readonly (number | null)[]): number {
  const values = bars.map((v) => v ?? 0), peak = Math.max(0, ...values);
  const core = Math.max(0, ...values.slice(10));
  const base = Math.max(10, tier(core));
  return peak <= base ? base : tier(Math.min(peak, base * 2.5));
}

export function minuteCumulative(times: string[], amounts: (number | null)[]): (number | null)[] {
  const byTime = new Map(times.map((t, i) => [t, amounts[i] ?? null]));
  const latest = Math.max(-1, ...times.map((t) => SLOT_INDEX.get(t) ?? -1));
  let total = 0, complete = true;
  return MINUTE_SLOTS.map((t, i) => {
    if (i > latest) return null;
    if (i === 0 && !byTime.has(t)) return 0;
    const value = byTime.get(t);
    if (value === undefined || value === null) complete = false;
    else total += value;
    return complete ? Number(total.toFixed(6)) : null;
  });
}

/** 5 分钟末点是精确累计值；中间 1 分钟按交易槽索引线性插值。 */
export function interpolateFive(times: string[], amounts: (number | null)[]): (number | null)[] {
  const anchors = [{ i: 0, v: 0 }];
  let sum = 0;
  for (let j = 0; j < times.length; j++) {
    const i = SLOT_INDEX.get(times[j]!); const v = amounts[j];
    if (i === undefined || v === null || v === undefined) continue;
    sum += v; anchors.push({ i, v: sum });
  }
  const out: (number | null)[] = Array(MINUTE_SLOTS.length).fill(null);
  for (let j = 1; j < anchors.length; j++) {
    const a = anchors[j - 1]!, b = anchors[j]!;
    if (b.i <= a.i) continue;
    for (let i = a.i; i <= b.i; i++) out[i] = Number((a.v + (b.v - a.v) * (i - a.i) / (b.i - a.i)).toFixed(6));
  }
  return out;
}

function validDate(day: unknown): string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))
      || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new ServiceError("bad_request", "日期必须为有效 YYYY-MM-DD");
  return day;
}
function archiveFile(root: string, day: string): string { return path.join(root, "shortline", "etf_flow", "minute", `${compact(day)}.json`); }
function archives(root: string): Raw[] {
  const dir = path.join(root, "shortline", "etf_flow", "minute");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((x) => /^\d{8}\.json$/.test(x)).flatMap((x) => {
    try { const v = obj(JSON.parse(fs.readFileSync(path.join(dir, x), "utf8"))); return v ? [v] : []; }
    catch { return []; }
  });
}
async function requireResult(ctx: ServiceContext, endpoint: string, fetch: Fetch, signal: AbortSignal, args?: Record<string, unknown>, fresh = false): Promise<Raw> {
  const r = await fetch(ctx, { endpoint, ...(args ? { args } : {}), signal,
    consistency: fresh ? { mode: "fresh" } : { mode: "prefer_cache", max_age_ms: endpoint === "cn_broad_etf_universe" ? 86_400_000
      : endpoint === "cn_etf_daily_batch" ? 6 * 60 * 60_000 : 60_000 } });
  const data = result(r.envelope);
  if (!data) throw new Error(`${endpoint}：${failedNote(r.envelope) || "源无数据"}`);
  return data;
}
function sessionPollMs(phase: ReturnType<typeof phaseOf>, trading: boolean): number {
  return trading && ["morning", "afternoon", "closing_auction"].includes(phase) ? 60_000 : 300_000;
}
export async function etfFlowPoll(ctx: ServiceContext, signal: AbortSignal, fetch: Fetch = fetchEndpoint, now = new Date()) {
  const clock = clockOf(now), phase = phaseOf(now);
  const [facts, minute, universe, live] = await Promise.all([
    fetchTodayCalendar(ctx, clock.day, fetch, signal),
    requireResult(ctx, "cn_etf_minute_batch", fetch, signal),
    requireResult(ctx, "cn_broad_etf_universe", fetch, signal).catch(() => null),
    requireResult(ctx, "cn_etf_turnover_live", fetch, signal, { extra_codes: [...BASKET] }).catch(() => null),
  ]);
  const date = str(minute.date), isToday = !!facts?.is_today_trading_day && date === clock.day && !["pre_open", "auction", "weekend"].includes(phase);
  const total = obj(minute.total), times = strings(total?.times), amounts = nums(total?.amount_yi);
  const byMinute = obj(minute.items) ?? {}, names = new Map(arr(universe?.items).map((r) => [str(r.code), str(r.name)]));
  const byLive = new Map(arr(live?.items).map((r) => [str(r.code), r]));
  const sums = [...BASKET].map((code) => {
    const item = obj(byMinute[code]), values = nums(item?.amount_yi), quote = byLive.get(code);
    const amount = item ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
    const quoteDay = str(quote?.quote_time).slice(0, 8);
    return { code, name: names.get(code) || str(quote?.name) || code, amount_yi: amount,
      pct: quoteDay === compact(date) ? num(quote?.pct) : null,
      reason: item ? null : "分钟数据未取到" };
  });
  const denominator = num(minute.success_count) !== BASKET.length || sums.some((x) => x.amount_yi === null) ? null
    : sums.reduce((a, x) => a + (x.amount_yi ?? 0), 0);
  const ranking = sums.map((x) => ({ ...x, share_pct: x.amount_yi !== null && denominator && denominator > 0 ? 100 * x.amount_yi / denominator : null,
    reason: x.reason ?? (denominator === null ? "20 只 ETF 未全部取到，无法计算占比" : null) }))
    .sort((a, b) => (b.amount_yi ?? -Infinity) - (a.amount_yi ?? -Infinity));
  const missing = arr(minute.missing).map((x) => ({ code: str(x.code), reason: str(x.reason) }));
  return { date, asof: now.toISOString(), is_today: isToday, phase, trading_day: facts?.is_today_trading_day ?? null,
    poll_ms: sessionPollMs(phase, !!facts?.is_today_trading_day), unit: "亿元", amount_basis: "新浪分钟成交量×OHLC均价",
    bars: { times, amount_yi: total?.amount_yi === null ? null : amounts, coverage: nums(total?.coverage),
      reason: str(total?.reason) || null, barAxisMax: barAxisMax(amounts) },
    index: minute.index, success_count: num(minute.success_count) ?? 0, missing, ranking };
}

type FiveDay = { date: string; times: string[]; amount_yi: (number | null)[]; coverage: (number | null)[]; reason: string | null };
function fiveDays(root: string, hist: Raw): FiveDay[] {
  const all = new Map<string, FiveDay>();
  for (const d of [...arr(hist.days), ...archives(root)]) {
    const total = obj(d.total) ?? d, date = str(d.date), times = strings(total.times), amounts = nums(total.amount_yi);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !times.length || amounts.length !== times.length) continue;
    all.set(date, { date, times, amount_yi: amounts, coverage: nums(total.coverage), reason: str(total.reason) || null });
  }
  return [...all.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export async function etfFlowCum(ctx: ServiceContext, dateArg: unknown, signal: AbortSignal, fetch: Fetch = fetchEndpoint, now = new Date()) {
  const [poll, hist] = await Promise.all([etfFlowPoll(ctx, signal, fetch, now), requireResult(ctx, "cn_etf_minute_hist", fetch, signal, { days: 21 })]);
  const days = fiveDays(ctx.dataRoot, hist);
  const complete = (d: FiveDay) => d.times.length === 48 && d.amount_yi.every((v) => v !== null)
    && d.coverage.length === 48 && d.coverage.every((v) => v === BASKET.length);
  const available = days.filter(complete).map((d) => d.date);
  const currentDay = clockOf(now).day;
  const comparison = dateArg === undefined ? available.filter((d) => d < currentDay).at(-1) : validDate(dateArg);
  if (dateArg !== undefined && (!comparison || comparison > currentDay || !available.includes(comparison)))
    throw new ServiceError("bad_request", "对比日必须是可回溯的交易日，且不能是未来日期");
  const chosen = days.find((d) => d.date === comparison && complete(d));
  const completed = days.filter((d) => d.date < currentDay && complete(d)).slice(-20);
  const curves = completed.map((d) => interpolateFive(d.times, d.amount_yi));
  const average = MINUTE_SLOTS.map((_, i) => {
    const vals = curves.map((x) => x[i]).filter((v): v is number => v !== null);
    return vals.length === curves.length && vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  return { date: poll.date, slots: MINUTE_SLOTS, today: poll.is_today && poll.bars.amount_yi
    ? minuteCumulative(poll.bars.times, poll.bars.amount_yi) : Array(MINUTE_SLOTS.length).fill(null),
    comparison: { date: comparison ?? null, values: chosen ? interpolateFive(chosen.times, chosen.amount_yi) : null,
      coverage: chosen?.coverage ?? null, reason: chosen?.reason ?? null },
    average20: { values: curves.length ? average : null, n: curves.length,
      from: completed[0]?.date ?? null, to: completed.at(-1)?.date ?? null }, comparison_dates: available };
}

export function netFlow(shares: number | null, previous: number | null, close: number | null): number | null {
  return shares === null || previous === null || close === null ? null : (shares - previous) * close;
}
type DailyBar = { date: string; close: number; amount_yi: number };
type UniverseItem = { code: string; name: string; category: string; exchange: string };
export function calculateDaily(dates: string[], index: Map<string, number>, prices: Map<string, Map<string, DailyBar>>,
  universe: UniverseItem[], shares: ReturnType<typeof loadShareHistory>, today: string, failedCodes = new Set<string>()) {
  const categories = [...CATEGORIES];
  const latestPrior = dates.filter((d) => d < today).at(-1);
  const firstPriceDay = new Map([...prices].map(([code, bars]) => [code, [...bars.keys()].sort()[0] ?? ""]));
  const rows = dates.map((date, i) => {
    const previous = dates[i - 1], todayPending = date >= today;
    const basketBars = BASKET.map((code) => prices.get(code)?.get(date));
    const turnoverMissing = basketBars.filter((x) => !x).length;
    const turnover = turnoverMissing ? null : basketBars.reduce((a, x) => a + x!.amount_yi, 0);
    const sums = new Map<string, { value: number; shareMissing: number; priceMissing: number; active: number }>(categories.map((c) => [c, { value: 0, shareMissing: 0, priceMissing: 0, active: 0 }]));
    const basket = { value: 0, shareMissing: 0, priceMissing: 0, active: 0 };
    for (const item of universe) {
      const bar = prices.get(item.code)?.get(date);
      const target = sums.get(item.category);
      const groups = [target, BASKET.includes(item.code as typeof BASKET[number]) ? basket : undefined].filter((x): x is typeof basket => !!x);
      if (!bar) {
        const firstBar = firstPriceDay.get(item.code);
        if (failedCodes.has(item.code) || firstBar && firstBar <= date)
          for (const group of groups) group.priceMissing++;
        continue; // 上市前不计入；已上市却缺 K 线则整类缺数
      }
      for (const group of groups) group.active++;
      if (todayPending) continue;
      const current = num(shares.dates[compact(date)]?.[item.code]);
      const prior = previous ? num(shares.dates[compact(previous)]?.[item.code]) : null;
      const value = netFlow(current, prior, bar.close);
      for (const group of groups) { if (value === null) group.shareMissing++; else group.value += value; }
    }
    const render = (x: typeof basket, expected?: number) => {
      const absent = expected ? Math.max(0, expected - x.active) : 0;
      return { net_yi: todayPending || x.shareMissing || x.priceMissing || absent || !x.active ? null : Number(x.value.toFixed(6)),
        missing_count: x.shareMissing + x.priceMissing + absent, share_missing_count: x.shareMissing,
        price_missing_count: x.priceMissing, active_count: x.active,
        status: todayPending ? "待公布" : absent ? "篮子不完整" : x.priceMissing ? "日线缺失"
          : x.shareMissing ? date === latestPrior ? "待公布" : "份额缺失" : !x.active ? "无有效 ETF" : "已公布" };
    };
    const byCategory = Object.fromEntries(categories.map((c) => [c, render(sums.get(c)!) ]));
    return { date, turnover_yi: turnover, turnover_missing_count: turnoverMissing,
      basket: render(basket, BASKET.length), categories: byCategory, index_close: index.get(date) ?? null };
  });
  const ytd: Record<string, number | null> = Object.fromEntries(categories.map((c) => [c, 0]));
  let year = "";
  for (const row of rows) {
    if (row.date.slice(0, 4) !== year) { year = row.date.slice(0, 4); for (const c of categories) ytd[c] = 0; }
    const cumulative: Record<string, number | null> = {};
    for (const c of categories) {
      const v = row.categories[c]!.net_yi;
      ytd[c] = ytd[c] === null || v === null ? null : ytd[c]! + v;
      cumulative[c] = ytd[c];
    }
    Object.assign(row, { cumulative_ytd: cumulative });
  }
  const spikes = rows.filter((r) => r.basket.net_yi !== null && r.basket.net_yi > SPIKE_THRESHOLD_YI).map((r) => r.date);
  const recentDates = rows.slice(-3).map((r) => r.date);
  return { rows, spike_dates: spikes, recent_dates: recentDates,
    recent_month_categories: rows.slice(-22).map((r) => ({ date: r.date, categories: r.categories })) };
}

async function computeDaily(ctx: ServiceContext, signal: AbortSignal, fetch: Fetch, now: Date, fresh: boolean) {
  const today = clockOf(now).day;
  const universeRaw = await requireResult(ctx, "cn_broad_etf_universe", fetch, signal);
  const universe = arr(universeRaw.items).map((r) => ({ code: str(r.code), name: str(r.name), category: str(r.category), exchange: str(r.exchange) }))
    .filter((r) => r.code && (CATEGORIES as readonly string[]).includes(r.category));
  const codes = [...new Set([...BASKET, ...universe.map((r) => r.code)])];
  const source = new Map<string, Map<string, DailyBar>>();
  const failedCodes = new Set<string>();
  let indexRows: Raw[] = [];
  for (let i = 0; i < codes.length; i += 50) {
    const data = await requireResult(ctx, "cn_etf_daily_batch", fetch, signal, { codes: codes.slice(i, i + 50), include_index: i === 0 }, fresh);
    if (i === 0) indexRows = arr(data.index);
    for (const missing of arr(data.missing)) if (str(missing.code)) failedCodes.add(str(missing.code));
    for (const [code, raw] of Object.entries(obj(data.items) ?? {})) {
      const bars = new Map<string, DailyBar>();
      for (const r of arr(raw)) {
        const close = num(r.close), amount = num(r.amount_yi), date = str(r.date);
        if (date && close !== null && amount !== null) bars.set(date, { date, close, amount_yi: amount });
      }
      source.set(code, bars);
    }
  }
  const index = new Map(indexRows.flatMap((r) => { const d = str(r.date), v = num(r.close); return d && v !== null ? [[d, v] as const] : []; }));
  const dates = [...index.keys()].filter((d) => d <= today).sort().slice(-750);
  if (!dates.length) throw new Error("上证综指日线没有可用交易日");
  startBroadShareBackfill(ctx, dates.filter((d) => d < today), universe.map((r) => r.code), fetch);
  const daily = calculateDaily(dates, index, source, universe, loadShareHistory(ctx.dataRoot), today, failedCodes);
  const progress = backfillProgress(ctx.dataRoot);
  const eligible = daily.rows.filter((r) => r.date < today && r.turnover_missing_count === 0);
  return { date: today, unit: "亿元", source: "新浪日 K 成交量×OHLC 均价；交易所份额变动×当日收盘价",
    ...daily, spike_window_from: eligible[0]?.date ?? null,
    spike_complete: progress.total > 0 && progress.completed === progress.total
      && eligible.length > 0 && eligible.every((r) => r.basket.status === "已公布"),
    backfill: progress };
}

/** 收盘档案优先；同一交易日内复用计算结果，回填进度变化时重新计算。 */
export async function etfFlowDaily(ctx: ServiceContext, signal: AbortSignal, fetch: Fetch = fetchEndpoint, now = new Date(), fresh = false) {
  const today = clockOf(now).day;
  if (!fresh) {
    const calendar = await fetchTodayCalendar(ctx, today, fetch, signal);
    const latest = calendar?.last_trading_day ?? today;
    const progress = backfillProgress(ctx.dataRoot);
    const valid = (value: DailyResult) => value.rows.at(-1)?.date === latest
      && value.backfill.completed === progress.completed && value.backfill.total === progress.total;
    const file = path.join(ctx.dataRoot, "shortline", "etf_flow", "daily.json");
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as DailyResult;
      if (valid(cached)) return { ...cached, backfill: progress };
    } catch { /* 尚无收盘档案 */ }
    const memory = dailyMemory.get(ctx.dataRoot);
    if (memory && memory.date === latest && now.getTime() - memory.at < 30 * 60_000 && valid(memory.value))
      return { ...memory.value, backfill: progress };
    const pending = dailyPending.get(ctx.dataRoot);
    if (pending) return pending;
    const task = computeDaily(ctx, signal, fetch, now, false);
    dailyPending.set(ctx.dataRoot, task);
    try {
      const value = await task;
      dailyMemory.set(ctx.dataRoot, { date: latest, at: now.getTime(), value });
      return value;
    } finally { if (dailyPending.get(ctx.dataRoot) === task) dailyPending.delete(ctx.dataRoot); }
  }
  const value = await computeDaily(ctx, signal, fetch, now, true);
  dailyMemory.set(ctx.dataRoot, { date: value.rows.at(-1)?.date ?? today, at: now.getTime(), value });
  return value;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * p;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}
export function typicalGroup(samples: number[][]) {
  const n = samples.length;
  if (n < MIN_TYPICAL_SAMPLES) return { n, values: null, reason: `样本不足（n=${n}）` };
  const values = Array.from({ length: 48 }, (_, i) => {
    const column = samples.map((x) => x[i]!);
    return { mean: column.reduce((a, b) => a + b, 0) / n, p25: percentile(column, .25), p75: percentile(column, .75) };
  });
  let cumulative = 0;
  return { n, values: values.map((x) => ({ ...x, cumulative: (cumulative += x.mean) })), reason: null };
}
export async function etfFlowTypical(ctx: ServiceContext, signal: AbortSignal, fetch: Fetch = fetchEndpoint, now = new Date()) {
  const [daily, hist] = await Promise.all([etfFlowDaily(ctx, signal, fetch, now), requireResult(ctx, "cn_etf_minute_hist", fetch, signal, { days: 21 })]);
  const spikes = new Set(daily.spike_dates), known = new Set(daily.rows.filter((r) => r.basket.status === "已公布").map((r) => r.date));
  const days = fiveDays(ctx.dataRoot, hist).filter((d) => known.has(d.date) && d.times.length === 48 && d.amount_yi.every((v) => v !== null)
    && d.coverage.length === 48 && d.coverage.every((v) => v === BASKET.length));
  const shape = (spike: boolean) => typicalGroup(days.filter((d) => spikes.has(d.date) === spike).map((d) => d.amount_yi as number[]));
  return { unit: "亿元", times: days[0]?.times ?? [], spike: shape(true), normal: shape(false), available_dates: days.map((d) => d.date) };
}

export async function etfFlowRun(ctx: ServiceContext): Promise<unknown> {
  const file = path.join(ctx.dataRoot, "shortline", "etf_flow", "daily.json");
  let cached: unknown = null;
  try { cached = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* 尚无收盘缓存 */ }
  return { cached_daily: cached, backfill: backfillProgress(ctx.dataRoot) };
}
export async function etfFlowAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (body.action === "poll") return etfFlowPoll(ctx, signal);
  if (body.action === "cum") return etfFlowCum(ctx, body.date, signal);
  if (body.action === "daily") return etfFlowDaily(ctx, signal);
  if (body.action === "typical") return etfFlowTypical(ctx, signal);
  throw new ServiceError("bad_request", "action 只能是 poll、cum、daily 或 typical");
}

export async function etfFlowClose(j: JobContext, fetch: Fetch = fetchEndpoint): Promise<JobResult> {
  const [dailyReply, histReply] = await Promise.allSettled([
    etfFlowDaily(j.ctx, j.signal, fetch, j.now, true),
    requireResult(j.ctx, "cn_etf_minute_hist", fetch, j.signal, { days: 21 }, true),
  ]);
  const day = histReply.status === "fulfilled" ? fiveDays(j.ctx.dataRoot, histReply.value).find((d) => d.date === j.day) : null;
  if (day) writeJson(archiveFile(j.ctx.dataRoot, j.day), day);
  if (dailyReply.status === "fulfilled") writeJson(path.join(j.ctx.dataRoot, "shortline", "etf_flow", "daily.json"), dailyReply.value);
  if (!day || dailyReply.status === "rejected")
    throw new Error(`ETF 收盘档案${day ? "已存" : "未取到"}；日度${dailyReply.status === "fulfilled" ? "已缓存" : "未算出"}`);
  const daily = dailyReply.value;
  return { messages: [], note: `ETF 资金 ${j.day} 日度缓存与 5 分钟档案已更新；份额回填 ${daily.backfill.completed}/${daily.backfill.total} 个交易日` };
}
