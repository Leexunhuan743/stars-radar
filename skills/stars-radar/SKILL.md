---
name: stars-radar
description: "Search, retrieve, and harvest GitHub repositories, source code snippets, tech docs, and AI Agent Skills through your own deployed Stars Radar MCP server and local CLI. Use when the user asks to search GitHub stars, find open-source tools, inspect real-world code snippets, track GitHub trending/breakout repos, harvest agent skills into the 1024D vector database, or one-click star and ingest repos. Do not use for general non-technical web browsing or managing non-GitHub resources."
metadata:
  version: "1.0.0"
  author: "Stars Radar Contributors"
  category: "developer-intelligence"
---

# Stars Radar (星标雷达)

Stars Radar is an intelligence ecosystem and MCP server combining your personal stars, a 1024-dimensional `BAAI/bge-m3` vector database, an 18-domain public technical ontology, multi-source community trendings, and real-world code probes.

This skill equips agents and users to navigate the tri-level retrieval and harvesting hierarchy through your own deployed MCP server (e.g. `https://stars.example.com`, or `<worker-name>.<subdomain>.workers.dev`), the developer guide (`docs/DEVELOPMENT.md`), and the local CLI utilities.

## 来源与真相基础

- **MCP 端点**：`https://stars.example.com/mcp` 是**你自己部署**的 Worker 地址，请替换为你自己的自定义域名或 `<worker-name>.<subdomain>.workers.dev`。读取请求使用 `Authorization: Bearer <YOUR_MCP_API_KEY>`；若部署者配置了独立 `MCP_WRITE_API_KEY`，则 capture / star / ingest 必须使用写密钥，读密钥不能执行副作用。`WORKER_URL` 刻意不提供默认值：`search_stars_cli.py` 与 `audit_cf_deployment.py` 在它未设置时会直接以配置错误退出，避免缺失的值把密钥发往第三方主机。
- **本地代码库与工具路径**：
  - 本地搜索与收割 CLI：`scripts/search_stars_cli.py`
  - 线上部署验收与巡检脚本：`scripts/audit_cf_deployment.py`
  - 部署、架构与接口文档：`docs/DEVELOPMENT.md`
  - 核心工作区与索引：`catalog.json`、`embeddings.bin`、`embeddings-index.json`
  - 社区榜单快照：`rankings/rankings.json`
  - 完整 14 大 MCP 工具参数定义与返回值：[tool-matrix.md](references/tool-matrix.md)
  - 常用命令行配方与字典：[cli-recipes.md](references/cli-recipes.md)
  - 实战经验、提问范式与避坑指南：[playbook.md](references/playbook.md)

## 边界

明确列出本 skill **绝对不碰什么**：

- **入库门禁与人工确认原则（Human-in-the-Loop）**：`search_github_live` / `search_github_code` / `search_web_tech` 都是只读探针，搜索本身绝不写状态。若用户明确要求“记住/沉淀这个发现”，调用 `capture_github_discovery`，Worker 会重新向 GitHub 读取仓库元数据并通过阈值后追加到 `state/probe-captures/`；它只是一次 discovered 观察，不会直接进入向量热集。只有当用户明确要求收藏/收录时，才调用 `star_and_ingest_repo`：它会尝试 GitHub Star，并向 `state/ingest-journal/` 追加永久 curator 记录。该日志立即参与词法检索，后续 CI 以 `tier='curated'` 合并进热集和语义向量。未经明确确认的发现不会混入个人私藏真理源；
- **不进行非技术类通用网页搜索**：技术文档搜索（`search_web_tech`）仅服务于开发者技术选型、报错排查和文档阅读，不处理常规娱乐或商业闲聊；
- **不盲目全量通读超大文件**：阅读仓库详情时优先查阅结构化元数据和关键特性；代码搜索结果严格提取语法片段，避免爆破上下文窗口；
- **向量单写者**：CI 统一计算和发布向量。Worker 与本地收割只追加元数据日志；本地向量构建只生成文件，不发布到 R2。收割后先词法检索，下一轮成功 CI 构建再获得向量检索。

## 步骤与三级决策树

选型比较时，先用检索工具找到候选，再调用 `compare_repositories` 比较 2–5 个不同仓库。默认结果来自快照，检查 `evidence.source` 与 `evidence.fetched_at` / `evidence.snapshot_at`；需要当前许可证或维护日期时传 `refresh=true`。未知字段为 `null`，不能据此推断项目缺少许可证或已停止维护。阅读候选详情时可用 `get_repo_readme(include_readme=false)` 获取紧凑元数据，确认技术主张时再读取 README 或代码证据。

