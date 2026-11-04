/** 宽基 ETF 量价视图：公开行情按固定历史名单聚合，不写台账。 */
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "../../fsutil.ts";
import type { JobContext, JobResult } from "../../notify.ts";
import { ServiceError, fetchEndpoint, type FetchResult, type ServiceContext } from "../../service.ts";
import { failedNote } from "../schedule.ts";
import type { CalendarFacts } from "../session.ts";
import { clockOf, fetchTodayCalendar } from "./intraday.ts";
import { phaseOf, pollMsOf, type Phase } from "./watch.ts";

export const CORE_CODES = ["510300", "510310", "510050", "510330", "159919", "512100", "588080", "159915", "510500", "159845", "560010", "510180", "159629", "510230", "159922", "512500", "515800", "159952", "588050", "159901"] as const;
const CORE = new Set<string>(CORE_CODES);
export const DEFAULT_WATCH = ["588000", "159338", "512050", "159339"];
export type Item = { code: string; name: string; index: string; group: "core" | "watch"; huijin_yi: number | null; price: number | null; prev_close: number | null; pct: number | null; amount_yi: number | null; mktcap_yi: number | null; shares: number | null; outer_lots: number | null; inner_lots: number | null; quote_time: string; avg20_yi: number | null; hist: number[]; shape: number[] | null; tail_ratio: number | null; tail_ratio_base: number | null; net_yi: number | null; ratio: number | null; subscr_net_yi: number | null; prev_shares: number | null; reason: string | null };
type Raw = Record<string, unknown>;
type Fetch = (ctx: ServiceContext, req: Parameters<typeof fetchEndpoint>[1]) => Promise<Pick<FetchResult, "envelope"> & Partial<Pick<FetchResult, "fetched_at">>>;
const n = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const s = (v: unknown): string => typeof v === "string" ? v : "";
const records = (v: unknown): Raw[] => Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object" && !Array.isArray(x)) : [];
const resultOf = (env: unknown): Raw | null => { const r = (env as { extra?: { result?: unknown } } | null)?.extra?.result; return r && typeof r === "object" && !Array.isArray(r) ? r as Raw : null; };
const missingOf = (r: Raw | null) => records(r?.missing).map((x) => ({ code: s(x.code), reason: s(x.reason) }));

export function shapeAt(shape: number[] | null, hm: string): number | null {
  if (!shape || shape.length !== 48) return null;
  const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const elapsed = m <= 690 ? m - 570 : m < 780 ? 120 : 120 + m - 780;
  if (elapsed <= 0) return 0;
  if (elapsed >= 240) return 1;
  const index = elapsed / 5 - 1;
  const lo = Math.floor(index);
  const a = lo < 0 ? 0 : shape[lo];
  const b = shape[Math.min(47, lo + 1)];
  if (a === undefined || b === undefined) return null;
  return a + (b - a) * (index - lo);
}

export function dayProgress(hm: string, shape: number[] | null, stale = false): number {
  if (stale || hm >= "15:00") return 1;
  const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const elapsed = Math.max(0, Math.min(240, m < 690 ? m - 570 : m < 780 ? 120 : 120 + m - 780));
  const observed = shapeAt(shape, hm);
  return observed !== null && observed > 0.02 ? Math.min(1, observed) : Math.max(0.12, elapsed / 240);
}

export function subscr(today: number | null, prev: number | null, price: number | null): number | null {
  return today === null || prev === null || price === null ? null : (today - prev) * price;
}

export function sharesSuspect(items: readonly Pick<Item, "code" | "shares" | "prev_shares">[]): Set<string> {
  const out = new Set<string>();
  for (const market of ["5", "1"]) {
    const present = items.filter((x) => x.code.startsWith(market) && x.shares !== null && x.prev_shares !== null);
    if (present.length >= 3 && present.filter((x) => Math.abs(x.shares! - x.prev_shares!) < 0.005).length / present.length >= 0.7) out.add(market);
  }
  return out;
}

