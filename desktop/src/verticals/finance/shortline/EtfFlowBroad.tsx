import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import type { EtfFlowDailyData, EtfFlowMetric } from "./EtfFlowTypes";
import { FLOW_CATEGORIES, flowSigned } from "./EtfFlowTypes";
import { EtfFlowBackfill } from "./EtfFlowSignal";

const totalOf = (values: (number | null)[]): number | null => values.every((v): v is number => v !== null) ? values.reduce((a, b) => a + b, 0) : null;
const statusOf = (metrics: EtfFlowMetric[]) => metrics.find((m) => m.net_yi === null)?.status ?? "—";
export const CATEGORY_COLORS = ["#5b86b0", "#b48655", "#8a78ad", "#59978e", "#aa728e", "#8c8b58", "#699b70", "#ae786b", "#648aa0", "#9474a4", "#769a60", "#a88859"] as const;

export function EtfFlowBroad({ data }: { data: EtfFlowDailyData | null }) {
  const p = usePalette();
  const rows = data?.rows.filter((r) => r.date.slice(0, 4) === data.date.slice(0, 4)) ?? [];
  const recent = [...(data?.recent_month_categories ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const columnMax = Object.fromEntries(FLOW_CATEGORIES.map((c) => [c, Math.max(0, ...recent.map((r) => Math.abs(r.categories[c]?.net_yi ?? 0)))]));
  const totalMax = Math.max(0, ...recent.map((r) => Math.abs(totalOf(FLOW_CATEGORIES.map((c) => r.categories[c]?.net_yi ?? null)) ?? 0)));
  const cell = (value: number | null, status: string, max: number) => value === null
    ? <span className="text-muted-foreground">{status}</span>
    : <span className={`inline-block rounded-sm px-1 font-mono tabular-nums ${value > 0 ? "text-danger" : value < 0 ? "text-success" : "text-foreground"}`}
      style={{ backgroundColor: value === 0 || max === 0 ? undefined : `color-mix(in srgb, ${value > 0 ? p.rise : p.fall} ${Math.round(5 + 22 * Math.abs(value) / max)}%, transparent)` }}>{flowSigned(value)}</span>;
  const cumulative = rows.map((r) => totalOf(FLOW_CATEGORIES.map((c) => r.cumulative_ytd?.[c] ?? null)));
  const option = { animation: false, grid: { left: 58, right: 58, top: 78, bottom: 70 },
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    legend: { top: 0, type: "scroll", textStyle: { color: p.text } }, dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }],
    xAxis: { type: "category", data: rows.map((r) => r.date), axisLabel: { color: p.text, interval: Math.max(0, Math.floor(rows.length / 8)) }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: [
      { type: "value", name: "日净流入·亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
      { type: "value", name: "年内累计·亿元", axisLabel: { color: p.text }, splitLine: { show: false } },
    ],
    series: [
      ...FLOW_CATEGORIES.map((c, i) => ({ name: c, type: "bar", stack: "net", barMaxWidth: 16, color: CATEGORY_COLORS[i], itemStyle: { color: CATEGORY_COLORS[i] },
        data: rows.map((r) => r.categories[c]?.net_yi ?? null) })),
      { name: "年初以来累计净流入", type: "line", yAxisIndex: 1, data: cumulative, showSymbol: false, color: p.primary, lineStyle: { color: p.primary, width: 2 } },
    ] };
  return <section id="etf-flow-broad" aria-label="日度资金全景" className="space-y-4 scroll-mt-24">
    <h2 className="text-base font-semibold">第三部分 · 日度资金全景</h2><EtfFlowBackfill data={data} />
    <div className="min-w-0 rounded-md border border-border bg-card p-4"><h3 className="text-sm font-semibold">年初以来全市场宽基 ETF 日度净流入</h3>{rows.length ? <EChart option={option} height={380} /> : <p role="status" className="py-16 text-center text-sm text-muted-foreground">日度数据待取</p>}</div>
    <div className="min-w-0 overflow-x-auto rounded-md border border-border bg-card p-4"><h3 className="mb-3 text-sm font-semibold">最近一个月 · 12 类日度净流入</h3><table className="min-w-[1500px] w-full text-xs"><thead className="text-muted-foreground"><tr><th scope="col" className="sticky left-0 bg-card py-2 text-left">日期</th><th scope="col" className="px-2 text-right">合计</th>{FLOW_CATEGORIES.map((c) => <th key={c} scope="col" className="px-2 text-right font-normal">{c}</th>)}</tr></thead><tbody>{recent.map((r) => {
      const metrics = FLOW_CATEGORIES.map((c) => r.categories[c] ?? { net_yi: null, missing_count: 0, status: "份额缺失" });
      const total = totalOf(metrics.map((m) => m.net_yi));
      return <tr key={r.date} className="border-t border-border"><th scope="row" className="sticky left-0 bg-card py-2 text-left font-mono font-normal">{r.date}</th><td className="px-2 text-right">{cell(total, statusOf(metrics), totalMax)}</td>{FLOW_CATEGORIES.map((c) => <td key={c} className="px-2 text-right">{cell(r.categories[c]?.net_yi ?? null, r.categories[c]?.status ?? "份额缺失", columnMax[c] ?? 0)}</td>)}</tr>;
    })}</tbody></table>{!recent.length && <p role="status" className="py-8 text-center text-sm text-muted-foreground">明细待取</p>}</div>
    <p className="border-t border-border pt-2 text-xs text-muted-foreground">数据来源：新浪日 K、沪深交易所官方份额；净流入 = 份额变动 × 当日收盘价，以收盘价近似净值。缺份额的类别及合计保留空值。</p>
  </section>;
}
