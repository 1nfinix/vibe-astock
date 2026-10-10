/**
 * 交易日志的界面视图登记(和 VR 原有视图分开放)。由 `../register_tasks.ts` 导入一次。
 * 🔴 个人交易数据只经带令牌的本机接口给界面,不进 AI 上下文、不进 MCP。
 */
import { registerView } from "../../views.ts";
import { journalAct, journalView } from "./view.ts";

registerView({ id: "journal", label: "交易日志", run: journalView, act: journalAct });
