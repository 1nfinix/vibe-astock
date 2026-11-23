import { useEffect, useState } from "react";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { backend, type Envelope, type PageResult } from "@/lib/backend";
import { parseMargin } from "@/lib/marketReview";
import { marginCalendar, marginPeriodSums, marginTrendSeries, type MarginPeriod } from "@/lib/marginTrend";
import { TrendDataTable } from "./TrendDataTable";

const periods = { day: "日度", week: "周度", month: "月度" } as const;
const amount = (value: number) => value / 1e8;
const beijingTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" });

function TrendChart({ title, unit, bars, rows }: {
  title: string; unit: string; bars?: boolean; rows: { date: string; value: number | null; partial?: boolean }[];
}) {
  const palette = usePalette();
  const dates = rows.map((row) => row.date + (row.partial ? "（部分合计）" : ""));
  const option = {
    grid: { left: 60, right: 20, top: 36, bottom: 36 },
    tooltip: { trigger: "axis", valueFormatter: (v: unknown) => typeof v === "number" ? v.toFixed(2) + unit : "—" },
    xAxis: { type: "category", data: dates, axisLabel: { color: palette.text, formatter: (v: string) => v.slice(0, 10) } },
    yAxis: { type: "value", name: unit, scale: !bars, axisLabel: { color: palette.text }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ type: bars ? "bar" : "line", name: title, showSymbol: false, connectNulls: false,
      data: rows.map(({ value, partial }) => bars && value !== null ? {
        value, itemStyle: { color: value >= 0 ? palette.rise : palette.fall, opacity: partial ? 0.45 : 1 },
      } : value) }],
  };
  const last = rows.filter((row) => row.value !== null).at(-1);
  return <section className="min-w-0 rounded-md border border-border p-3">
    <h4 className="text-sm font-semibold">{title}</h4>
    {last && last.value !== null ? <>
      <p className="mt-1 text-xs text-muted-foreground">{last.date} · {last.value.toFixed(2)} {unit}{last.partial ? " · 部分合计" : ""}</p>
      <EChart option={option} height={220} />
    </> : <p className="mt-2 text-xs text-muted-foreground">该范围暂无可用数据</p>}
    <TrendDataTable title={title} unit={unit} rows={rows} />
  </section>;
}

export function MarginTrend({ cutoff }: { cutoff: string | null }) {
  const [result, setResult] = useState<PageResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [range, setRange] = useState(60);
  const [period, setPeriod] = useState<MarginPeriod>("day");
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void backend.page("margin_trend", { refresh: refresh > 0 }).then((page) => {
      if (current) setResult(page);
    }).catch((e: unknown) => {
      if (current) setError(e instanceof Error ? e.message : "两融数据暂不可用");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [refresh]);

  const block = result?.blocks.find((b) => b.id === "margin");
  const calendarBlock = result?.blocks.find((b) => b.id === "calendar");
  const calendar = calendarBlock?.status === "ok" ? marginCalendar(calendarBlock.envelope.extra) : null;
  const usable = block?.status === "ok" || block?.status === "partial";
  const source = usable ? parseMargin(block.envelope as unknown as Envelope) : null;
  const days = marginTrendSeries(source?.series ?? [], cutoff, range, calendar);
  const through = cutoff ?? days.at(-1)?.date ?? "";
  const canAggregate = !!calendar && !!days.length && calendar.from <= days[0]!.date && calendar.to >= through;
  const shownPeriod = canAggregate ? period : "day";
  const net = marginPeriodSums(days, shownPeriod, through, calendar);
  const issue = error || block?.error || (!usable && block ? "东方财富两融数据暂不可用" : "");
  const stamp = block?.fetched_at ? new Date(block.fetched_at) : null;
  return <div className="mt-3 space-y-3" aria-label="两融趋势">
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <label>范围 <select value={range} onChange={(e) => setRange(Number(e.target.value))} className="rounded border border-border bg-background p-1">
        {[60, 120, 250].map((n) => <option key={n} value={n}>近 {n} 个交易日</option>)}
      </select></label>
      <label>净买入周期 <select value={shownPeriod} onChange={(e) => setPeriod(e.target.value as MarginPeriod)} className="rounded border border-border bg-background p-1">
        {Object.entries(periods).map(([key, label]) => <option key={key} value={key} disabled={key !== "day" && !canAggregate}>{label}</option>)}
      </select></label>
      <button type="button" disabled={loading} onClick={() => setRefresh((x) => x + 1)} className="rounded border border-border px-2 py-1 disabled:opacity-50">刷新两融趋势</button>
    </div>
    <p className="text-xs text-muted-foreground">来源：东方财富两融历史汇总。两融通常次日披露。{cutoff ? ` 复盘截止 ${cutoff}。` : " 当前未取得复盘日，展示最新披露。"}
      {stamp && Number.isFinite(+stamp) ? ` 获取于 ${beijingTime.format(stamp)}（北京时间）。` : ""}</p>
    {loading && <p role="status" className="text-xs">正在读取两融趋势…</p>}
    {issue && <p role="status" className="break-words text-xs text-warning">更新失败{days.length ? "，显示上次取得的数据" : ""}：{issue.slice(0, 180)}</p>}
    {!loading && !canAggregate && days.length > 0 && <p className="text-xs text-muted-foreground">交易日历未覆盖所选范围，周月汇总暂不可用。</p>}
    {!loading && usable && !days.length && <p role="status" className="text-xs text-muted-foreground">来源窗口没有覆盖该复盘日期。</p>}
    {days.length > 0 && <>
      {days.length < range && <p className="text-xs text-muted-foreground">所选范围内仅有 {days.length} 个交易日可展示。</p>}
      {shownPeriod !== "day" && <p className="text-xs text-muted-foreground">浅色柱为部分合计：区间未结束、超出所选范围或有交易日缺数。</p>}
      <TrendChart title={`融资净买入（${periods[shownPeriod]}）`} unit="亿元" bars rows={net.map((r) => ({ ...r, value: r.value === null ? null : amount(r.value) }))} />
      <TrendChart title="融资余额" unit="亿元" rows={days.map((r) => ({ date: r.date, value: r.financing === null ? null : amount(r.financing) }))} />
      <TrendChart title="融资余额占流通市值" unit="%" rows={days.map((r) => ({ date: r.date, value: r.floatPct }))} />
    </>}
  </div>;
}
