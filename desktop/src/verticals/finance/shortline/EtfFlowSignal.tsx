import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import type { EtfFlowDailyData, EtfFlowDay } from "./EtfFlowTypes";
import { flowNumber, flowSigned } from "./EtfFlowTypes";

const panel = "min-w-0 rounded-md border border-border bg-card p-4";
const zoom = [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }];

export function EtfFlowBackfill({ data }: { data: EtfFlowDailyData | null }) {
  const b = data?.backfill;
  if (!b || b.total === 0 || b.completed >= b.total) return null;
  return <div role="status" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
    官方份额回填中：已完成 {b.completed} / {b.total} 个交易日
    <div role="progressbar" aria-label="官方份额回填进度" aria-valuenow={b.completed} aria-valuemax={b.total} className="mt-2 h-1.5 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${b.total ? 100 * b.completed / b.total : 0}%` }} /></div>
    <span className="mt-1 block text-muted-foreground">当前可用范围：{b.from ?? "待积累"} 至 {b.to ?? "待积累"}{b.failed.length ? ` · 失败 ${b.failed.length} 处待重试` : ""}</span>
  </div>;
}

function DailyChart({ title, rows, kind, recent }: { title: string; rows: EtfFlowDay[]; kind: "turnover" | "net"; recent: Set<string> }) {
  const p = usePalette();
  const option = { animation: false, grid: { left: 58, right: 20, top: 24, bottom: 70 }, dataZoom: zoom,
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    xAxis: { type: "category", data: rows.map((r) => r.date.slice(5)), axisLabel: { color: p.text, interval: Math.max(0, Math.floor(rows.length / 8)) }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: { type: "value", name: "亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
    series: [{ type: "bar", barMaxWidth: 32, data: rows.map((r) => {
      const value = kind === "turnover" ? r.turnover_yi : r.basket.net_yi;
      return value === null ? null : { value, itemStyle: { color: kind === "turnover" ? recent.has(r.date) ? p.turnover : p.turnoverMuted : value >= 0 ? p.rise : p.fall, opacity: kind === "net" && !recent.has(r.date) ? .48 : 1 } };
    }) }] };
  return <div className={panel}><h3 className="text-sm font-semibold">{title}</h3><EChart option={option} height={250} />
    <div className="grid gap-1 text-center text-[11px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, rows.filter((r) => recent.has(r.date)).length)}, minmax(0, 1fr))` }}>{rows.filter((r) => recent.has(r.date)).map((r) => <div key={r.date} className={`rounded px-1 py-1 ${kind === "net" && r.basket.net_yi === null ? "bg-muted text-muted-foreground" : "text-foreground"}`}><div>{r.date.slice(5)}</div><div className="font-mono tabular-nums">{kind === "turnover" ? r.turnover_yi === null ? "—" : flowNumber(r.turnover_yi) : r.basket.net_yi === null ? r.basket.status : flowSigned(r.basket.net_yi)}</div></div>)}</div>
  </div>;
}

function LongChart({ title, rows, kind }: { title: string; rows: EtfFlowDay[]; kind: "turnover" | "net" }) {
  const p = usePalette();
  const option = { animation: false, grid: { left: 58, right: 58, top: 66, bottom: 70 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    legend: { top: 0, textStyle: { color: p.text } }, dataZoom: zoom,
    xAxis: { type: "category", data: rows.map((r) => r.date), axisLabel: { color: p.text, interval: Math.max(0, Math.floor(rows.length / 8)) }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: [
      { type: "value", name: "亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
      { type: "value", name: "上证综指", scale: true, axisLabel: { color: p.text }, splitLine: { show: false } },
    ],
    series: [
      { name: kind === "turnover" ? "20 只 ETF 成交额" : "20 只 ETF 净流入", type: "bar", barMaxWidth: 12,
        data: rows.map((r) => { const v = kind === "turnover" ? r.turnover_yi : r.basket.net_yi; return v === null ? null : { value: v, itemStyle: { color: kind === "turnover" ? p.turnover : v >= 0 ? p.rise : p.fall } }; }) },
      { name: "上证综指", type: "line", yAxisIndex: 1, data: rows.map((r) => r.index_close), showSymbol: false, lineStyle: { color: p.primary, width: 2 } },
    ] };
  return <div className={panel}><h3 className="text-sm font-semibold">{title}</h3><EChart option={option} height={318} /></div>;
}

export function EtfFlowSignal({ data }: { data: EtfFlowDailyData | null }) {
  const rows = data?.rows ?? [];
  const dates = [...new Set([...(data?.spike_dates ?? []), ...(data?.recent_dates ?? [])])].sort();
  const recent = new Set(data?.recent_dates ?? []);
  const picked = dates.map((d) => rows.find((r) => r.date === d)).filter((r): r is EtfFlowDay => !!r);
  const latest = rows.filter((r) => r.basket.net_yi !== null).at(-1);
  return <section id="etf-flow-signal" aria-label="放量记录" className="space-y-4 scroll-mt-24">
    <h2 className="text-base font-semibold">第二部分 · 放量记录</h2><EtfFlowBackfill data={data} />
    <p className="text-xs text-muted-foreground">放量日 = 20 只 ETF 合计净流入 &gt; 100 亿（申赎口径）{data && !data.spike_complete ? " · 历史份额尚未完整" : ""}</p>
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>{rows.at(-1)?.date === data?.date ? "今日成交额" : "最近交易日成交额"} <strong className="font-mono tabular-nums">{rows.at(-1)?.turnover_yi === null || !rows.length ? "—" : `${flowNumber(rows.at(-1)?.turnover_yi)} 亿`}</strong></span><span>最新已公布净流入（T-1 · {latest?.date ?? "待公布"}） <strong className="font-mono tabular-nums">{latest ? `${flowSigned(latest.basket.net_yi)} 亿` : "待公布"}</strong></span></div>
    <div className="grid gap-4 lg:grid-cols-2"><DailyChart title="放量日与近期成交额" rows={picked} kind="turnover" recent={recent} /><DailyChart title="放量日与近期净流入" rows={picked} kind="net" recent={recent} /></div>
    <div className="grid gap-4 lg:grid-cols-2"><LongChart title="20 只 ETF 日度成交额与上证综指" rows={rows} kind="turnover" /><LongChart title="20 只 ETF 日度净流入与上证综指" rows={rows} kind="net" /></div>
    <p className="border-t border-border pt-2 text-xs text-muted-foreground">数据来源：新浪日 K 收盘价、baostock 真实日成交额、沪深交易所官方份额；净流入 = 份额变动 × 当日收盘价，以收盘价近似净值。缺失数据保留空值。</p>
  </section>;
}
