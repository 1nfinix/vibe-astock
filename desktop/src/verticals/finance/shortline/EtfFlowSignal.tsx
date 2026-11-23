import { EChart } from "@/components/ui/EChart";
import { usePalette } from "@/components/ui/chartPalette";
import type { EtfFlowDailyData, EtfFlowDay } from "./EtfFlowTypes";
import { flowNumber, flowSigned } from "./EtfFlowTypes";

const panel = "min-w-0 rounded-md border border-border bg-card p-4";
const zoom = [{ type: "inside" }, { type: "slider", height: 18, bottom: 8 }];
function failureReason(reason: string) {
  if (/timed?\s*out|timeout|超时/i.test(reason)) return "交易所份额请求超时";
  if (/\b429\b(?=\s+(?:Client Error|Too Many Requests))|限流/i.test(reason)) return "交易所份额请求受限";
  if (/HTTPS?ConnectionPool|Max retries exceeded|ProxyError|ConnectionError|RemoteDisconnected|SSLError/i.test(reason)) {
    return "交易所份额接口连接失败";
  }
  const message = reason.replace(/^\s*[A-Za-z_][\w.]*Error:\s*/, "").replace(/\s+/g, " ").trim();
  return message.length > 100 ? "份额数据获取失败" : message || "原因未返回";
}

