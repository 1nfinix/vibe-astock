import { useEffect, useState } from "react";
import { backend } from "@/lib/backend";
import { cleanReason } from "./api";
import { useWatchPoll } from "./useWatchPoll";
import { EtfFlowIntraday } from "./EtfFlowIntraday";
import { EtfFlowSignal } from "./EtfFlowSignal";
import { EtfFlowBroad } from "./EtfFlowBroad";
import type { EtfFlowCumData, EtfFlowDailyData, EtfFlowPollData, EtfFlowTypicalData } from "./EtfFlowTypes";

export function EtfFlowTab() {
  const [auto, setAuto] = useState(true);
  const [comparisonDate, setComparisonDate] = useState("");
  const [cum, setCum] = useState<EtfFlowCumData | null>(null);
  const [daily, setDaily] = useState<EtfFlowDailyData | null>(null);
  const [typical, setTypical] = useState<EtfFlowTypicalData | null>(null);
  const [cumError, setCumError] = useState<string | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const poll = useWatchPoll<EtfFlowPollData>(backend.etfFlowPoll, auto);

  useEffect(() => {
    if (!poll.data) return;
    const ctl = new AbortController();
    void backend.etfFlowCum<EtfFlowCumData>(comparisonDate || undefined, ctl.signal).then((value) => {
      if (!ctl.signal.aborted) { setCum(value); setCumError(null); }
    }).catch((e) => { if (!ctl.signal.aborted) setCumError(cleanReason(e instanceof Error ? e.message : String(e))); });
    return () => ctl.abort();
  }, [poll.data, comparisonDate]);

  useEffect(() => {
    let active = true;
    let ctl = new AbortController();
    const load = () => {
      ctl.abort(); ctl = new AbortController();
      void Promise.allSettled([backend.etfFlowDaily<EtfFlowDailyData>(ctl.signal), backend.etfFlowTypical<EtfFlowTypicalData>(ctl.signal)]).then(([d, t]) => {
        if (!active) return;
        if (d.status === "fulfilled") setDaily(d.value);
        if (t.status === "fulfilled") setTypical(t.value);
        const failed = [d, t].filter((x) => x.status === "rejected").map((x) => cleanReason(String((x as PromiseRejectedResult).reason)));
        setDailyError(failed.length ? failed.join("；") : null);
      });
    };
    load();
    const timer = window.setInterval(load, 30 * 60_000);
    return () => { active = false; ctl.abort(); window.clearInterval(timer); };
  }, []);

  const previousIndexClose = [...(daily?.rows ?? [])].reverse().find((r) => r.date < (poll.data?.date ?? "") && r.index_close !== null)?.index_close ?? null;
  return <div className="mt-4 min-w-0 space-y-8">
    <nav aria-label="ETF 资金页内导航" className="flex flex-wrap gap-2 border-b border-border pb-3 text-xs">
      <a href="#etf-flow-intraday" className="rounded border border-border px-3 py-1.5 hover:bg-muted">盘中分钟观测</a>
      <a href="#etf-flow-signal" className="rounded border border-border px-3 py-1.5 hover:bg-muted">放量记录</a>
      <a href="#etf-flow-broad" className="rounded border border-border px-3 py-1.5 hover:bg-muted">日度资金全景</a>
    </nav>
    {(cumError || dailyError) && <p role="alert" className="text-xs text-warning">部分数据未取到：{[cumError, dailyError].filter(Boolean).join("；")}</p>}
    <EtfFlowIntraday poll={poll.data} cum={cum} typical={typical} comparisonDate={comparisonDate} onComparisonDate={setComparisonDate}
      onRefresh={poll.refresh} auto={auto} onAuto={setAuto} error={poll.error} previousIndexClose={previousIndexClose} />
    <EtfFlowSignal data={daily} />
    <EtfFlowBroad data={daily} />
  </div>;
}
