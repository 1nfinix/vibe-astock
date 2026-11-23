# 公开市场历史存储（开发中）

2026-11-23：服务层已接入本地 SQLite，数据位于 `<dataRoot>/shortline/market_history/`，与 `ledger/` 用户台账分开。库可由原始来源重建；不保存成交、持仓、成本和盈亏。

## 本机 API

- `GET /view/shortline_market_history[?date=YYYY-MM-DD&days=60]`：只读。默认返回库中最新已导入日；`days` 为 5–60（默认 30），控制上涨股票占比的历史序列长度。未导入时返回 `available:false` 和原因。
- `POST /view/shortline_market_history`，JSON `{ "date": "YYYY-MM-DD" }`：获取该日通达信盘后包及深交所交易日历，校验后导入。沿用视图写动作的 Bearer、JSON 和来源检查。每天为一笔 SQLite 事务；同 SHA-256 跳过，来源修订则替换该日，不覆盖其他日期。
- `POST /view/shortline_market_history`，JSON `{ "action": "backfill", "date": "YYYY-MM-DD" }`：按深交所日历，回填截至指定交易日最近 60 个交易日。每次请求最多补 5 个缺日，返回 `completed`、`remaining` 和本批 `imported`；页面自动续请求，用户停止或网络中断后再次点击会跳过已导入日。现有日期不会在批量回填时重新下载；上游修订仍可用单日采集替换。

GET 返回各市场已观察 A 股数、有效交易数、涨跌平数、站上 20/60 日均线的分子与分母，以及历史每日上涨股票占比所需的分子分母。均线使用收盘与参考前收盘比率链接；窗口必须包含交易所日历所列的全部交易日，且逐股每日价格、量、额有效。日历或日线缺失时，`window_complete` 为 false，宽度分子分母为 `null`，不是 0；历史序列缺日标 `missing`，折线断开。无独立逐日上市/停牌/退市全集，故“已观察”不能解释为应有股票总数。

取数只在 POST 发生；GET 不联网也不创建数据库。原始 ZIP、日历响应和各日哈希留在同一数据根。北交所换码表见 [`datasources/market_history/`](../datasources/market_history/README.md)。

## 已捕获数据的离线重放

本机命令行可把已经捕获的原始 ZIP 与交易所日历重放进独立数据根；它不是网页可调用的动作。重放逐包核 SHA-256，完整校验每个月的自然日与开市标记，再调用同一解析器、同一逐日事务写入；重复执行跳过相同哈希。示意命令：

```sh
PYTHONPATH=.agents/skills/data-access/scripts .venv/bin/python \
  orchestrator/src/finance/shortline/market_history_store.py replay \
  --repo-root . --store <dataRoot>/shortline/market_history \
  --capture-root <已捕获原始包目录>
```

2026-11-23 隔离实测：重放 2025-08-12 至 2026-11-20 的 309 个交易日，最新日 20/60 日宽度 8 组分子分母与独立复算相同；最近 60 个交易日序列无缺口。浏览器的「情绪复盘 → 市场宽度」页也已读取隔离库并展示表格与曲线。

## 尚待完成

网页可手动采集选定日，也可触发近 60 个交易日的分批回填。回填要求深交所日历可用。2026-11-23 空库联网验证在获取日历时返回 `ProxyError`，未能验收首次在线回填；只读网络检查中，本机代理可连接、通达信返回 HTTP 200，深交所地址经代理在响应前断开，直连也失败。已有 309 日隔离库走服务动作返回 `completed:60, remaining:0`；使用留存原始 ZIP 与日历响应做隔离空库演练，12 批导入 60 日，最终宽度与独立复算一致、序列无缺口、续跑不重复导入。隔离浏览器点击「回填近 60 个交易日」后显示 60/60，服务与浏览器随后关闭。日历源不可用时会明确失败，不把缺日当休市。定时采集、跨平台、并发与断电恢复尚未验收。
