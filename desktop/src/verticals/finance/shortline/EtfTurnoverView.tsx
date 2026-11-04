import { useMemo, useState } from "react";

export interface EtfItem {
  code: string; name: string; index: string; group: "core" | "watch"; huijin_yi: number | null;
  price: number | null; pct: number | null; amount_yi: number | null; mktcap_yi: number | null;
  shares: number | null; avg20_yi: number | null; hist: number[]; ratio: number | null;
  net_yi: number | null; subscr_net_yi: number | null; prev_shares: number | null;
  reason: string | null;
}
export interface EtfTurnoverViewData {
  date: string; asof: string; phase: string; trading_day: boolean | null; poll_ms: number;
  watch_codes: string[]; previous_shares_date: string | null; shares_suspect: string[];
  items: EtfItem[]; totals: { amount_yi: number | null; expected_yi: number | null; ratio: number | null; net_yi: number | null; weighted_pct: number | null };
  verdict: { level: string; title: string; reason: string };
  missing: { code: string; reason: string }[]; notes: string[];
}
const number = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits);
const signed = (v: number | null | undefined, digits = 2) => v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
const color = (v: number | null) => v == null ? "text-muted-foreground" : v > 0 ? "text-danger" : v < 0 ? "text-success" : "text-foreground";
const pctText = (v: number | null) => v == null ? "—" : `${signed(v)}%`;
const ratioText = (v: number | null) => v == null ? "—" : `${number(v)}×`;
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "medium" }).format(d); };
type Sort = "amount" | "ratio" | "net" | "pct" | "shares";

function Bars({ values }: { values: number[] }) {
  const tail = values.slice(-30), max = Math.max(0, ...tail);
  return <div className="flex h-8 min-w-24 items-end gap-px" aria-label={`近 ${tail.length} 日成交额`}>
    {tail.map((v, i) => <span key={i} className="min-w-0 flex-1 bg-primary/60" style={{ height: `${max > 0 ? Math.max(5, v / max * 100) : 5}%` }} title={`${number(v)} 亿元`} />)}
  </div>;
}

