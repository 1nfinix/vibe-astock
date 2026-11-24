import { useEffect, useRef, useState } from "react";
import { backend, type Envelope, type PageResult } from "@/lib/backend";
import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import { TrendDataTable } from "./TrendDataTable";

type PledgeRow = { code: string; name: string; ratio: number; shares: number | null; value: number | null };
type WeeklyRow = { date: string; companies: number; pledged_shares_10k: number | null; pledged_mktcap_10k: number | null; companies_ratio_ge_50: number | null; missing_shares: number; missing_mktcap: number; missing_ratio: number; official_new_pledges: number | null; official_new_shares_10k: number | null; official_error: string | null };

function WeeklyChart({ title, unit, rows }: { title: string; unit: string; rows: { date: string; value: number | null }[] }) {
  const palette = usePalette();
  return <section className="min-w-0 rounded border border-border p-3">
    <h3 className="text-sm font-semibold">{title}</h3>
    <EChart height={190} option={{
      grid: { left: 60, right: 15, top: 20, bottom: 35 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: rows.map((row) => row.date), axisLabel: { color: palette.text } },
      yAxis: { type: "value", scale: true, name: unit, axisLabel: { color: palette.text }, splitLine: { lineStyle: { color: palette.grid } } },
      series: [{ type: "line", name: title, showSymbol: true, connectNulls: false, data: rows.map((row) => row.value), itemStyle: { color: palette.primary } }],
    }} />
    <TrendDataTable title={title} unit={unit} rows={rows} />
  </section>;
}