export function EtfFlowBackfill({ data }: { data: EtfFlowDailyData | null }) {
  const b = data?.backfill;
  if (!b || b.total > 0 && b.completed >= b.total && !b.syncing && b.failed.length === 0) return null;
  const failedReasons = new Map<string, number>();
  for (const item of b.failed) {
    const reason = failureReason(item.reason);
    failedReasons.set(reason, (failedReasons.get(reason) ?? 0) + 1);
  }
  const summary = [...failedReasons].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const otherFailures = b.failed.length - summary.reduce((sum, [, count]) => sum + count, 0);
  if (otherFailures) summary.push(["其他原因", otherFailures]);
  return <div role="status" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
    官方份额历史{b.syncing ? "正在回填" : "未在回填"}：已完成 {b.completed} / {b.total || "目标待确定"} 个交易日
    {b.total > 0 && <div role="progressbar" aria-label="官方份额回填进度" aria-valuemin={0} aria-valuenow={b.completed} aria-valuemax={b.total} className="mt-2 h-1.5 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${100 * b.completed / b.total}%` }} /></div>}
    <span className="mt-1 block text-muted-foreground">已回填范围：{b.from ?? "待积累"} 至 {b.to ?? "待积累"}。进度只统计宽基份额回填任务完成的交易日；已有净流入可由本地份额记录与日线收盘价算出，成交额取自日线。</span>
    {b.failed.length > 0 && <div className="mt-1 break-words text-warning">失败 {b.failed.length} 处：{summary.map(([reason, count]) => `${reason} ×${count}`).join("；")}
      <details><summary>查看失败明细（{b.failed.length} 处）</summary><ul className="max-h-48 overflow-auto">{b.failed.map((x, i) => <li key={`${x.code}-${x.date ?? ""}-${i}`}>{x.date ? `${x.date} ` : ""}{x.code} {failureReason(x.reason)}</li>)}</ul></details>
    </div>}
  </div>;
}

function DailyChart({ title, rows, kind, recent, loading }: { title: string; rows: EtfFlowDay[]; kind: "turnover" | "net"; recent: Set<string>; loading: boolean }) {
  const p = usePalette();
  const available = rows.some((r) => kind === "turnover" ? r.turnover_yi !== null : r.basket.net_yi !== null);
  const reason = loading ? "近期交易日数据待取" : !rows.length ? "近期交易日数据未取到：日度数据未返回可绘制的交易日" : kind === "turnover" ? "近期 ETF 日线成交额未取到" : `近期净流入未取到：${[...new Set(rows.map((r) => r.basket.status))].join("、")}`;
  const option = { animation: false, grid: { left: 58, right: 20, top: 24, bottom: 70 }, dataZoom: zoom,
    tooltip: { trigger: "axis", backgroundColor: p.tooltipBg, textStyle: { color: p.tooltipText } },
    xAxis: { type: "category", data: rows.map((r) => r.date.slice(5)), axisLabel: { color: p.text, interval: Math.max(0, Math.floor(rows.length / 8)) }, axisLine: { lineStyle: { color: p.axis } } },
    yAxis: { type: "value", name: "亿元", axisLabel: { color: p.text }, splitLine: { lineStyle: { color: p.grid } } },
    series: [{ type: "bar", barMaxWidth: 32, data: rows.map((r) => {
      const value = kind === "turnover" ? r.turnover_yi : r.basket.net_yi;
      return value === null ? null : { value, itemStyle: { color: kind === "turnover" ? recent.has(r.date) ? p.turnover : p.turnoverMuted : value >= 0 ? p.rise : p.fall, opacity: kind === "net" && !recent.has(r.date) ? .48 : 1 } };
    }) }] };
  return <div className={panel}><h3 className="text-sm font-semibold">{title}</h3>{available ? <EChart option={option} height={250} /> : <p role="status" className="grid h-[250px] place-items-center text-sm text-muted-foreground">{reason}</p>}
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
  const last = rows.at(-1);
  const turnoverReason = !last ? "日度数据未返回交易日明细" : "ETF 日线成交额未取到";
  const dates = [...new Set([...(data?.spike_dates ?? []), ...(data?.recent_dates ?? [])])].sort();
  const recent = new Set(data?.recent_dates ?? []);
  const picked = dates.map((d) => rows.find((r) => r.date === d)).filter((r): r is EtfFlowDay => !!r);
  const latest = rows.filter((r) => r.basket.net_yi !== null).at(-1);
  const lag = latest ? rows.filter((r) => r.date > latest.date).length : null;
  return <section id="etf-flow-signal" aria-label="放量记录" className="space-y-4 scroll-mt-24">
    <h2 className="text-base font-semibold">第二部分 · 放量记录</h2>
    <p className="text-xs text-muted-foreground">放量日 = 20 只 ETF 合计净流入 &gt; 100 亿（申赎口径）{data && !data.spike_complete ? " · 历史份额尚未完整" : ""}</p>
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm"><span>{last && last.date === data?.date ? "今日成交额" : "最近交易日成交额"} <strong className="font-mono tabular-nums" title={data && last?.turnover_yi == null ? turnoverReason : undefined}>{!data ? "待取" : last?.turnover_yi == null ? <><span aria-hidden="true">—</span><span className="sr-only">{turnoverReason}</span></> : `${flowNumber(last.turnover_yi)} 亿`}</strong></span><span className={lag !== null && lag > 1 ? "text-warning" : undefined}>最新已公布净流入（{!data ? "数据待取" : latest?.date ?? "日期待取"} · {lag === null ? data ? "待公布" : "待取" : lag === 0 ? "当日" : lag === 1 ? "T-1" : `滞后 ${lag} 个交易日`}） <strong className="font-mono tabular-nums">{latest ? `${flowSigned(latest.basket.net_yi)} 亿` : data ? "待公布" : "待取"}</strong></span></div>
    <div className="grid gap-4 lg:grid-cols-2"><DailyChart title="放量日与近期成交额" rows={picked} kind="turnover" recent={recent} loading={!data} /><DailyChart title="放量日与近期净流入" rows={picked} kind="net" recent={recent} loading={!data} /></div>
    <div className="grid gap-4 lg:grid-cols-2"><LongChart title="20 只 ETF 日度成交额与上证综指" rows={rows} kind="turnover" /><LongChart title="20 只 ETF 日度净流入与上证综指" rows={rows} kind="net" /></div>
    <p className="border-t border-border pt-2 text-xs text-muted-foreground">数据来源：新浪日 K 收盘价、baostock 真实日成交额、沪深交易所官方份额；净流入 = 份额变动 × 当日收盘价，以收盘价近似净值。缺失数据保留空值。</p>
  </section>;
}