export function calcItem(base: Raw, live: Raw, prevShares: number | null, hm: string, stale: boolean): Item {
  const amount = n(live.amount_yi), avg = n(base.avg20_yi), outer = n(live.outer_lots), inner = n(live.inner_lots);
  const done = dayProgress(hm, Array.isArray(base.shape) ? base.shape.map(Number) : null, stale);
  const lots = outer !== null && inner !== null ? outer + inner : null;
  const code = s(base.code || live.code);
  return { code, name: s(base.name) === code ? s(live.name || base.name) : s(base.name || live.name), index: s(base.index) || "—",
    group: base.group === "core" ? "core" : "watch", huijin_yi: n(base.huijin_yi),
    price: n(live.price), prev_close: n(live.prev_close), pct: n(live.pct), amount_yi: amount,
    mktcap_yi: n(live.mktcap_yi), shares: n(live.shares), outer_lots: outer, inner_lots: inner,
    quote_time: s(live.quote_time), avg20_yi: avg, hist: Array.isArray(base.hist) ? base.hist.map(Number) : [],
    shape: Array.isArray(base.shape) ? base.shape.map(Number) : null, tail_ratio: n(base.tail_ratio), tail_ratio_base: n(base.tail_ratio_base),
    net_yi: amount !== null && lots !== null && lots > 0 ? amount * (outer! - inner!) / lots : null,
    ratio: amount !== null && avg !== null && avg > 0 ? amount / (avg * done) : null,
    subscr_net_yi: subscr(n(live.shares), prevShares, n(live.price)), prev_shares: prevShares,
    reason: amount === null ? "实时成交额未取到" : avg === null ? "近 20 日基准未取到" : null };
}

