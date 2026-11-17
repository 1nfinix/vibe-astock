# 项目代码导航

这份导航按当前工作树的目录与入口整理；业务行为、限制和安装步骤仍以根目录 [README](../README.md) 与 [AGENTS](../AGENTS.md) 为准。

| 层 | 主要位置 | 从哪里进入 |
|---|---|---|
| 浏览器页面 | [`desktop/src/`](../desktop/src/) | [`main.tsx`](../desktop/src/main.tsx) 建立路由；[`verticals/finance/pages/`](../desktop/src/verticals/finance/pages/) 放各栏目页面 |
| 短线与交易日志界面 | [`desktop/src/verticals/finance/shortline/`](../desktop/src/verticals/finance/shortline/)、[`journal/`](../desktop/src/verticals/finance/journal/) | 页面组件调用本机 API；请求封装见 [`lib/backend.ts`](../desktop/src/verticals/finance/lib/backend.ts) |
| 启动与服务 | [`orchestrator/src/`](../orchestrator/src/) | [`startup.ts`](../orchestrator/src/startup.ts) 管理启动；[`api.ts`](../orchestrator/src/api.ts) 提供 HTTP；[`mcp.ts`](../orchestrator/src/mcp.ts) 提供 MCP；[`service.ts`](../orchestrator/src/service.ts) 组织服务逻辑 |
| 短线与交易日志规则 | [`orchestrator/src/finance/shortline/`](../orchestrator/src/finance/shortline/)、[`journal/`](../orchestrator/src/finance/journal/) | 读数、复盘、验证和交易统计在服务端计算；定时任务见 [`schedule.ts`](../orchestrator/src/finance/schedule.ts) |
| 台账与研究 | [`orchestrator/src/ledger.ts`](../orchestrator/src/ledger.ts)、[`orchestrator/src/orchestrate.ts`](../orchestrator/src/orchestrate.ts) | 用户台账与研究运行分别保存；运行产物契约见 [研究宪法 §4](../methodology/constitution.md) |
| 数据与计算 | [`datasources/`](../datasources/)、[`calc/`](../calc/)、[`backtest/`](../backtest/) | 数据端点见 [CATALOG](../datasources/CATALOG.md)；确定性函数见 [SPEC](../calc/SPEC.md)；回测调用见 [`backtest/cli.py`](../backtest/cli.py) |
| 安装与启动脚本 | [`scripts/`](../scripts/) | [`setup`](../scripts/setup)、[`start`](../scripts/start)、[`doctor`](../scripts/doctor)；Windows 入口见 [scripts/README](../scripts/README.md) |

## 数据与测试边界

- 用户私有的配置、台账、上传资料、缓存和运行产物在 `.local/`，由 Git 忽略；不要把它当作源码整理或发布内容。台账仍由 `orchestrator/src/ledger.ts` 按种类写入 JSON 文件；研究运行产物另按研究宪法保存。
- 前端测试在 [`desktop/test/`](../desktop/test/)，服务端测试在 [`orchestrator/test/`](../orchestrator/test/)，Python 测试在 `calc/tests/`、`backtest/tests/` 和数据技能脚本的 `tests/`。验证命令与真实联调边界见 [开发验证说明](development-validation.md)。
- 历史文档与当前文档的区别见 [文档导航](README.md)；不要把旧里程碑的通过结果当作当前版本的运行证据。
