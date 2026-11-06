import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import type { EtfFlowCumData, EtfFlowPollData, EtfFlowTypicalData, EtfFlowTypicalGroup } from "./EtfFlowTypes";
import { flowNumber, flowSigned } from "./EtfFlowTypes";

const panel = "min-w-0 rounded-md border border-border bg-card p-4";
const zoom = [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }];
const textTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date); };

function TypicalChart({ title, group, other, times }: { title: string; group: EtfFlowTypicalGroup; other: EtfFlowTypicalGroup; times: string[] }) {
  const p = usePalette();
  const option = { animation: false, grid: { left: 52, right: 20, top: 36, bottom: 40 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    legend: { top: 0, textStyle: { color: p.text } },
    xAxis: { type: "category", data: times, axisLabel: { color: p.text, interval: 5 }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: { type: "value", name: "亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
    series: [
      { name: "P25–P75", type: "bar", stack: "range", data: group.values?.map((x) => x.p25) ?? [], itemStyle: { color: "transparent" }, silent: true },
      { name: "P25–P75", type: "bar", stack: "range", data: group.values?.map((x) => x.p75 - x.p25) ?? [], itemStyle: { color: p.primary, opacity: .22 }, barMaxWidth: 10 },
      { name: `${title}均值`, type: "bar", data: group.values?.map((x) => x.mean) ?? [], itemStyle: { color: p.primary }, barMaxWidth: 5, barGap: "-100%" },
      { name: "另一组均值", type: "line", data: other.values?.map((x) => x.mean) ?? [], showSymbol: false, lineStyle: { color: p.benchmark, width: 2 } },
    ] };
  return <div className={panel}><h4 className="text-sm font-semibold">{title} <span className="font-mono text-xs font-normal text-muted-foreground">n={group.n}</span></h4>
    {group.values ? <EChart option={option} height={252} /> : <p role="status" className="grid h-48 place-items-center text-sm text-muted-foreground">{group.reason}</p>}
    {group.values && <p className="text-xs text-muted-foreground">均值累计至收盘 {flowNumber(group.values.at(-1)?.cumulative)} 亿</p>}
  </div>;
}

export function EtfFlowIntraday({ poll, cum, typical, comparisonDate, onComparisonDate, onRefresh, auto, onAuto, error, previousIndexClose }: {
  poll: EtfFlowPollData | null; cum: EtfFlowCumData | null; typical: EtfFlowTypicalData | null;
  comparisonDate: string; onComparisonDate: (date: string) => void; onRefresh: () => void; auto: boolean; onAuto: (value: boolean) => void;
  error: string | null; previousIndexClose: number | null;
}) {
  const p = usePalette();
  const bars = poll?.bars;
  const index = new Map(poll?.index?.times.map((t, i) => [t, poll.index.close[i] ?? null]) ?? []);
  const intraday = { animation: false, grid: { left: 58, right: 62, top: 66, bottom: 72 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    legend: { top: 0, textStyle: { color: p.text } }, dataZoom: zoom,
    xAxis: { type: "category", data: bars?.times ?? [], axisLabel: { color: p.text }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: [
      { type: "value", name: "亿元", min: 0, max: bars?.barAxisMax ?? 10, axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
      { type: "value", name: "上证综指", scale: true, axisLabel: { color: p.text }, splitLine: { show: false } },
    ],
    series: [
      { name: "20 只 ETF 分钟成交额", type: "bar", data: bars?.amount_yi ?? [], itemStyle: { color: p.turnover }, barMaxWidth: 7 },
      { name: "上证综指", type: "line", yAxisIndex: 1, data: bars?.times.map((t) => index.get(t) ?? null) ?? [], showSymbol: false,
        lineStyle: { color: p.primary, width: 2 }, markLine: previousIndexClose === null ? undefined : { silent: true, symbol: "none", lineStyle: { color: p.benchmark, type: "dashed" }, label: { formatter: "昨收", color: p.text }, data: [{ yAxis: previousIndexClose }] } },
    ] };
  const cumulative = { animation: false, grid: { left: 58, right: 20, top: 66, bottom: 72 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    legend: { top: 0, textStyle: { color: p.text } }, dataZoom: zoom,
    xAxis: { type: "category", data: cum?.slots ?? [], axisLabel: { color: p.text, interval: 29 }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: { type: "value", name: "亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
    series: [
      { name: "今日", type: "line", data: cum?.today ?? [], showSymbol: false, lineStyle: { color: p.rise, width: 2 } },
      { name: `对比日 ${cum?.comparison.date ?? ""}`, type: "line", data: cum?.comparison.values ?? [], showSymbol: false, lineStyle: { color: p.primary, width: 2 } },
      { name: "近 20 日均值", type: "line", data: cum?.average20.values ?? [], showSymbol: false, lineStyle: { color: p.benchmark, width: 2 } },
    ] };
  const rows = [...(poll?.ranking ?? [])].sort((a, b) => (b.amount_yi ?? -Infinity) - (a.amount_yi ?? -Infinity));
  const max = Math.max(0, ...rows.map((r) => r.amount_yi ?? 0));
  return <section id="etf-flow-intraday" className="space-y-4 scroll-mt-24" aria-label="盘中分钟观测">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">第一部分 · 盘中分钟观测</h2><div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>交易日 {poll?.date ?? "—"} · 更新 {poll ? textTime(poll.asof) : "—"}</span><button type="button" onClick={onRefresh} className="rounded border border-border px-2 py-1 text-foreground">立即刷新</button><button type="button" onClick={() => onAuto(!auto)} className="rounded border border-border px-2 py-1 text-foreground">{auto ? "暂停自动刷新" : "恢复自动刷新"}</button></div></div>
    {error && <p role="alert" className="text-xs text-warning">本次刷新失败：{error}</p>}
    <div className={panel}><h3 className="text-sm font-semibold">20 只 ETF 分钟成交额与上证综指</h3>{bars?.amount_yi?.length ? <EChart option={intraday} height={330} /> : <p role="status" className="py-16 text-center text-sm text-muted-foreground">{bars?.reason || "分钟数据待取"}</p>}{bars?.reason && bars.amount_yi && <p className="text-xs text-muted-foreground">{bars.reason}</p>}{previousIndexClose === null && <p className="text-xs text-muted-foreground">昨收参考线待日线数据</p>}</div>
    <div className={panel}><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">当日分钟累计成交额</h3><label className="text-xs text-muted-foreground">对比日 <select aria-label="选择对比日" value={comparisonDate || cum?.comparison.date || ""} onChange={(e) => onComparisonDate(e.target.value)} className="rounded border border-border bg-background px-2 py-1 text-foreground"><option value="">上一交易日</option>{cum?.comparison_dates.map((d) => <option key={d} value={d}>{d}</option>)}</select></label></div>
      {cum ? <EChart option={cumulative} height={330} /> : <p role="status" className="py-16 text-center text-sm text-muted-foreground">累计数据待取</p>}
      <p className="text-xs text-muted-foreground">近 20 日均值：实际 {cum?.average20.n ?? "—"} 天{cum?.average20.from ? ` · ${cum.average20.from} 至 ${cum.average20.to}` : ""}</p></div>
    <div className="grid gap-4 lg:grid-cols-2"><TypicalChart title="放量日形态" group={typical?.spike ?? { n: 0, values: null, reason: "样本待取" }} other={typical?.normal ?? { n: 0, values: null, reason: null }} times={typical?.times ?? []} /><TypicalChart title="常态日形态" group={typical?.normal ?? { n: 0, values: null, reason: "样本待取" }} other={typical?.spike ?? { n: 0, values: null, reason: null }} times={typical?.times ?? []} /></div>
    <div className={`${panel} overflow-x-auto`}><h3 className="mb-2 text-sm font-semibold">单只 ETF 当日成交额排行</h3><table className="w-full min-w-[620px] text-xs"><thead className="text-muted-foreground"><tr><th scope="col" className="py-2 text-left">代码</th><th scope="col" className="text-left">名称</th><th scope="col" className="text-right">当日成交额(亿)</th><th scope="col" className="text-right">占比</th><th scope="col" className="text-right">涨跌幅</th></tr></thead><tbody>{rows.map((r) => <tr key={r.code} className="border-t border-border"><td className="py-2 font-mono">{r.code}</td><td>{r.name || r.code}</td><td className="relative text-right font-mono tabular-nums"><span aria-hidden="true" className="absolute inset-y-1 right-0 bg-primary/15" style={{ width: `${r.amount_yi !== null && max > 0 ? r.amount_yi / max * 100 : 0}%` }} /><span className="relative" title={r.reason || undefined}>{r.amount_yi === null ? r.reason || "—" : flowNumber(r.amount_yi)}</span></td><td className="text-right font-mono tabular-nums" title={r.reason || undefined}>{r.share_pct === null ? r.reason || "—" : `${flowNumber(r.share_pct)}%`}</td><td className={`text-right font-mono tabular-nums ${r.pct === null ? "text-muted-foreground" : r.pct >= 0 ? "text-danger" : "text-success"}`}>{r.pct === null ? r.pct_reason || "—" : `${flowSigned(r.pct)}%`}</td></tr>)}</tbody></table></div>
    <p className="border-t border-border pt-2 text-xs text-muted-foreground">数据来源：新浪分钟/日 K、腾讯行情；成交额按分钟成交量 × OHLC 均价估算，单位亿元。</p>
  </section>;
}