export function PledgeSnapshot() {
  const refreshSeen = useRef(0);
  const shownDate = useRef("");
  const [page, setPage] = useState<PageResult | null>(null);
  const [date, setDate] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    if (date !== shownDate.current) setPage(null);
    shownDate.current = date;
    const fresh = refresh > refreshSeen.current;
    refreshSeen.current = refresh;
    void backend.page("pledge_snapshot", {
      refresh: fresh,
      ...(date ? { blockArgs: { pledge: { date }, history: { before: date } } } : {}),
    }).then((result) => {
      if (current) setPage(result);
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : "质押数据暂不可用");
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [date, refresh]);

  const block = page?.blocks.find((item) => item.id === "pledge");
  const historyBlock = page?.blocks.find((item) => item.id === "history");
  const historySource = (historyBlock?.envelope as Envelope | undefined)?.extra?.history;
  const history: WeeklyRow[] = Array.isArray(historySource) ? historySource.filter((row) =>
    typeof row === "object" && row !== null && typeof row.date === "string" &&
    typeof row.companies === "number" &&
    [row.pledged_shares_10k, row.pledged_mktcap_10k, row.companies_ratio_ge_50]
      .every((value) => value === null || typeof value === "number" && Number.isFinite(value)))
    .map((row) => ({ ...row,
      official_new_pledges: typeof row.official_new_pledges === "number" ? row.official_new_pledges : null,
      official_new_shares_10k: typeof row.official_new_shares_10k === "number" ? row.official_new_shares_10k : null,
      official_error: row.official_error ?? ("official_new_shares_10k" in row ? null : "请刷新获取官方新办理量"),
    })) : [];
  const evidence = (block?.envelope as Envelope | undefined)?.evidence ?? [];
  const count = evidence.find((item) => item.field === "pledge_snapshot_count");
  const rows = new Map<string, PledgeRow>();
  for (const item of evidence) {
    if (!item.record_key) continue;
    const code = item.record_key.split(":")[0] ?? "";
    const row = rows.get(item.record_key) ?? { code, name: item.note?.split(";")[0] ?? code, ratio: 0, shares: null, value: null };
    if (item.field === "pledge_ratio" && typeof item.value === "number") row.ratio = item.value;
    if (item.field === "pledged_shares" && typeof item.value === "number") row.shares = item.value;
    if (item.field === "pledged_mktcap" && typeof item.value === "number") row.value = item.value;
    rows.set(item.record_key, row);
  }
  const sample = [...rows.values()].sort((a, b) => b.ratio - a.ratio);
  const sourceError = (block?.envelope as Envelope | undefined)?.errors?.[0] as { error?: unknown } | undefined;
  const issue = error || block?.error || (typeof sourceError?.error === "string" ? sourceError.error : "");
  const historySourceError = (historyBlock?.envelope as Envelope | undefined)?.errors?.[0] as { error?: unknown } | undefined;
  const historyIssue = historyBlock?.error || (typeof historySourceError?.error === "string" ? historySourceError.error : "");
  const latest = history.at(-1);
  const stamp = historyBlock?.fetched_at ? new Date(historyBlock.fetched_at) : null;
  return <div className="mt-3 space-y-3 text-xs">
    <div className="flex flex-wrap items-center gap-3">
      <label>统计日 <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded border border-border bg-background p-1" /></label>
      <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={loading} className="rounded border border-border px-2 py-1 disabled:opacity-50">刷新质押数据</button>
    </div>
    <p className="text-muted-foreground">存量来自东方财富转引的中国结算逐股统计，覆盖沪深有质押记录的股票，股数与市值为逐股求和。新增办理量来自中国结算官网，表示本期办理的质押，不等于存量变化。高质押公司按质押比例 ≥50% 计数。{stamp && Number.isFinite(+stamp) ? ` 获取于 ${stamp.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）。` : ""}</p>
    {loading && <p role="status">正在读取质押统计…</p>}
    {historyIssue && <p role="status" className="text-warning">周度趋势读取失败：{historyIssue.slice(0, 180)}</p>}
    {latest && <div className="grid gap-2 sm:grid-cols-4">
      <p className="rounded border border-border p-2">统计日 <strong className="block text-base">{latest.date}</strong></p>
      <p className="rounded border border-border p-2">已观察质押股数 <strong className="block text-base">{latest.pledged_shares_10k === null ? "—" : `${(latest.pledged_shares_10k / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿股`}</strong></p>
      <p className="rounded border border-border p-2">已观察质押市值 <strong className="block text-base">{latest.pledged_mktcap_10k === null ? "—" : `${(latest.pledged_mktcap_10k / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿元`}</strong></p>
      <p className="rounded border border-border p-2">质押比例 ≥50% <strong className="block text-base">{latest.companies_ratio_ge_50 === null ? "—" : `${latest.companies_ratio_ge_50} 只`}</strong></p>
      <p className="rounded border border-border p-2">本期新办理质押 <strong className="block text-base">{latest.official_new_shares_10k === null ? "—" : `${(latest.official_new_shares_10k / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 亿股`}</strong><span>中国结算官网 · {latest.official_new_pledges ?? "—"} 笔</span></p>
    </div>}
    {history.some((row) => row.missing_shares || row.missing_mktcap || row.missing_ratio || row.official_error) && <p className="text-warning">部分统计期有字段缺值或官方数据未取得，对应指标留空。展开图表数据可查看缺口日期。</p>}
    {history.length > 0 && <div className="grid gap-3 lg:grid-cols-2">
      <WeeklyChart title="已观察质押股数" unit="亿股" rows={history.map((row) => ({ date: row.date, value: row.pledged_shares_10k === null ? null : row.pledged_shares_10k / 10000 }))} />
      <WeeklyChart title="已观察质押市值" unit="亿元" rows={history.map((row) => ({ date: row.date, value: row.pledged_mktcap_10k === null ? null : row.pledged_mktcap_10k / 10000 }))} />
      <WeeklyChart title="质押比例 ≥50% 的公司" unit="只" rows={history.map((row) => ({ date: row.date, value: row.companies_ratio_ge_50 }))} />
      <WeeklyChart title="有质押记录的公司" unit="只" rows={history.map((row) => ({ date: row.date, value: row.companies }))} />
      <WeeklyChart title="本期新办理质押股数" unit="亿股" rows={history.map((row) => ({ date: row.date, value: row.official_new_shares_10k === null ? null : row.official_new_shares_10k / 10000 }))} />
    </div>}
    {issue && <p role="status" className="text-warning">读取失败：{issue.slice(0, 180)}</p>}
    {count && <p>统计日 {count.period.split("..")[0]} · 沪深有质押记录 {String(count.value)} 只。下表展示质押比例最高的 {sample.length} 只。</p>}
    {!loading && !count && !issue && <p role="status">该日期暂无质押统计。</p>}
    {sample.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[540px] text-left">
      <thead><tr><th className="sticky left-0 z-10 bg-card py-2">股票</th><th>质押比例</th><th>质押股数（万股）</th><th>质押市值（万元）</th></tr></thead>
      <tbody>{sample.map((row) => <tr key={row.code} className="border-t border-border/60">
        <th scope="row" className="sticky left-0 z-10 bg-card py-2 font-medium">{row.name} {row.code}</th>
        <td>{row.ratio.toFixed(2)}%</td><td>{row.shares?.toLocaleString("zh-CN") ?? "—"}</td><td>{row.value?.toLocaleString("zh-CN") ?? "—"}</td>
      </tr>)}</tbody>
    </table></div>}
  </div>;
}
