import type { Margin } from "./marketReview.ts";

type MarginRow = Margin["series"][number];
export type MarginPeriod = "day" | "week" | "month";
const iso = (day: Date) => day.toISOString().slice(0, 10);

function periodBounds(date: string, period: "week" | "month") {
  const start = new Date(date + "T00:00:00Z");
  if (period === "week") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  else start.setUTCDate(1);
  const end = new Date(start);
  if (period === "week") end.setUTCDate(end.getUTCDate() + 6);
  else end.setUTCMonth(end.getUTCMonth() + 1, 0);
  return { start: iso(start), end: iso(end) };
}

export interface MarginCalendar { from: string; to: string; dates: string[] }
export function marginCalendar(extra: Record<string, unknown> | undefined): MarginCalendar | null {
  const window = extra?.window, dates = extra?.trading_dates;
  const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!Array.isArray(window) || window.length !== 2) return null;
  const [from, to] = window;
  if (!isDay(from) || !isDay(to) || from > to || !Array.isArray(dates) || !dates.length || !dates.every(isDay) ||
      dates.some((d, i) => d < from || d > to || d <= (dates[i - 1] ?? ""))) return null;
  return { from, to, dates };
}

export function marginTrendSeries(rows: MarginRow[], cutoff: string | null, count: number, calendar: MarginCalendar | null) {
  const eligible = rows.filter((row) => !cutoff || row.date <= cutoff);
  const first = eligible[0]?.date;
  const through = cutoff ?? eligible.at(-1)?.date;
  if (!first || !through || !calendar || calendar.from > first || calendar.to < through) return eligible.slice(-count);
  const byDate = new Map(eligible.map((row) => [row.date, row]));
  return calendar.dates.filter((day) => day >= first && day <= through).slice(-count).map((date) =>
    byDate.get(date) ?? { date, balance: null, financing: null, floatPct: null, netBuy: null });
}

export function marginPeriodSums(rows: MarginRow[], period: MarginPeriod, cutoff: string, calendar: MarginCalendar | null) {
  if (period === "day") return rows.map((row) => ({ date: row.date, value: row.netBuy, partial: false }));
  if (!calendar || !rows.length || calendar.from > rows[0]!.date || calendar.to < cutoff) return [];
  const groups = new Map<string, { value: number; known: number; end: string }>();
  for (const row of rows) {
    const { start, end } = periodBounds(row.date, period);
    const group = groups.get(start) ?? { value: 0, known: 0, end };
    if (row.netBuy !== null) { group.value += row.netBuy; group.known++; }
    groups.set(start, group);
  }
  return [...groups].map(([date, group]) => ({
    date,
    value: group.known ? group.value : null,
    partial: date < calendar.from || group.end > calendar.to ||
      calendar.dates.filter((day) => day >= date && day <= group.end).length !== group.known,
  }));
}
