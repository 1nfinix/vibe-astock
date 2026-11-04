import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";

export interface EtfItem {
  code: string; name: string; index: string; group: "core" | "watch"; huijin_yi: number | null;
  price: number | null; pct: number | null; amount_yi: number | null; mktcap_yi: number | null;
  shares: number | null; avg20_yi: number | null; hist: number[]; ratio: number | null;
  net_yi: number | null; subscr_net_yi: number | null; prev_shares: number | null;
  reason: string | null;
}
export interface EtfTurnoverViewData {
  date: string; asof: string; baseline_date: string; baseline_generated: string; quote_time: string; quote_date: string; quote_hm: string;
  data_connected: boolean; stale: boolean; progress_pct: number | null; avg20_total_yi: number | null; daily_ratio: number | null; core_count: number;
  phase: string; trading_day: boolean | null; poll_ms: number;
  watch_codes: string[]; previous_shares_date: string | null; shares_suspect: string[];
  items: EtfItem[]; totals: { amount_yi: number | null; expected_yi: number | null; ratio: number | null; net_yi: number | null; weighted_pct: number | null };
  verdict: { level: string; title: string; reason: string };
  missing: { code: string; reason: string }[]; notes: string[];
}
const num = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
const signed = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
const ratio = (v: number | null) => v == null ? "—" : `${num(v)}×`;
const colored = (v: number | null) => v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-foreground";
const weekday = (day: string) => { const d = new Date(`${day}T12:00:00+08:00`); return Number.isNaN(d.getTime()) ? day : `${day} ${["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]}`; };
const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d); };
const quoteClock = (raw: string) => /^\d{14}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}` : "—";
const intraday = (view: EtfTurnoverViewData) => !view.stale && view.trading_day !== false && ["morning", "lunch", "afternoon", "closing_auction"].includes(view.phase);
type Sort = "huijin" | "amount" | "ratio" | "net" | "mktcap";

function Bars({ values }: { values: number[] }) {
  const tail = values.slice(-30), max = Math.max(0, ...tail);
  return <div className="flex h-7 w-24 items-end gap-px" aria-label={`近 ${tail.length} 日成交额`}>
    {tail.map((v, i) => <span key={i} className={`min-w-0 flex-1 ${i === tail.length - 1 ? "bg-primary" : "bg-muted-foreground/30"}`} style={{ height: `${max > 0 ? Math.max(5, v / max * 100) : 5}%` }} title={`${num(v)} 亿元`} />)}
  </div>;
}

export function EtfTurnoverView({ view, onRefresh, autoRefresh = true, onAutoRefresh, onSetWatch, busy = false, saveError = null, error = null }: {
  view: EtfTurnoverViewData; onRefresh?: () => void; autoRefresh?: boolean; onAutoRefresh?: (on: boolean) => void;
  onSetWatch?: (codes: string[]) => void; busy?: boolean; saveError?: string | null; error?: string | null;
}) {
  const [sort, setSort] = useState<Sort>("huijin");
  const [scope, setScope] = useState<"all" | "core" | "watch">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const active = intraday(view);
  const rows = useMemo(() => view.items.filter((x) => (scope === "all" || x.group === scope) && `${x.code} ${x.name} ${x.index}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => {
      const key = ({ huijin: "huijin_yi", amount: "amount_yi", ratio: "ratio", net: "net_yi", mktcap: "mktcap_yi" } as const)[sort];
      return (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || (b.mktcap_yi ?? -Infinity) - (a.mktcap_yi ?? -Infinity);
    }), [view.items, sort, scope, search]);
  const core = rows.filter((x) => x.group === "core"), watch = rows.filter((x) => x.group === "watch");
  const submit = () => {
    if (busy) return;
    const code = newCode.trim();
    if (!/^[51]\d{5}$/.test(code)) { setInputError("请输入 5/1 开头的六位 ETF 代码"); return; }
    if (view.items.some((x) => x.code === code)) { setInputError("这只 ETF 已在名单中"); return; }
    if (view.watch_codes.length >= 30) { setInputError("观察组最多 30 只"); return; }
    setInputError(null); onSetWatch?.([...view.watch_codes, code]); setNewCode("");
  };
  const status = view.phase === "lunch" && view.trading_day !== false ? "午间休市 · 数据锁定 11:30"
    : ["morning", "afternoon", "closing_auction"].includes(view.phase) && view.trading_day !== false ? error || !view.data_connected ? "实时通道不可用 · 显示上次读数" : "实时 · 跟随刷新"
    : ["pre_open", "auction"].includes(view.phase) && view.trading_day !== false && clock(view.asof) >= "09:00" ? "等待开盘 · 9:30"
    : view.phase === "closed" && view.trading_day !== false ? "已收盘 · 今日复盘数据" : "休市 · 最近交易日收盘数据";
  const tag = view.phase === "lunch" && active ? "今日结论 · 午间半场" : active ? "今日结论 · 实时跟踪" : view.phase === "closed" && !view.stale && view.trading_day !== false ? "今日收盘复盘" : `最近交易日复盘 · ${view.quote_date || view.date}`;
  const tone = view.verdict.level === "strong" ? "!border-primary/50" : ["medium", "sell", "unclear"].includes(view.verdict.level) ? "!border-warning/40" : "";
  const missing = (reason: string) => <span title={reason}>—</span>;
  const cell = (v: number | null, reason: string, digits = 2) => v === null ? missing(reason) : num(v, digits);
  const tableRow = (x: EtfItem) => {
    const suspect = view.shares_suspect.includes(x.code[0]!);
    const lastDay = view.previous_shares_date?.slice(5) ?? "-- --";
    const sharesLine = x.shares === null || x.prev_shares === null || !view.previous_shares_date ? "申赎 待积累"
      : suspect ? "份额源未日更" : x.subscr_net_yi === null ? "申赎 待积累"
        : Math.abs(x.subscr_net_yi) < 0.005 ? `较${lastDay} 持平` : `较${lastDay} ${signed(x.subscr_net_yi)}亿`;
    return <tr key={x.code} className="border-t border-border align-top">
      <td className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2.5"><div className="font-medium text-foreground">{x.name}</div><div className="mt-1 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground"><span className="rounded border border-border px-1 text-[10px]">{x.group === "core" ? "汇金" : "观察"}</span><span className="font-mono">{x.code}</span><span>·</span><span>{x.index}</span></div>{x.group === "watch" && editing && <button type="button" disabled={busy} onClick={() => onSetWatch?.(view.watch_codes.filter((c) => c !== x.code))} className="mt-1 text-xs underline disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/50">移除</button>}</td>
      <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[13px]">{cell(x.mktcap_yi, "最新规模未取到")}</td>
      <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[13px]"><div>{cell(x.amount_yi, x.reason || "成交额未取到")}</div>{active && <small className="text-[11px] text-muted-foreground">截至 {view.quote_hm}</small>}</td>
      <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[13px]"><div className={x.ratio !== null && x.ratio >= 1.8 ? "font-semibold text-foreground" : x.ratio !== null && x.ratio < 1.3 ? "text-muted-foreground" : "text-foreground"}>{x.ratio === null ? missing(x.reason || "20 日均额未取到") : ratio(x.ratio)}</div>{active && <small className="text-[11px] text-muted-foreground">已达成日均 {ratio(x.amount_yi !== null && x.avg20_yi ? x.amount_yi / x.avg20_yi : null)}</small>}<div className="ml-auto mt-1 h-1 w-20 rounded bg-muted"><div className={`h-full rounded ${x.ratio !== null && x.ratio >= 1.8 ? "bg-primary" : x.ratio !== null && x.ratio >= 1.3 ? "bg-primary/50" : "bg-muted-foreground/30"}`} style={{ width: `${Math.min(100, Math.max(0, (x.ratio ?? 0) / 3 * 100))}%` }} /></div></td>
      <td className={`px-2 py-2.5 text-right font-mono tabular-nums text-[13px] ${colored(x.net_yi)}`}>{x.net_yi === null ? missing("外盘或内盘未取到") : signed(x.net_yi)}</td>
      <td className={`px-2 py-2.5 text-right font-mono tabular-nums text-[13px] ${colored(x.pct)}`}>{x.pct === null ? missing("涨跌幅未取到") : `${signed(x.pct)}%`}</td>
      <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[13px]"><div>{cell(x.shares, "基金份额未取到")}</div><small className="text-[11px] text-muted-foreground" title={suspect ? "同市场至少 70% 的有效标的份额与上一快照近乎相同，可能未日更" : undefined}>{sharesLine}</small></td>
      <td className="px-2 py-2.5"><Bars values={x.hist} /></td>
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[13px]">{x.group === "core" ? cell(x.huijin_yi, "历史持仓份额未取到") : "—"}</td>
    </tr>;
  };
  return <div className="min-w-0 max-w-full space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"><h2 className="text-base font-semibold text-foreground">宽基 ETF 量价跟踪</h2><p className="text-[12px] text-muted-foreground">宽基 ETF 成交额与资金动向 · 基准 {view.baseline_date ? weekday(view.baseline_date) : "—"} · 生成 {clock(view.baseline_generated)}</p></div><span className="rounded-full border border-border bg-card px-3 py-1 text-[12px] text-muted-foreground">{status}</span></header>
    <section className={`glass p-4 ${tone}`} aria-label="量价判断">
      <div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h3 className="text-xl font-semibold text-foreground">{view.verdict.title}</h3><span className="text-[12px] text-muted-foreground">{tag}</span></div><p className="mt-2 max-w-[72ch] text-sm leading-relaxed text-foreground/85">{view.verdict.reason}</p></div><div className="text-right"><strong className={`font-mono text-3xl tabular-nums ${view.totals.ratio !== null && view.totals.ratio >= 1.8 ? "text-primary" : "text-foreground"}`}>{ratio(view.totals.ratio)}</strong><p className="text-[12px] text-muted-foreground">{active ? "较同时点历史均值" : "较20日均额"}</p></div></div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 md:grid-cols-4">
        <div><p className="text-[12px] text-muted-foreground">合计成交额</p><strong className="font-mono text-lg font-semibold tabular-nums">{num(view.totals.amount_yi)} 亿</strong><p className="text-[11px] text-muted-foreground">{active ? `截至 ${view.quote_hm} · 已达成全天日均 ${ratio(view.daily_ratio)}` : `20日均额 ${num(view.avg20_total_yi)} 亿`}</p></div>
        <div><p className="text-[12px] text-muted-foreground">放大倍数</p><strong className="font-mono text-lg font-semibold tabular-nums">{ratio(view.totals.ratio)}</strong><p className="text-[11px] text-muted-foreground">{active ? `基准 ${num(view.totals.expected_yi)} 亿 = 20日均额 × 同时点进度 ${num(view.progress_pct, 1)}%` : "阈值 1.8× 为强信号"}</p><div className="relative mt-1 h-1 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${Math.min(100, Math.max(0, (view.totals.ratio ?? 0) / 2.5 * 100))}%` }} /><span aria-hidden="true" className="absolute left-[72%] top-[-2px] h-2 w-px bg-muted-foreground" /></div></div>
        <div><p className="text-[12px] text-muted-foreground">主动净买入</p><strong className={`font-mono text-lg font-semibold tabular-nums ${colored(view.totals.net_yi)}`}>{signed(view.totals.net_yi)} 亿</strong><p className="text-[11px] text-muted-foreground">主动买卖口径推算</p></div>
        <div><p className="text-[12px] text-muted-foreground">加权涨跌</p><strong className={`font-mono text-lg font-semibold tabular-nums ${colored(view.totals.weighted_pct)}`}>{view.totals.weighted_pct === null ? "—" : `${signed(view.totals.weighted_pct)}%`}</strong><p className="text-[11px] text-muted-foreground">规模加权 · {weekday(view.quote_date || view.date)}</p></div>
      </div><p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">名单为 2025 年报历史标签，非当前持仓；所有结论均为量价推测。 <a href="#etf-methodology" className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-primary/50">查看口径说明</a></p>
    </section>
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <div role="group" aria-label="范围" className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg border border-border/60 p-0.5 text-[12px]">{([["all", "全部"], ["core", "仅汇金历史组"], ["watch", "仅扩展观察"]] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={scope === key} onClick={() => setScope(key)} className={`h-full rounded-md px-2 focus-visible:ring-2 focus-visible:ring-primary/50 ${scope === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div>
      <label className="inline-flex h-8 items-center gap-1 whitespace-nowrap">排序 <select aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 max-w-[min(65vw,15rem)] rounded-md border border-border bg-background px-2 text-[12px] focus-visible:ring-2 focus-visible:ring-primary/50"><option value="huijin">汇金历史持仓 → 规模优先</option><option value="amount">今日成交额</option><option value="ratio">放量倍数</option><option value="net">主动净买入</option><option value="mktcap">最新规模</option></select></label>
      <input aria-label="搜索 ETF" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜代码 / 名称 / 指数" className="h-8 min-w-0 w-40 rounded-md border border-border bg-background px-2 text-[12px] focus-visible:ring-2 focus-visible:ring-primary/50" />
      <div className="ml-auto flex flex-wrap items-center gap-2"><span className="text-[12px] text-muted-foreground">数据时间 {quoteClock(view.quote_time)} · {view.data_connected && !error ? "实时已连接" : "实时通道不可用"}</span><label className="inline-flex h-8 items-center gap-1 whitespace-nowrap"><input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefresh?.(e.target.checked)} className="rounded-sm focus-visible:ring-2 focus-visible:ring-primary/50" />自动刷新</label><button type="button" onClick={onRefresh} disabled={busy} className="h-8 rounded-md border border-border px-2 text-[12px] hover:bg-muted disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/50">立即刷新</button></div>
    </div>
    {(error || view.notes.length > 0) && <div className="flex items-start gap-2 text-[12px] text-warning"><AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" /><ul className="space-y-0.5">{error && <li role="alert">本次刷新失败：{error}；保留上次读数。</li>}{view.notes.map((note, i) => <li key={i}>{note}</li>)}</ul></div>}
    <div className="glass max-w-full overflow-x-auto"><table className="w-full min-w-[1080px] text-[13px]"><thead className="text-[12px] font-normal text-muted-foreground"><tr><th className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2 text-left font-normal">ETF</th><th className="px-2 py-2 text-right font-normal">规模(亿)</th><th className="px-2 py-2 text-right font-normal">成交额(亿)</th><th className="px-2 py-2 text-right font-normal">{active ? "同时点倍数" : "较20日均"}</th><th className="px-2 py-2 text-right font-normal">主动净买入①</th><th className="px-2 py-2 text-right font-normal">涨跌</th><th className="px-2 py-2 text-right font-normal">份额(亿份)②</th><th className="px-2 py-2 text-right font-normal">近30日成交额</th><th className="px-3 py-2 text-right font-normal">汇金持仓(25年报·亿份)</th></tr></thead><tbody>
      {scope !== "watch" && <><tr className="bg-muted/30 text-[12px] font-medium"><th className="sticky left-0 z-10 border-r border-border bg-muted px-3 py-2 text-left font-medium">汇金历史持有</th><td colSpan={8} className="px-2 py-2 text-muted-foreground">· 2025年报最后一次实名披露（此后停止披露） {core.length} 只</td></tr>{core.map(tableRow)}<tr className="border-t-2 border-border bg-muted/40 font-semibold"><td className="sticky left-0 z-10 border-r border-border bg-card px-3 py-2">汇金历史组合计 <span className="text-[11px] font-normal text-muted-foreground">{view.core_count} 只</span></td><td className="px-2 py-2 text-right font-mono tabular-nums">—</td><td className="px-2 py-2 text-right font-mono tabular-nums">{num(view.totals.amount_yi)}</td><td className="px-2 py-2 text-right font-mono tabular-nums">{ratio(view.totals.ratio)}</td><td className="px-2 py-2 text-right font-mono tabular-nums">{signed(view.totals.net_yi)}</td><td colSpan={4} className="px-3 py-2 text-[11px] font-normal text-muted-foreground">合计口径与上方判断一致</td></tr></>}
      {scope !== "core" && <><tr className="bg-muted/30 text-[12px] font-medium"><th className="sticky left-0 z-10 border-r border-border bg-muted px-3 py-2 text-left font-medium">扩展观察</th><td colSpan={8} className="px-2 py-2 text-muted-foreground"><div className="flex items-center justify-between gap-2">· 2025年报未见汇金持仓（名单已停止更新） {watch.length} 只 <span className="flex items-center gap-2">{busy && <span role="status" className="text-[11px] font-normal">保存中…</span>}{onSetWatch && <button type="button" disabled={busy} onClick={() => setEditing((x) => !x)} className="h-8 rounded-md border border-border px-2 text-[12px] font-normal hover:bg-muted disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/50">{editing ? "完成编辑" : "编辑观察组"}</button>}</span></div>{saveError && <p role="alert" className="mt-1 text-[11px] font-normal text-danger">保存失败：{saveError}</p>}</td></tr>{editing && <tr><td className="sticky left-0 z-10 border-r border-border bg-card" /><td colSpan={8} className="px-3 py-2"><div className="flex flex-wrap items-center gap-2 text-xs"><input aria-label="添加 ETF 代码" inputMode="numeric" maxLength={6} disabled={busy} value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder="输入六位 ETF 代码" className="h-8 rounded-md border border-border bg-background px-2 text-[12px] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/50" /><button type="button" disabled={busy} onClick={submit} className="h-8 rounded-md border border-border px-2 text-[12px] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-primary/50">添加</button><span>仅作对照，不计入判断与合计；最多 30 只。</span>{inputError && <span role="alert" className="text-danger">{inputError}</span>}</div></td></tr>}{watch.map(tableRow)}</>}
    </tbody></table></div>
    {view.missing.length > 0 && <p className="max-w-[72ch] text-xs text-muted-foreground">缺数：{view.missing.map((x) => `${x.code} ${x.reason}`).join("；")}</p>}
    <section className="max-w-[72ch] space-y-2 text-[13px] leading-relaxed text-muted-foreground"><p>① 主动净买入 = 成交额 × (外盘手数 − 内盘手数) ÷ (外盘手数 + 内盘手数)。外盘、内盘是二级市场主动成交方向的估计，不等于基金申购赎回或任何机构交易。</p><p>② 申赎金额 = (本次份额 − 上一快照份额) × 最新价格；份额通常在收盘后披露或延迟更新，只有连续两个交易日收盘作业各跑一次才有值。上一快照日：{view.previous_shares_date ?? "暂无"}。</p><h3 className="text-sm font-semibold text-foreground">为什么有的是 0</h3><p>成交额、净买入或涨跌幅为 0，表示数据源返回的数值恰为 0；没有读到数值时显示「—」，并可悬停查看原因。</p><p>份额变化接近 0 可能是当日申赎很小，也可能是基金份额尚未日更；实测曾出现沪市整片份额与上一快照完全相同，因此同市场至少 3 只且 70% 以上近乎不变时标记「份额源未日更」。</p><p>「申赎 待积累」表示缺少两个连续交易日的有效收盘份额快照；需要连续两个交易日收盘作业各跑一次才有值。</p></section>
    <section id="etf-methodology" className="glass space-y-3 p-5 text-[13px] leading-relaxed text-muted-foreground [&_p]:max-w-[72ch]"><h3 className="text-sm font-semibold text-foreground">重要说明 · 名单与口径</h3>
      <p>名单是绝版历史数据。汇金历史组依据 Wind 2025 年报前十大持有人口径，相关年报于 2026 年 3 月披露。证监会于 2026-03-13 发布修订后的<a href="https://www.csrc.gov.cn/csrc/c101954/c7619929/content.shtml" target="_blank" rel="noreferrer" className="underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-primary/50">定期报告内容与格式准则</a>，2026-05-01 施行，删除列示前十名持有人的强制条款。2026 中报、三季报不再按旧口径披露实名名单，仅保留匿名「单一投资者持有比例达到或超过 20%」的提示。这份名单不能用于判断当前持仓。</p>
      <p>主动净买入是二级市场主动买卖盘的替代指标，不代表汇金或任何机构的交易；一级市场申赎依赖基金份额变化，通常需 T+1 才能观察。</p>
      <h4 className="mt-4 text-[13px] font-medium text-foreground">数据口径</h4><p>日内成交额分布：从前 20 个完整交易日的 5 分钟 K 线，逐日计算累计成交额占全天比例，再对每个时点取均值；午休维持 11:30 的进度。</p><p>成交额、涨跌、规模和份额来自腾讯实时行情。成交额由万元换算为亿元；规模、份额及涨跌以接口返回字段为准，可能延迟或缺失。</p><p>20 日均额：取新浪日 K 的成交量 × (开盘价 + 最高价 + 最低价 + 收盘价) ÷ 4，再将前 20 个完整交易日成交额平均，单位亿元。2026-11-03 的 510300 对账中，该口径与原页均额及末两日历史值一致。</p><p>盘中怎么比才可比：分母 = 各标的 20 日均额 × 其历史同时点进度，再加总；收盘或旧日行情与全天均额直接比较。放量 1.8× 为强信号阈值，1.3× 为温和放量阈值，只描述已发生的现象。</p><p>尾盘占比：尾盘半小时成交额占全天成交额，与前 20 个完整交易日的平均尾盘占比比较；只有已取得完整当日 5 分钟 K 线时才展示。</p>
      <h4 className="mt-4 text-[13px] font-medium text-foreground">名单补充依据</h4><p>固定 20 只名单参考国信证券《中国机构配置手册(2026版)之ETF篇》整理；510300「735.13 亿份、占 82.76%」的历史报道可作为交叉核对。新规第三十一条要求披露持有人户数、机构与个人持有份额及比例等汇总信息，不再强制列示前十大持有人。「1.3–1.4 万亿元」为不同公开资料的交叉测算，并非官方汇金持仓数据。</p>
      <p>扩展观察组可编辑，仅用于对照，不计入固定名单的合计与判断；2025 年报未见其汇金持仓，名单之后停止更新，不能据此推断当前持仓。</p><p>更新方式：交易日收盘后 15:35 自动更新历史基准与份额快照；盘中按盯盘刷新节奏读取本机 API。</p><p>本页结论基于公开行情的量价特征推测，不能证明任何机构当日是否交易；数据来自第三方公开接口，可能存在延迟、缺失或口径差异，以基金公司公告与交易所披露为准；不构成投资建议。</p>
    </section>
  </div>;
}
