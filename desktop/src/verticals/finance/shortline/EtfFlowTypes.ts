export interface EtfFlowPollData {
  date: string; asof: string; is_today: boolean; poll_ms: number; success_count: number;
  bars: { times: string[]; amount_yi: number[] | null; coverage: (number | null)[]; reason: string | null; barAxisMax: number };
  index: { times: string[]; close: number[] };
  missing: { code: string; reason: string }[];
  ranking: { code: string; name: string; amount_yi: number | null; share_pct: number | null; pct: number | null; pct_reason?: string | null; reason: string | null }[];
}
export interface EtfFlowCumData {
  date: string; slots: string[]; today: (number | null)[];
  comparison: { date: string | null; values: (number | null)[] | null; reason: string | null };
  average20: { values: (number | null)[] | null; n: number; from: string | null; to: string | null };
  comparison_dates: string[];
}
export interface EtfFlowMetric { net_yi: number | null; missing_count: number; status: string }
export interface EtfFlowDay {
  date: string; turnover_yi: number | null; turnover_missing_count: number;
  basket: EtfFlowMetric; categories: Record<string, EtfFlowMetric>; index_close: number | null;
  cumulative_ytd?: Record<string, number | null>;
}
export interface EtfFlowDailyData {
  date: string; rows: EtfFlowDay[]; spike_dates: string[]; recent_dates: string[];
  recent_month_categories: { date: string; categories: Record<string, EtfFlowMetric> }[];
  spike_complete: boolean; spike_window_from: string | null;
  backfill: { completed: number; total: number; from: string | null; to: string | null; syncing: boolean; failed: { code: string; date?: string; reason: string }[] };
}
export interface EtfFlowTypicalGroup { n: number; values: { mean: number; p25: number; p75: number; cumulative: number }[] | null; reason: string | null }
export interface EtfFlowTypicalData { times: string[]; spike: EtfFlowTypicalGroup; normal: EtfFlowTypicalGroup; available_dates: string[] }

export const flowNumber = (value: number | null | undefined, digits = 2) => value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
export const flowSigned = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
export const FLOW_CATEGORIES = ["沪深300", "中证1000", "中证500", "科创50", "中证A500", "创业板指", "上证50", "其他宽基", "创业板50", "双创50", "中证2000", "国证2000"] as const;