当接收到用户关于开源项目、技术选型或代码实现的查询时，按以下决策树判定并调用对应层级：

```text
                                用户查询输入
                                     │
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
       【找项目 / 技术方案】                            【查代码 / 查文档】
              │                                             │
      ┌───────┴───────┐                             ┌───────┴───────┐
      ▼               ▼                             ▼               ▼
已收藏/已知工具    全网新出/社区热点               真实代码实现    官方文档/报错
(Level 1: 向量)  (Level 2/3: 榜单/探针)          (search_code)   (search_web)
```

### 第一步：选择正确层级的工具（方案 C：严格划界原则）

1. **查私藏与已入库精选（Level 1 闭集高信任锚点）**：
   - 当用户寻找**自己收藏过的工具、明确需要私房解决方案、或查询已知领域精选**时：调用 `search_github_stars`；
   - 系统利用 1024 维 BGE-M3 单一权威向量与 18 大通用意图本体检索：对整个库做一次线性扫描，信噪比远高于开放世界检索；
   - **警惕边界**：私藏库只覆盖本实例已同步的收藏与收录。若用户明确问“全网新出的”、“最近火的”或私藏库中极可能未收录的冷门概念（如“代码结构 可视化”），**切勿仅在私藏库中强行挑选，必须主动进入 Level 3 探网**。

2. **查看社区情报榜单（Level 2 常态化雷达）**：
   - 查全局与语言周趋势：调用 `get_trending_repos`；
   - 查 14 天新生爆发项目：调用 `get_trending_repos(category: "breakout_weekly")`；
   - 查 Agent 技能生态：调用 `get_top_skills`；
   - 查中文精选月刊：调用 `get_hellogithub_picks`。

3. **全网开集主动探测（Level 3 全域探针，发现收藏库以外的项目）**：
   - **全网探新库**：当私藏库没有、或用户需要全网技术选型时，**必须直接驱动 `search_github_live`** 直连 GitHub 4 亿+ 仓库，支持 `min_stars` 降噪与自动 Fork 过滤，并自动碰撞个人私藏标记 `⭐ Starred` 与全网发现标记 `🌐 Global Discovery`；
   - **搜源码实现**：探查内部 API、报错或具体语法写法，驱动 `search_github_code`；
   - **搜技术文档**：查官网、报错讨论与深度长文，驱动 `search_web_tech`。

4. **一键 Star 并入库沉淀（Ingest Loop 闭环）**：
   - 仅在用户**明确确认收录**时调用 `star_and_ingest_repo`（`repo: "owner/repo"`）；
   - 自动在 GitHub 上点星，暂存入 R2 数据库，次日自动计算 1024 维向量固化为个人资产。

### 第二步：CLI 命令行执行规则（当处于终端环境时）

在无 MCP 连接的本地终端环境中，需先配置自有部署地址与认证密钥（`export WORKER_URL="https://stars.example.com"`、`export MCP_API_KEY="..."`，两者都必填且无默认值），直接运行 Python CLI 脚本完成等价操作：

- 搜私藏与全网：`python scripts/search_stars_cli.py "<query>"`
- 全网搜仓库：`python scripts/search_stars_cli.py --live "<query>" --limit 5`
- **全网搜仓库并显式沉淀发现**：`python scripts/search_stars_cli.py --live "<query>" --limit 5 --persist`。这里的 `--persist` 只是 CLI 兼容工作流：先执行只读 `/api/live`，再对符合阈值的 Top-3 候选逐个调用显式写接口 `/api/capture`；服务端会重新校验 GitHub 元数据。若启用了独立写密钥，请同时设置 `MCP_WRITE_API_KEY`。
- 全网搜代码：`python scripts/search_stars_cli.py --code "<code_query>" --language <lang>`
- 全网搜文档：`python scripts/search_stars_cli.py --web "<tech_query>"`
- 一键点星入库：`python scripts/search_stars_cli.py --star "owner/repo" --reason "<curator_note>"`
- 定向时间段收割：`python scripts/search_stars_cli.py --harvest --source [skills|breakout|all] --days <N> --limit <N>`
- 自有部署端点自动化巡检：`python scripts/audit_cf_deployment.py`

## 汇报

先说明检索范围和数据时间，再按用户的比较维度介绍候选。每个候选给出仓库链接、与需求相关的证据和未知信息。个人收藏备注与上游简介分别标明来源。

代码搜索附文件链接和相关片段；搜索失败、限流或陈旧快照要随结果说明。只在用户已授权收藏或收录时执行写入，完成后分别报告 GitHub Star 与 Radar 收录状态。
