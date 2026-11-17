# 文档导航

本仓库当前版本以根目录 [README](../README.md)、[CHANGELOG](../CHANGELOG.md)、代码和测试为准。这里同时保留了 Vibe Research 底座的历史设计与验收记录；带日期的旧文档只说明当时的范围，不代表 Vibe AStock 当前版本已经通过同样的验收。Vibe AStock v1.x（旧 Python 程序）的资料见仓库 `v1.1.3` 标签。

## 当前项目从哪里看

先看 [项目代码导航](project-map.md) 定位模块，再按下面的入口查具体契约。

| 需要了解 | 入口 |
|---|---|
| 安装、使用、功能和当前边界 | [README](../README.md)；英文版 [README_en](../README_en.md) |
| 本次版本变化 | [CHANGELOG](../CHANGELOG.md) |
| Agent 开发约束与部署方式 | [AGENTS](../AGENTS.md) |
| 前端页面与浏览器交互 | [`desktop/`](../desktop/) |
| HTTP API、MCP、研究编排器与台账 | [orchestrator/README](../orchestrator/README.md) |
| 数据源目录与上游对账 | [datasources/CATALOG](../datasources/CATALOG.md)、[datasources/UPSTREAM](../datasources/UPSTREAM.md) |
| 确定性计算与回测 | [calc/SPEC](../calc/SPEC.md)、[`backtest/`](../backtest/) |
| 研究规则和阶段 SOP | [研究宪法](../methodology/constitution.md)、[研究技能](../.agents/skills/) |
| 安装与启动脚本 | [scripts/README](../scripts/README.md) |

## 维护与验证

- [development-validation.md](development-validation.md)：自动回归、类型检查、构建与真实模型联调的边界。
- [model-access.md](model-access.md)：本机订阅 CLI、模型 API、provider 模板和兼容性验证。
- [release-checklist.md](release-checklist.md)：发布前检查与授权门槛。
- [providers/README](../providers/README.md)：模型 API 模板字段与凭据边界。
- [source-delivery.md](source-delivery.md)：v1.2.0 时期源码交付的历史说明；不能代替当前安装说明。
- [issue-pr-triage-2026-09-12.md](issue-pr-triage-2026-09-12.md)、[issue-pr-triage-v1.2.0.md](issue-pr-triage-v1.2.0.md)：各自日期的 Issue / PR 处理记录。

## 历史文档怎么读

本目录带日期的里程碑、验收和设计文档主要来自 Vibe Research 底座，保留用于追溯当时的方案与证据。尤其 M32–M40 的 Mac 客户端、安装包和公证记录不代表当前产品交付范围。底座自 v2.1.0 起不再内置 Codex Harness；旧文档里的产品专用 Codex 登录、hooks 和 Responses 通道均为历史做法。当前 AI 接入方式见 [model-access.md](model-access.md)。

- [AI接入与执行模式_v1_2026-09-04.md](AI接入与执行模式_v1_2026-09-04.md)：旧执行模式方案；当前页面行为以根目录 README 和代码为准。
- [双引擎任务架构_v3_2026-09-04.md](双引擎任务架构_v3_2026-09-04.md)：旧任务分层与实施记录，不代表当前界面需要用户选择三种模式。
- 其他带日期的文档按文件标题查阅，引用其中的测试结论时须同时注明日期、版本和验收范围。