export type Verdict = { level: "strong" | "medium" | "sell" | "unclear" | "quiet" | "missing"; title: string; reason: string };
export function dateWeek(day: string): string {
  const date = new Date(`${day}T12:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? day : `${day} ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()]}`;
}
export function timeAnnotation(mode: "stale" | "lunch" | "intraday" | "closed" | "none", day: string, hm: string, progressPct: number): string {
  if (mode === "stale") return `（实时行情不是今日数据，当前显示 ${dateWeek(day)} 全天数据，与全天基准直接对比）`;
  if (mode === "lunch") return `（午间休市，成交额锁定 11:30；对比基准 = 20 日均额 × 历史同时点进度 ${progressPct.toFixed(1)}%）`;
  if (mode === "intraday") return `（${hm} 历史平均已走完全天 ${progressPct.toFixed(1)}%，分母已同比例缩小）`;
  return mode === "closed" ? `（非交易时段，以上为 ${dateWeek(day)} 收盘复盘，开盘后自动切换实时）` : "";
}
export function verdict(ratio: number | null, net: number | null, tail: number | null, tailBase: number | null, weightedPct: number | null, annotation = ""): Verdict {
  if (ratio === null || net === null) return { level: "missing", title: "量价判断暂不可得", reason: `成交额或主动买卖盘缺数。${annotation ? `${annotation}。` : ""}这是量价现象，不能证明任何机构当日交易。` };
  const level = ratio >= 1.8 && net > 0 ? "strong" : ratio >= 1.3 && net > 0 ? "medium" : ratio >= 1.8 ? "sell" : ratio >= 1.3 ? "unclear" : "quiet";
  const title = { strong: "放量且主动净买入同向", medium: "温和放量、偏买", sell: "放量但主动净卖出", unclear: "成交活跃、方向不清", quiet: "量价平静" }[level];
  const x = ratio.toFixed(2), y = net.toFixed(2);
  let reason = {
    strong: `固定名单成交额达到历史同时点均值的 ${x} 倍，且主动净买入 ${y} 亿元。放量与主动净买入同向，符合护盘类量价特征。`,
    medium: `成交额放大到历史同时点均值的 ${x} 倍，主动净买入 ${y} 亿元，方向偏买，但力度未达强信号阈值（1.8×）。`,
    sell: `成交额放大到历史同时点均值的 ${x} 倍，但主动净买入 ${y} 亿元。大额成交未必是买盘，更像换手或卖出。`,
    unclear: `成交额达到历史同时点均值的 ${x} 倍，但主动净买入 ${y} 亿元，方向不清晰。`,
    quiet: `成交额只有历史同时点均值的 ${x} 倍，主动净买入 ${y} 亿元，量价平静。`,
  }[level];
  if (level === "strong" || level === "medium") {
    if (tail !== null && tailBase !== null && tail > tailBase * 1.25) reason += `尾盘半小时成交占全天 ${(tail * 100).toFixed(1)}%，明显高于 20 日均值 ${(tailBase * 100).toFixed(1)}%。`;
    if (weightedPct !== null && weightedPct < -0.5) reason += `池内规模加权涨跌 ${weightedPct.toFixed(2)}%，下跌日放量更符合护盘场景。`;
  }
  reason += `${annotation ? `${annotation}。` : ""}这是量价现象，不能证明任何机构当日交易。`;
  return { level, title, reason };
}

export function validateWatch(codes: unknown): string[] {
  if (!Array.isArray(codes) || codes.length > 30 || codes.some((c) => typeof c !== "string" || !/^[51]\d{5}$/.test(c) || CORE.has(c))) throw new ServiceError("bad_request", "观察组限 30 只沪深 ETF 六位代码，且不能包含固定汇金组");
  return [...new Set(codes as string[])];
}
const watchFile = (root: string) => path.join(root, "shortline", "etf_turnover", "watch.json");
export function loadWatch(root: string): string[] {
  try { return validateWatch(JSON.parse(fs.readFileSync(watchFile(root), "utf8")).codes); } catch { return [...DEFAULT_WATCH]; }
}
export function saveWatch(root: string, codes: string[]): void { writeJson(watchFile(root), { codes: validateWatch(codes) }); }
export const sharesFile = (root: string, day: string) => path.join(root, "shortline", "etf_shares", `${day.replaceAll("-", "")}.json`);
export function saveShares(root: string, day: string, items: readonly Raw[]): number {
  const shares = Object.fromEntries(items.flatMap((x) => n(x.shares) !== null ? [[s(x.code), n(x.shares)]] : []));
  if (!Object.keys(shares).length) throw new Error("份额全部缺失，未写快照");
  writeJson(sharesFile(root, day), { date: day, shares });
  return Object.keys(shares).length;
}
export function previousShares(root: string, day: string): { date: string | null; shares: Record<string, number> } {
  const dir = path.dirname(sharesFile(root, day));
  try {
    const names = fs.readdirSync(dir).filter((x) => /^\d{8}\.json$/.test(x) && x.slice(0, 8) < day.replaceAll("-", "")).sort();
    const latest = names.at(-1);
    if (!latest) return { date: null, shares: {} };
    const raw = JSON.parse(fs.readFileSync(path.join(dir, latest), "utf8")) as { date?: string; shares?: Record<string, number> };
    return { date: raw.date ?? null, shares: raw.shares ?? {} };
  } catch { return { date: null, shares: {} }; }
}

export interface EtfView { date: string; asof: string; baseline_date: string; baseline_generated: string; quote_time: string; quote_date: string; quote_hm: string; data_connected: boolean; stale: boolean; progress_pct: number | null; avg20_total_yi: number | null; daily_ratio: number | null; core_count: number; phase: Phase; trading_day: boolean | null; poll_ms: number; watch_codes: string[]; previous_shares_date: string | null; shares_suspect: string[]; items: Item[]; totals: { amount_yi: number | null; expected_yi: number | null; ratio: number | null; net_yi: number | null; weighted_pct: number | null }; verdict: Verdict; missing: { code: string; reason: string }[]; notes: string[] }
const last = new Map<string, EtfView>();
const calendars = new Map<string, { day: string; at: number; facts: CalendarFacts | null }>();
/** 测试用：清空 ETF 轮询的当日日历记忆。 */
export function resetEtfTurnoverCalendar(): void { calendars.clear(); }
async function calendar(ctx: ServiceContext, day: string, nowMs: number, fetch: Fetch, signal: AbortSignal): Promise<CalendarFacts | null> {
  const cached = calendars.get(ctx.dataRoot);
  if (cached?.day === day && nowMs - cached.at < (cached.facts === null ? 60_000 : 30 * 60_000)) return cached.facts;
  const facts = await fetchTodayCalendar(ctx, day, fetch, signal);
  calendars.set(ctx.dataRoot, { day, at: nowMs, facts });
  return facts;
}
const emptyView = (now: Date, watch: string[]): EtfView => ({ date: clockOf(now).day, asof: now.toISOString(), baseline_date: "", baseline_generated: "", quote_time: "", quote_date: "", quote_hm: "", data_connected: false, stale: false, progress_pct: null, avg20_total_yi: null, daily_ratio: null, core_count: CORE_CODES.length, phase: phaseOf(now), trading_day: null, poll_ms: 60_000, watch_codes: watch, previous_shares_date: null, shares_suspect: [], items: [], totals: { amount_yi: null, expected_yi: null, ratio: null, net_yi: null, weighted_pct: null }, verdict: verdict(null, null, null, null, null), missing: [], notes: ["等待首次取数"] });
export async function etfTurnoverRun(ctx: ServiceContext): Promise<EtfView> { return last.get(ctx.dataRoot) ?? emptyView(new Date(), loadWatch(ctx.dataRoot)); }

export async function etfTurnoverPoll(ctx: ServiceContext, signal: AbortSignal, fetch: Fetch = fetchEndpoint, now = new Date()): Promise<EtfView> {
  const { day, hm } = clockOf(now), phase = phaseOf(now), watch = loadWatch(ctx.dataRoot);
  const facts = await calendar(ctx, day, now.getTime(), fetch, signal);
  const trading = facts?.is_today_trading_day ?? (phase === "weekend" ? false : null);
  const notes: string[] = [];
  if (trading === false) notes.push("今日休市，展示最近一场行情；同时点倍数按全天对齐。");
  if (trading === null) notes.push("交易日历未取到，行情日期仅按腾讯时间校验。");
  const [coreEnv, watchEnv, liveEnv] = await Promise.all([
    fetch(ctx, { endpoint: "cn_etf_turnover_baseline", args: { trade_date: day, extra_codes: [] }, signal }),
    fetch(ctx, { endpoint: "cn_etf_turnover_baseline", args: { trade_date: day, extra_codes: watch, include_core: false }, signal }),
    fetch(ctx, { endpoint: "cn_etf_turnover_live", args: { extra_codes: watch }, signal }),
  ]);
  const coreBase = resultOf(coreEnv.envelope), watchBase = resultOf(watchEnv.envelope), live = resultOf(liveEnv.envelope);
  const base = coreBase || watchBase ? { date: s(coreBase?.date || watchBase?.date), items: [...records(coreBase?.items), ...records(watchBase?.items)], missing: [...records(coreBase?.missing), ...records(watchBase?.missing)] } : null;
  if (!coreBase) notes.push(`固定名单近 20 日基准未取到：${failedNote(coreEnv.envelope) || "源无数据"}`);
  if (!watchBase) notes.push(`观察组近 20 日基准未取到：${failedNote(watchEnv.envelope) || "源无数据"}`);
  if (!live) notes.push(`实时行情未取到：${failedNote(liveEnv.envelope) || "源无数据"}`);
  if (!live && last.has(ctx.dataRoot)) {
    const prior = last.get(ctx.dataRoot)!;
    const fallback = { ...prior, asof: now.toISOString(), phase, trading_day: trading, poll_ms: pollMsOf(phase, trading), data_connected: false, notes: [...prior.notes, ...notes] };
    last.set(ctx.dataRoot, fallback);
    return fallback;
  }
  const byBase = new Map(records(base?.items).map((x) => [s(x.code), x]));
  const byLive = new Map(records(live?.items).map((x) => [s(x.code), x]));
  const prev = previousShares(ctx.dataRoot, day);
  const missing = [...missingOf(base), ...missingOf(live)];
  const allCodes = [...CORE_CODES, ...watch];
  let staleCount = 0;
  const items = allCodes.map((code) => {
    const b = byBase.get(code) ?? { code, group: CORE.has(code) ? "core" : "watch" }, l = byLive.get(code) ?? { code };
    const quoteDay = s(l.quote_time).slice(0, 8);
    const stale = trading === false || (quoteDay && quoteDay !== day.replaceAll("-", "")) || phase === "closed" || phase === "weekend";
    if (quoteDay && quoteDay !== day.replaceAll("-", "")) staleCount++;
    return calcItem(b, l, n(prev.shares[code]), hm, !!stale);
  });
  if (staleCount) notes.push(`${staleCount} 只行情日期不是今天；放量倍数按全天成交额比较，不代表今日盘中变化。`);
  const suspect = sharesSuspect(items);
  for (const item of items) if (suspect.has(item.code[0]!)) item.subscr_net_yi = null;
  if (suspect.size) notes.push("份额源未日更：对应市场申赎暂不显示。");
  const core = items.filter((x) => x.group === "core");
  const valid = core.filter((x) => x.amount_yi !== null && x.avg20_yi !== null);
  const amount = valid.length ? valid.reduce((a, x) => a + x.amount_yi!, 0) : null;
  const avg20Total = valid.length ? valid.reduce((a, x) => a + x.avg20_yi!, 0) : null;
  const expected = valid.length ? valid.reduce((a, x) => a + x.avg20_yi! * dayProgress(hm, x.shape, trading === false || x.quote_time.slice(0, 8) !== day.replaceAll("-", "")), 0) : null;
  const nets = core.filter((x) => x.net_yi !== null);
  const net = nets.length ? nets.reduce((a, x) => a + x.net_yi!, 0) : null;
  const caps = core.filter((x) => x.pct !== null && x.mktcap_yi !== null && x.mktcap_yi > 0);
  const capSum = caps.reduce((a, x) => a + x.mktcap_yi!, 0);
  const weighted = capSum ? caps.reduce((a, x) => a + x.pct! * x.mktcap_yi!, 0) / capSum : null;
  const ratio = amount !== null && expected !== null && expected > 0 ? amount / expected : null;
  const tailItems = core.filter((x) => x.tail_ratio !== null && x.tail_ratio_base !== null && x.amount_yi !== null);
  const tailAmount = tailItems.reduce((a, x) => a + x.amount_yi!, 0);
  const tail = tailAmount ? tailItems.reduce((a, x) => a + x.tail_ratio! * x.amount_yi!, 0) / tailAmount : null;
  const tailBase = tailAmount ? tailItems.reduce((a, x) => a + x.tail_ratio_base! * x.amount_yi!, 0) / tailAmount : null;
  const quoteTime = items.map((x) => x.quote_time).filter((x) => /^\d{14}$/.test(x)).sort().at(-1) ?? "";
  const quoteDate = quoteTime ? `${quoteTime.slice(0, 4)}-${quoteTime.slice(4, 6)}-${quoteTime.slice(6, 8)}` : "";
  const quoteHm = quoteTime ? `${quoteTime.slice(8, 10)}:${quoteTime.slice(10, 12)}` : hm;
  const stale = !!quoteDate && quoteDate !== day;
  const progressPct = expected !== null && avg20Total !== null && avg20Total > 0 ? expected / avg20Total * 100 : null;
  const mode = stale ? "stale" : phase === "lunch" && trading !== false ? "lunch" : ["morning", "afternoon", "closing_auction"].includes(phase) && trading !== false ? "intraday" : phase === "closed" && trading !== false ? "none" : "closed";
  const annotation = timeAnnotation(mode, quoteDate || day, quoteHm, progressPct ?? 100);
  if (valid.length < CORE_CODES.length) notes.push(`固定名单 ${CORE_CODES.length} 只中 ${CORE_CODES.length - valid.length} 只缺基准或成交额；合计仅覆盖有数标的。`);
  const view: EtfView = { date: day, asof: now.toISOString(), baseline_date: s(base?.date) || day, baseline_generated: coreEnv.fetched_at || now.toISOString(), quote_time: quoteTime, quote_date: quoteDate, quote_hm: quoteHm, data_connected: !!live, stale, progress_pct: progressPct, avg20_total_yi: avg20Total, daily_ratio: amount !== null && avg20Total !== null && avg20Total > 0 ? amount / avg20Total : null, core_count: CORE_CODES.length, phase, trading_day: trading, poll_ms: pollMsOf(phase, trading), watch_codes: watch, previous_shares_date: prev.date, shares_suspect: [...suspect], items,
    totals: { amount_yi: amount, expected_yi: expected, ratio, net_yi: net, weighted_pct: weighted }, verdict: verdict(ratio, net, tail, tailBase, weighted, annotation), missing, notes };
  last.set(ctx.dataRoot, view);
  return view;
}

export async function etfTurnoverAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal): Promise<EtfView> {
  if (body.action === "poll") return etfTurnoverPoll(ctx, signal);
  if (body.action === "set_watch") { saveWatch(ctx.dataRoot, validateWatch(body.codes)); return etfTurnoverPoll(ctx, signal); }
  throw new ServiceError("bad_request", "action 只能是 poll 或 set_watch");
}

export async function etfTurnoverClose(j: JobContext, fetch: Fetch = fetchEndpoint): Promise<JobResult> {
  const watch = loadWatch(j.ctx.dataRoot);
  const [coreBase, watchBase, live] = await Promise.all([
    fetch(j.ctx, { endpoint: "cn_etf_turnover_baseline", args: { trade_date: j.day, extra_codes: [] }, consistency: { mode: "fresh" }, signal: j.signal }),
    fetch(j.ctx, { endpoint: "cn_etf_turnover_baseline", args: { trade_date: j.day, extra_codes: watch, include_core: false }, consistency: { mode: "fresh" }, signal: j.signal }),
    fetch(j.ctx, { endpoint: "cn_etf_turnover_live", args: { extra_codes: watch }, consistency: { mode: "fresh" }, signal: j.signal }),
  ]);
  const liveResult = resultOf(live.envelope);
  const baseOk = !!resultOf(coreBase.envelope) && !!resultOf(watchBase.envelope);
  const shareRows = records(liveResult?.items).filter((x) => n(x.shares) !== null);
  const count = shareRows.length ? saveShares(j.ctx.dataRoot, j.day, shareRows) : 0;
  if (!baseOk && !count) throw new Error(`ETF 收盘基准与份额均失败：${failedNote(coreBase.envelope)}；${failedNote(watchBase.envelope)}；${failedNote(live.envelope)}`);
  return { messages: [], note: `ETF 收盘基准${baseOk ? "已更新" : "失败"}；份额快照 ${count} 只` };
}