export function EtfTurnoverView({ view, onRefresh, autoRefresh = true, onAutoRefresh, onSetWatch, busy = false, error = null }: {
  view: EtfTurnoverViewData; onRefresh?: () => void; autoRefresh?: boolean; onAutoRefresh?: (on: boolean) => void;
  onSetWatch?: (codes: string[]) => void; busy?: boolean; error?: string | null;
}) {
  const [sort, setSort] = useState<Sort>("amount");
  const [scope, setScope] = useState<"all" | "core" | "watch">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const rows = useMemo(() => view.items.filter((x) => (scope === "all" || x.group === scope) && `${x.code} ${x.name} ${x.index}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => (b[({ amount: "amount_yi", ratio: "ratio", net: "net_yi", pct: "pct", shares: "shares" } as const)[sort]] ?? -Infinity) - (a[({ amount: "amount_yi", ratio: "ratio", net: "net_yi", pct: "pct", shares: "shares" } as const)[sort]] ?? -Infinity)), [view.items, sort, scope, search]);
  const submit = () => {
    const code = newCode.trim();
    if (!/^[51]\d{5}$/.test(code)) { setInputError("请输入 5/1 开头的六位 ETF 代码"); return; }
    if (view.items.some((x) => x.code === code)) { setInputError("这只 ETF 已在名单中"); return; }
    if (view.watch_codes.length >= 30) { setInputError("观察组最多 30 只"); return; }
    setInputError(null); onSetWatch?.([...view.watch_codes, code]); setNewCode("");
  };
  const renderGroup = (group: "core" | "watch") => {
    const groupRows = rows.filter((x) => x.group === group);
    if (!groupRows.length && scope !== group) return null;
    return <section key={group} className="mt-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{group === "core" ? "汇金历史持有 · 2025 年报最后一次实名披露" : "扩展观察 · 2025 年报未见汇金持仓"} <span className="font-normal text-muted-foreground">{groupRows.length} 只</span></h3>
        {group === "watch" && onSetWatch && <button type="button" onClick={() => setEditing((x) => !x)} className="rounded border border-border px-2 py-1 text-xs hover:bg-muted">{editing ? "完成编辑" : "编辑观察组"}</button>}
      </div>
      {group === "watch" && editing && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input aria-label="添加 ETF 代码" inputMode="numeric" maxLength={6} value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} placeholder="输入六位 ETF 代码" className="rounded border border-border bg-background px-2 py-1.5 text-foreground" />
        <button type="button" onClick={submit} className="rounded border border-border px-2 py-1.5 hover:bg-muted">添加</button>
        <span className="text-muted-foreground">仅作对照，不计入判断与合计；最多 30 只。</span>
        {inputError && <span role="alert" className="text-danger">{inputError}</span>}
      </div>}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[1100px] text-sm tabular-nums">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">ETF / 跟踪指数</th><th className="px-2 py-2 text-right">现价</th><th className="px-2 py-2 text-right">涨跌</th><th className="px-2 py-2 text-right">成交额 · 亿</th><th className="px-2 py-2 text-right">20 日均额 · 亿</th><th className="px-2 py-2 text-right">同时点倍数</th><th className="px-2 py-2 text-right">主动净买入 · 亿</th><th className="px-2 py-2 text-right">规模 · 亿</th><th className="px-2 py-2 text-right">份额 / 申赎</th><th className="px-3 py-2 text-left">近 30 日成交额</th></tr></thead>
          <tbody>{groupRows.map((x) => <tr key={x.code} className="border-t border-border align-top">
            <td className="px-3 py-2"><div className="font-medium text-foreground">{x.name} <span className="text-xs text-muted-foreground">{x.code}</span></div><div className="text-xs text-muted-foreground">{x.index} · {group === "core" ? `汇金历史 ${number(x.huijin_yi)} 亿份` : "观察"}</div>{x.reason && <div className="text-xs text-amber-700 dark:text-amber-400">{x.reason}</div>}</td>
            <td className="px-2 py-2 text-right">{number(x.price, 3)}</td><td className={`px-2 py-2 text-right ${color(x.pct)}`}>{pctText(x.pct)}</td>
            <td className="px-2 py-2 text-right">{number(x.amount_yi)}</td><td className="px-2 py-2 text-right">{number(x.avg20_yi)}</td><td className="px-2 py-2 text-right">{ratioText(x.ratio)}</td>
            <td className={`px-2 py-2 text-right ${color(x.net_yi)}`}>{signed(x.net_yi)}</td><td className="px-2 py-2 text-right">{number(x.mktcap_yi)}</td>
            <td className="px-2 py-2 text-right"><div>{number(x.shares)} 亿份</div><div className="text-xs text-muted-foreground">{view.shares_suspect.includes(x.code[0]!) ? "份额源未日更" : x.subscr_net_yi == null ? "申赎待前一快照" : `申赎 ${signed(x.subscr_net_yi)} 亿`}</div></td>
            <td className="px-3 py-2"><Bars values={x.hist} />{group === "watch" && editing && <button type="button" onClick={() => onSetWatch?.(view.watch_codes.filter((c) => c !== x.code))} className="mt-1 text-xs text-muted-foreground underline hover:text-foreground">移除 {x.code}</button>}</td>
          </tr>)}</tbody>
          {group === "core" && <tfoot><tr className="border-t border-border bg-muted/40 font-semibold"><td className="px-3 py-2">汇金历史组合计</td><td colSpan={2} /><td className="px-2 py-2 text-right">{number(view.totals.amount_yi)}</td><td /><td className="px-2 py-2 text-right">{ratioText(view.totals.ratio)}</td><td className="px-2 py-2 text-right">{signed(view.totals.net_yi)}</td><td colSpan={3} /></tr></tfoot>}
        </table>
        {!groupRows.length && <p className="px-3 py-4 text-sm text-muted-foreground">当前筛选下没有 ETF。</p>}
      </div>
    </section>;
  };
  return <div className="space-y-4">
    <section className="rounded-md border border-border bg-card p-4" aria-label="量价判断">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{view.date} · {view.phase === "closed" ? "已收盘" : view.trading_day === false ? "休市" : "盘中"} · {when(view.asof)}</p><h2 className="mt-1 text-lg font-semibold text-foreground">{view.verdict.title}</h2><p className="mt-1 max-w-4xl text-sm text-muted-foreground">{view.verdict.reason}</p></div><span className="rounded border border-border px-2 py-1 text-sm font-semibold">{ratioText(view.totals.ratio)}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm md:grid-cols-4">
        <div><div className="text-xs text-muted-foreground">合计成交额</div><strong>{number(view.totals.amount_yi)} 亿</strong></div>
        <div><div className="text-xs text-muted-foreground">放大倍数</div><strong>{ratioText(view.totals.ratio)}</strong><div className="mt-1 h-1 rounded bg-muted"><div className="h-full rounded bg-primary" style={{ width: `${Math.min(100, Math.max(0, (view.totals.ratio ?? 0) / 2 * 100))}%` }} /></div></div>
        <div><div className="text-xs text-muted-foreground">合计主动净买入</div><strong className={color(view.totals.net_yi)}>{signed(view.totals.net_yi)} 亿</strong></div>
        <div><div className="text-xs text-muted-foreground">池内加权涨跌</div><strong className={color(view.totals.weighted_pct)}>{pctText(view.totals.weighted_pct)}</strong></div>
      </div>
    </section>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <label>排序 <select aria-label="排序" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="rounded border border-border bg-background px-2 py-1"><option value="amount">成交额</option><option value="ratio">放大倍数</option><option value="net">主动净买入</option><option value="pct">涨跌幅</option><option value="shares">份额</option></select></label>
      <label>范围 <select aria-label="范围" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className="rounded border border-border bg-background px-2 py-1"><option value="all">全部</option><option value="core">汇金历史组</option><option value="watch">扩展观察</option></select></label>
      <input aria-label="搜索 ETF" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="代码、名称或指数" className="min-w-32 rounded border border-border bg-background px-2 py-1" />
      <button type="button" onClick={onRefresh} disabled={busy} className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50">立即刷新</button>
      <label className="inline-flex items-center gap-1"><input type="checkbox" checked={autoRefresh} onChange={(e) => onAutoRefresh?.(e.target.checked)} />自动刷新</label>
    </div>
    {error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">本次刷新失败：{error}；保留上次读数。</p>}
    {view.notes.map((note, i) => <p key={i} className="text-sm text-amber-700 dark:text-amber-400">{note}</p>)}
    {renderGroup("core")}{renderGroup("watch")}
    {view.missing.length > 0 && <p className="text-xs text-muted-foreground">缺数：{view.missing.map((x) => `${x.code} ${x.reason}`).join("；")}</p>}
    <p className="text-xs leading-relaxed text-muted-foreground">① 主动净买入 = (外盘 − 内盘) ÷ (外盘 + 内盘) × 成交额，是行情盘口估计值。② 申赎 = (本次份额 − 上一快照份额) × 现价；上一快照日：{view.previous_shares_date ?? "暂无"}。</p>
    <details className="rounded-md border border-border p-3 text-sm"><summary className="cursor-pointer font-medium">重要说明 · 名单与口径</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>汇金组固定 20 只，依据 2025 年报前十大持有人历史披露。信披新规后没有可用于确认当日持仓的公开实时源；扩展观察不计入判断或合计。</p><p>成交额基准取前 20 个交易日；盘中倍数按近 20 日 5 分钟累计占比与当前时点对齐，午休锁在 11:30。若行情日期非今日，则用全天成交额相比较。</p><p>收盘后 15:35 自动更新基准与份额。数据来自新浪 K 线与腾讯行情，基金份额以基金公告为准。上述量价现象不能证明任何机构当日交易，不构成投资建议。</p></div></details>
  </div>;
}
