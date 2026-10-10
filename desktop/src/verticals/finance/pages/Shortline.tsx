import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CalendarDays, Flame, RefreshCw, RotateCcw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { PageTabs, type PageTab } from "@/components/ui/PageTabs";
import { Disclaimer } from "@/components/ui/Disclaimer";
import { cn } from "@/lib/utils";
import { LOADING, badDayReason, loadBlocks, loadEmotion, type DayHead, type Panel } from "@/shortline/api";
import { TodayTab, type TodayPanels } from "@/shortline/TodayTab";
import type { EmotionResult } from "@/shortline/types";

type Tab = "today";
const TABS: PageTab<Tab>[] = [
  { key: "today", label: "今日情绪", icon: Flame },
];
const isTab = (v: string | undefined): v is Tab => TABS.some((t) => t.key === v);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 选的日子不能复盘:整页一句话说清,不在每一块里各报一遍 */
function BadDay({ why, onReset }: { why: string; onReset: (() => void) | null }) {
  return (
    <div className="glass p-6 text-sm">
      <p role="status" className="font-medium">{why},这一天没有可复盘的盘面。</p>
      <p className="mt-1 text-muted-foreground">换一个交易日再看{onReset && <>,或 <button type="button" onClick={onReset} className="text-primary underline-offset-2 hover:underline">回到默认的复盘日</button></>}。</p>
    </div>
  );
}

const ALL_LOADING: TodayPanels = { emotion: LOADING, facts: LOADING, themes: LOADING, firstboard: LOADING, cycle: LOADING };

/**
 * 情绪复盘:短线情绪的温度、钱亏在哪、钱在哪些题材。
 * 看哪一天由地址里的 `?date=` 说了算;不给就用后端算的业务日(盘中看上一个交易日,收盘后看当天)。
 * 🔴 屏上的日期一律用后端回来的那天,不用浏览器本地"今天"。
 */
export function Shortline() {
  const { tab: rawTab } = useParams();
  const tab: Tab = isTab(rawTab) ? rawTab : "today";
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const picked = params.get("date");
  const date = picked && ISO_DAY.test(picked) ? picked : undefined;

  const [head, setHead] = useState<DayHead | null>(null);
  const [defaultDay, setDefaultDay] = useState<string | null>(null);
  const [panels, setPanels] = useState<TodayPanels>(ALL_LOADING);
  const [busy, setBusy] = useState(false);
  // 换日期 / 刷新时旧请求可能晚回来:只认最后一次
  const seq = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const my = ++seq.current;
    setBusy(true);
    setPanels(ALL_LOADING);
    const r = await loadEmotion({ date, refresh });
    if (my !== seq.current) return;
    setHead(r.head);
    if (r.defaultDay) setDefaultDay(r.defaultDay);
    setPanels((p) => ({ ...p, emotion: r.emotion as Panel<EmotionResult> }));
    const day = r.head.day;
    const bad = badDayReason(r.emotion);
    if (!day || bad) {
      const why = bad ?? r.head.contextError ?? "没拿到业务日";
      const none = { state: "done", status: "missing", result: null, why, settled: null, cached: false, fetched_at: null } as const;
      setPanels((p) => ({ ...p, facts: none, themes: none, firstboard: none, cycle: none }));
      setBusy(false);
      return;
    }
    const put = (got: Record<string, Panel<unknown>>) => {
      if (my === seq.current) setPanels((p) => ({ ...p, ...got } as TodayPanels));
    };
    await Promise.all([
      loadBlocks("shortline_facts", ["facts"], day, refresh).then(put),
      loadBlocks("shortline_themes", ["themes", "firstboard"], day, refresh).then(put),
      loadBlocks("shortline_cycle", ["cycle"], day, refresh).then(put),
    ]);
    if (my === seq.current) setBusy(false);
  }, [date]);

  useEffect(() => { void load(false); }, [load]);

  const setDate = (d: string | null) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (d) next.set("date", d); else next.delete("date");
    return next;
  });
  const pickTab = (t: Tab) => navigate({ pathname: t === "today" ? "/shortline" : `/shortline/${t}`, search: params.toString() ? `?${params}` : "" });

  const day = head?.day ?? null;
  const ctx = head?.context;

  return (
    <div>
      <PageHeader
        title="情绪复盘"
        subtitle={`${day ? `${day} · ` : ""}短线情绪在什么温度:昨天涨停的今天赚不赚钱、晋级顺不顺、钱亏在哪个板位、钱在哪些题材`}
        actions={
          <>
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
              <span className="sr-only">复盘日</span>
              <input type="date" aria-label="复盘日" value={date ?? day ?? ""} max={defaultDay ?? undefined}
                onChange={(ev) => setDate(ev.target.value || null)}
                className="bg-transparent text-foreground outline-none [color-scheme:dark]" />
            </label>
            {date && (
              <button type="button" onClick={() => setDate(null)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                title="回到默认的复盘日(盘中看上一个交易日,收盘后看当天)">
                <RotateCcw className="h-3.5 w-3.5" /> 回到默认
              </button>
            )}
            <button type="button" onClick={() => load(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="不用缓存,重新取这一屏">
              <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> 刷新
            </button>
          </>
        }
      />

      {head?.contextError && (
        <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          没拿到交易日历:{head.contextError}。{date ? "按你选的日期去取。" : "选一个日期再看。"}
        </p>
      )}
      {!date && ctx?.review_reason && (
        <p className="mb-3 text-[12px] text-muted-foreground">默认看 <b className="text-foreground">{ctx.review_date}</b>({ctx.review_reason})</p>
      )}

      <PageTabs label="情绪复盘的分页" value={tab} onChange={pickTab} options={TABS} />

      {tab === "today" && (badDayReason(panels.emotion)
        ? <BadDay why={badDayReason(panels.emotion)!} onReset={date ? () => setDate(null) : null} />
        : <TodayTab day={day} panels={panels} />)}

      <Disclaimer />
    </div>
  );
}
