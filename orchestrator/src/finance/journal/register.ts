/**
 * 交易日志的界面视图登记(和 VR 原有视图分开放)。由 `../register_tasks.ts` 导入一次。
 * 🔴 个人交易数据只经带令牌的本机接口给界面,不进 AI 上下文、不进 MCP。
 */
import { registerView } from "../../views.ts";
import { journalAttribution } from "./attribution.ts";
import { journalAct, journalExcursion, journalView } from "./view.ts";

registerView({ id: "journal", label: "交易日志", run: journalView, act: journalAct });
registerView({ id: "journal_excursion", label: "交易日志 · 最大浮盈浮亏", run: journalExcursion });
registerView({ id: "journal_attribution", label: "交易日志 · 判断与执行归因", run: journalAttribution });
