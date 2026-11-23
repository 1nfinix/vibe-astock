/** Public market breadth from stored daily bars. Personal trades never enter this view. */
import { useEffect, useRef, useState } from "react";
import { BarChart3, Database, RefreshCw } from "lucide-react";
import { backend, type MarketHistoryResult } from "@/lib/backend";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { TrendDataTable } from "./TrendDataTable";
import type { ViewTabProps } from "./WeeklyTab";

const names = { sh: "沪", sz: "深", bj: "京", all: "合计" } as const;
const markets = ["sh", "sz", "bj"] as const;
const pct = (up: number | null | undefined, valid: number | null | undefined) =>
  up == null || !valid ? "—" : `${(up / valid * 100).toFixed(1)}%`;
const widthText = (item: { eligible: number | null; above: number | null } | undefined, reason: string | null | undefined) =>
  item?.eligible && item.above != null ? `${pct(item.above, item.eligible)} (${item.above}/${item.eligible})` : `—${reason ? ` · ${reason}` : ""}`;

export function MarketWidthView({ data }: { data: MarketHistoryResult }) {
  const palette = usePalette();
  if (!data.available) return <p role="status" className="glass p-5 text-sm text-muted-foreground">{data.reason ?? "市场历史尚未取得"}</p>;
  const series = data.series ?? [];
  const trend = series.map((r) => ({
    date: r.date,
    value: r.status === "ok" && r.valid && r.up != null ? Number((r.up / r.valid * 100).toFixed(2)) : null,
    missingReason: r.status === "missing" ? "盘后包未导入" : "无有效读数",
  }));
  const option = {
    grid: { left: 48, right: 20, top: 25, bottom: 34 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", data: series.map((r) => r.date.slice(5)), axisLabel: { color: palette.text, interval: Math.max(0, Math.floor(series.length / 8)) }, axisLine: { lineStyle: { color: palette.axis } } },
    yAxis: { type: "value", name: "%", min: 0, max: 100, axisLabel: { color: palette.text }, splitLine: { lineStyle: { color: palette.grid } } },
    series: [{ name: "上涨股票占比", type: "line", connectNulls: false, showSymbol: false, lineStyle: { color: palette.primary, width: 2 },
      data: trend.map((r) => r.value) }],
  };
  const total = markets.reduce((a, m) => {
    const row = data.markets?.[m];
    if (row) for (const k of ["observed", "valid", "up", "down", "flat"] as const) a[k] += row[k];
    return a;
  }, { observed: 0, valid: 0, up: 0, down: 0, flat: 0 });
  const rows = [...markets.map((m) => [m, data.markets?.[m]] as const), ["all", total] as const];
  return <div className="space-y-5">
    <div className="glass p-4 text-sm">
      <p className="font-semibold">{data.date} · 已观察到的沪深京 A 股</p>
      <p className="mt-1 text-xs text-muted-foreground">本地已导入 {data.coverage?.days ?? 0} 个交易日（{data.coverage?.from ?? "—"} 至 {data.coverage?.to ?? "—"}）。来源：{data.source?.name ?? "—"}。{data.calendar_status === "incomplete" ? "交易日历未完整取得。" : ""}</p>
    </div>
    <section className="glass p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold"><BarChart3 className="h-4 w-4 text-primary" /> 当日市场宽度</h2>
      <p className="mt-1 text-xs text-muted-foreground">涨跌按收盘价与参考前收盘价比较。20/60 日宽度 = 高于均线的股票数 ÷ 连续有效股票数。</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[670px] text-xs tabular-nums">
          <thead><tr className="border-b border-border/60 text-muted-foreground"><th scope="col" className="sticky left-0 z-10 bg-card py-2 pr-3 text-left">市场</th><th className="text-right">观察 / 有效</th><th className="text-right">涨 / 跌 / 平</th><th className="text-right">20 日</th><th className="text-right">60 日</th></tr></thead>
          <tbody>{rows.map(([m, row]) => <tr key={m} className="border-b border-border/40 last:border-0">
            <th scope="row" className="sticky left-0 z-10 bg-card py-2 pr-3 text-left font-medium">{names[m]}</th>
            <td className="text-right">{row ? `${row.observed} / ${row.valid}` : "—"}</td>
            <td className="text-right">{row ? `${row.up} / ${row.down} / ${row.flat}` : "—"}</td>
            <td className="text-right">{widthText(data.width?.[m]?.["20"], data.window_reason?.["20"])}</td>
            <td className="text-right">{widthText(data.width?.[m]?.["60"], data.window_reason?.["60"])}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
    <section className="glass p-4">
      <h2 className="text-sm font-semibold">近 {series.length || 60} 个交易日 · 上涨股票占比</h2>
      <p className="mt-1 text-xs text-muted-foreground">每日上涨股票数 ÷ 当日有效股票数；只描述已发生的盘面。缺日断线，不补 0。</p>
      {trend.filter((r) => r.value !== null).length >= 2 ? <EChart option={option} height={280} />
        : <p role="status" className="py-10 text-center text-sm text-muted-foreground">{data.series_reason ?? "有效历史日不足两天，暂时画不出趋势"}</p>}
      <TrendDataTable title="上涨股票占比" unit="%" rows={trend} />
      {series.some((r) => r.status === "missing") && <p className="text-xs text-warning">序列有 {series.filter((r) => r.status === "missing").length} 个交易日未导入，曲线在缺口处断开。</p>}
    </section>
    <p className="text-xs text-muted-foreground">统计仅覆盖盘后包中观察到的证券；缺行不直接判为停牌。历史口径和数据来源见本地市场历史记录。</p>
  </div>;
}

export function MarketWidthTab({ day, refreshNonce, onBusy }: ViewTabProps) {
  const [data, setData] = useState<MarketHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; requested_days: number } | null>(null);
  const backfillCtl = useRef<AbortController | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setBackfillError(null);
    return () => { backfillCtl.current?.abort(); };
  }, [day]);
  useEffect(() => {
    if (!day) return;
    const ctl = new AbortController();
    setLoading(true); setData(null); setError(null); onBusy?.(true);
    backend.marketHistory(day, 60, ctl.signal).then((r) => { if (!ctl.signal.aborted) setData(r); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "市场历史查询失败"); })
      .finally(() => { if (!ctl.signal.aborted) { setLoading(false); onBusy?.(false); } });
    return () => { ctl.abort(); onBusy?.(false); };
  }, [day, refreshNonce, reload, onBusy]);
  const ingest = async () => {
    if (!day || saving || backfilling) return;
    setSaving(true); setBackfillError(null); setError(null); onBusy?.(true);
    try { await backend.marketHistoryIngest(day); setReload((n) => n + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "盘后包采集失败"); }
    finally { setSaving(false); onBusy?.(false); }
  };
  const backfill = async () => {
    if (!day || saving || backfilling) return;
    const ctl = new AbortController();
    backfillCtl.current = ctl;
    setBackfilling(true); setBackfillError(null); setProgress(null); setError(null); onBusy?.(true);
    try {
      for (let batch = 0; batch < 12; batch++) {
        const result = await backend.marketHistoryBackfill(day, ctl.signal);
        if (ctl.signal.aborted) break;
        setProgress({ completed: result.completed, requested_days: result.requested_days });
        if (result.remaining === 0) break;
        if (result.imported.length === 0 || batch === 11) throw new Error("回填未继续推进，请稍后重试");
      }
    } catch (e) {
      if (!ctl.signal.aborted) setBackfillError(e instanceof Error ? e.message : "历史回填失败");
    } finally {
      if (backfillCtl.current === ctl) backfillCtl.current = null;
      setBackfilling(false); onBusy?.(false); setReload((n) => n + 1);
    }
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={backfilling ? () => backfillCtl.current?.abort() : backfill} disabled={saving || loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs hover:text-primary disabled:opacity-50">
        {backfilling ? "停止回填" : "回填近 60 个交易日"}
      </button>
      <button type="button" onClick={ingest} disabled={saving || loading || backfilling}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs hover:text-primary disabled:opacity-50">
      {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
      {saving ? "采集中…" : "采集这一天的盘后数据"}
      </button>
    </div>
    {progress && <p role="status" className="text-xs text-muted-foreground">已导入 {progress.completed} / {progress.requested_days} 个交易日；{progress.completed === progress.requested_days ? "回填完成。" : "中断后可继续回填。"}</p>}
    {backfillError && <p role="alert" className="glass p-4 text-sm text-destructive">{backfillError}</p>}
    {error && <p role="alert" className="glass p-4 text-sm text-destructive">{error}</p>}
    {loading ? <p role="status" className="glass p-5 text-sm text-muted-foreground">市场宽度加载中…</p> : data && <MarketWidthView data={data} />}
  </div>;
}
