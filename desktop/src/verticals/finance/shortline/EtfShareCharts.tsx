import { useMemo, useState } from "react";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";

export type ShareRange = { deltas: { date: string; d: number }[]; index: { date: string; v: number }[] };
export type ShareHistoryData = { status: "ready" | "syncing" | "empty" | "failed"; reason?: string; from: string | null; to: string | null; days: number; missing: { code: string; date?: string; reason: string }[]; ranges: Record<"60" | "120" | "242", ShareRange | null> };
type Span = "60" | "120" | "242";
const spans = [["60", "近3月"], ["120", "近6月"], ["242", "近1年"]] as const;
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;
function RangeButtons({ value, onChange, name }: { value: Span; onChange: (s: Span) => void; name: string }) {
  return <div role="group" aria-label={`${name}范围`} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border/60 p-0.5 text-xs">{spans.map(([key, label]) =>
    <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)} className={`h-full rounded-md px-2 focus-visible:ring-2 focus-visible:ring-primary/50 ${value === key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div>;
}
function axisLabel(date: string, crossYear: boolean) { return crossYear ? date.slice(2, 4) + "/" + date.slice(5, 7) : date.slice(5); }
export function EtfShareCharts({ data }: { data: ShareHistoryData | null }) {
  const [barSpan, setBarSpan] = useState<Span>("242");
  const [lineSpan, setLineSpan] = useState<Span>("242");
  const palette = usePalette();
  const bar = data?.ranges[barSpan], line = data?.ranges[lineSpan];
  const barDates = useMemo(() => bar?.deltas.map((p) => p.date) ?? [], [bar]);
  const lineDates = useMemo(() => line?.index.map((p) => p.date) ?? [], [line]);
  const barCross = barDates[0]?.slice(0, 4) !== barDates.at(-1)?.slice(0, 4);
  const lineCross = lineDates[0]?.slice(0, 4) !== lineDates.at(-1)?.slice(0, 4);
  const barOption = useMemo(() => ({
    animation: false, grid: { left: 58, right: 14, top: 18, bottom: 34 },
    tooltip: { trigger: "axis", backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText }, formatter: (params: any) => { const p = params[0]; return `${p.axisValue} 份额变化 ${signed(Number(p.value))} 亿份`; } },
    xAxis: { type: "category", data: barDates, axisLabel: { color: palette.text, formatter: (v: string) => axisLabel(v, barCross) }, axisLine: { lineStyle: { color: palette.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", name: "亿份", nameTextStyle: { color: palette.text }, axisLabel: { color: palette.text }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ type: "bar", data: bar?.deltas.map((p) => ({ value: p.d, itemStyle: { color: p.d >= 0 ? palette.rise : palette.fall } })) ?? [], barMaxWidth: 12 }],
  }), [bar, barDates, barCross, palette]);
  const lineOption = useMemo(() => ({
    animation: false, grid: { left: 54, right: 16, top: 18, bottom: 34 },
    tooltip: { trigger: "axis", backgroundColor: palette.tooltipBg, textStyle: { color: palette.tooltipText }, formatter: (params: any) => { const p = params[0], i = p.dataIndex, v = Number(p.value), prev = line?.index[i - 1]?.v; return `${p.axisValue} 份额指数 ${v.toFixed(2)}${prev === undefined ? "" : `<br/>较前一日 ${signed(v - prev)}`}`; } },
    xAxis: { type: "category", data: lineDates, axisLabel: { color: palette.text, formatter: (v: string) => axisLabel(v, lineCross) }, axisLine: { lineStyle: { color: palette.axis } }, axisTick: { show: false } },
    yAxis: { type: "value", scale: true, axisLabel: { color: palette.text }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ type: "line", smooth: false, showSymbol: true, symbolSize: 4, data: line?.index.map((p, i) => ({ value: p.v, symbolSize: lineDates.length <= 70 ? 4 : i === lineDates.length - 1 ? 6 : 0 })) ?? [], lineStyle: { color: palette.primary, width: 2 }, itemStyle: { color: palette.primary }, areaStyle: { color: palette.primary, opacity: 0.1 }, markLine: { silent: true, symbol: "none", lineStyle: { color: palette.text, type: "dashed" }, label: { formatter: "基期 100", color: palette.text }, data: [{ yAxis: 100 }] } }],
  }), [line, lineDates, lineCross, palette]);
  const state = !data || data.status === "syncing" ? "份额历史同步中，首次约需 1–2 分钟" : data.status === "failed" ? `份额历史读取失败：${data.reason || "数据源暂不可用"}` : "份额历史至少需要两个交易日";
  const box = "glass min-w-0 p-4 sm:p-5";
  return <section aria-label="固定名单份额历史图表" className="grid gap-4 lg:grid-cols-2">
    <div className={box}><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-foreground">固定名单每日份额变化</h3><p className="mt-1 text-xs text-muted-foreground">单位：亿份 · 正数为份额增加（净申购），负数为份额减少（净赎回）</p></div><RangeButtons value={barSpan} onChange={setBarSpan} name="每日份额变化" /></div>
      {bar && bar.deltas.length ? <EChart option={barOption} height={260} /> : <p role="status" className="grid h-[260px] place-items-center text-center text-sm text-muted-foreground">{state}</p>}
      <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">估算方法：固定名单 20 只 ETF「当日份额 − 上一交易日份额」加总；{bar?.deltas.length ? `区间 ${bar.deltas[0]?.date} ~ ${bar.deltas.at(-1)?.date}（${bar.deltas.length} 个交易日）。` : ""}份额来自上交所、深交所每日公布的 ETF 规模；份额变化可能来自任何投资者，不能据此判断汇金或任何机构的操作。缺某只某日数据时按前值顺延。</p></div>
    <div className={box}><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-semibold text-foreground">固定名单份额指数</h3><p className="mt-1 text-xs text-muted-foreground">区间首日 = 100 · 高于 100 为区间内份额净增加，低于 100 为净减少</p></div><RangeButtons value={lineSpan} onChange={setLineSpan} name="份额指数" /></div>
      {line && line.index.length ? <EChart option={lineOption} height={260} /> : <p role="status" className="grid h-[260px] place-items-center text-center text-sm text-muted-foreground">{state}</p>}
      <p className="border-t border-border pt-3 text-xs leading-relaxed text-muted-foreground">估算方法：份额指数 = 100 × 当日固定名单总份额 ÷ 区间首日总份额。只刻画份额变化的方向与幅度，不等于任何机构的持仓比例；定期报告已停止披露前十大持有人，期初持仓不可验证。</p></div>
    {data?.missing.length ? <p className="text-xs leading-relaxed text-muted-foreground lg:col-span-2">缺数 {data.missing.length} 处：{data.missing.slice(0, 5).map((x) => `${x.date ? `${x.date} ` : ""}${x.code} ${x.reason}`).join("；")}{data.missing.length > 5 ? "；其余待下次同步补齐" : ""}</p> : null}
  </section>;
}
