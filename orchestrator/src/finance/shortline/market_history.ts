/** Public market history store. GET reads local SQLite; POST fetches and imports one day. */
import path from "node:path";
import { fetchEnv } from "../../config.ts";
import { redact, runFetchProcess, safePath, ServiceError, type ServiceContext } from "../../service.ts";
import { validDate } from "./history.ts";

const STORE_SEGMENTS = ["shortline", "market_history"] as const;

function dayOf(value: unknown): string {
  if (typeof value !== "string" || !validDate(value)) throw new ServiceError("bad_request", "日期必须为有效 YYYY-MM-DD");
  return value;
}

async function worker(ctx: ServiceContext, mode: "query" | "ingest" | "backfill", date: string | undefined, signal: AbortSignal, days?: number, scheduled = false): Promise<unknown> {
  const store = safePath(ctx, ...STORE_SEGMENTS);
  safePath(ctx, ...STORE_SEGMENTS, "market.sqlite3");
  const script = path.join(ctx.repoRoot, "orchestrator", "src", "finance", "shortline", "market_history_store.py");
  const scriptsDir = path.join(ctx.repoRoot, ".agents", "skills", "data-access", "scripts");
  const argv = [script, mode, "--repo-root", ctx.repoRoot, "--store", store,
    ...(date ? ["--date", date] : []), ...(days ? ["--days", String(days)] : []),
    ...(scheduled ? ["--limit", "1", "--latest-first"] : [])];
  const result = await runFetchProcess(ctx.python, argv, {
    cwd: ctx.repoRoot,
    env: fetchEnv({ PYTHONPATH: scriptsDir, PYTHONDONTWRITEBYTECODE: "1" }),
    timeout: mode === "query" ? 30_000 : 180_000,
    signal,
  });
  if (result.status !== 0) {
    throw new ServiceError("market_history_failed", `市场历史${mode === "query" ? "查询" : mode === "backfill" ? "回填" : "采集"}失败：${redact(result.stderr, 240)}`);
  }
  try { return JSON.parse(result.stdout) as unknown; }
  catch { throw new ServiceError("market_history_failed", "市场历史进程未返回有效结果"); }
}

export async function marketHistoryView(ctx: ServiceContext, query: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  if (Object.keys(query).some((key) => key !== "date" && key !== "days")) throw new ServiceError("bad_request", "市场历史只接受 date、days 查询参数");
  const days = query.days === undefined ? 30 : Number(query.days);
  if (!Number.isInteger(days) || days < 5 || days > 60) throw new ServiceError("bad_request", "days 必须为 5–60 的整数");
  return worker(ctx, "query", query.date === undefined ? undefined : dayOf(query.date), signal, days);
}

export async function marketHistoryAct(ctx: ServiceContext, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  if (Object.keys(body).some((key) => key !== "date" && key !== "action")) throw new ServiceError("bad_request", "市场历史写入只接受 date、action 字段");
  if (body.action !== undefined && body.action !== "backfill") throw new ServiceError("bad_request", "未知的市场历史动作");
  return worker(ctx, body.action === "backfill" ? "backfill" : "ingest", dayOf(body.date), signal);
}

/** 每次至多补一个缺日；下次调度或重启后从 SQLite 的已完成日期继续。 */
export async function marketHistoryScheduled(ctx: ServiceContext, day: string, signal: AbortSignal): Promise<{ imported: string[]; remaining: number; completed: number; requested_days: number }> {
  return await worker(ctx, "backfill", dayOf(day), signal, undefined, true) as { imported: string[]; remaining: number; completed: number; requested_days: number };
}
