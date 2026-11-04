import { useEffect, useState } from "react";
import { backend } from "@/lib/backend";
import { cleanReason } from "./api";
import { useWatchPoll } from "./useWatchPoll";
import { EtfTurnoverView, type EtfTurnoverViewData } from "./EtfTurnoverView";

export function EtfTurnoverTab() {
  const [auto, setAuto] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [override, setOverride] = useState<EtfTurnoverViewData | null>(null);
  const poll = useWatchPoll<EtfTurnoverViewData>(backend.etfTurnoverPoll, auto);
  useEffect(() => { if (poll.data) setOverride(null); }, [poll.data]);
  const view = override ?? poll.data;
  const setWatch = async (codes: string[]) => {
    setSaving(true); setActionError(null);
    try { setOverride(await backend.etfTurnoverSetWatch<EtfTurnoverViewData>(codes)); }
    catch (e) { setActionError(cleanReason(e instanceof Error ? e.message : String(e))); }
    finally { setSaving(false); }
  };
  return <section aria-label="宽基 ETF 量价跟踪" className="mt-4">
    {!view ? <p role="status" className="text-sm text-muted-foreground">正在读取宽基 ETF 量价…{poll.error ? ` ${poll.error}` : ""}</p> :
      <EtfTurnoverView view={view} onRefresh={() => { setOverride(null); poll.refresh(); }} autoRefresh={auto} onAutoRefresh={setAuto} onSetWatch={(codes) => { void setWatch(codes); }} busy={saving} saveError={actionError} error={poll.error} />}
  </section>;
}
