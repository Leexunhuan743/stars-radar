# Stars Radar 开发文档

本文面向部署者和贡献者，说明配置、数据流、接口和验证方法。日常操作见 [README](../README.md)，英文介绍见 [README.en.md](../README.en.md)。

## 项目组成

Stars Radar 包含三个部分：Node.js 数据管线、Cloudflare Worker 服务和 MCP / Python 客户端。管线获取个人 GitHub Stars、Lists 和社区数据，Worker 从 R2 读取索引并执行实时查询，客户端负责呈现结果。

项目没有前端应用、关系数据库或独立向量数据库。仓库保存代码和通用意图词表，用户数据保存在部署者自己的 R2 桶中。

```mermaid
flowchart LR
  GitHub[GitHub Stars / Lists] --> Build[Actions 数据构建]
  Community[社区来源] --> Build
  Build --> Embedding[SiliconFlow 向量计算]
  Embedding --> Build
  Build --> R2[R2 数据与日志]
  Client[AI 助手 / CLI] --> Worker[Cloudflare Worker]
  R2 --> Worker
  Worker --> Live[GitHub / 技术网页搜索]
  Worker --> Journal[追加收录与发现日志]
  Journal --> R2
  R2 --> Build
```

| 路径                                                | 职责                                       |
| --------------------------------------------------- | ------------------------------------------ |
| `src/index.js`                                      | Worker 请求入口与 MCP 注册                 |
| `src/tool-schemas.js`                               | MCP 工具参数与说明的统一定义               |
| `src/search-engine.js`                              | 收藏、社区、入库日志与历史资产的检索编排   |
| `src/query-analysis.js`、`scoring.js`、`ranking.js` | 查询解析、词法匹配和排序                   |
| `src/documents.js`、`document-cache.js`             | R2 读取、缓存与数据状态                    |
| `src/ingest-journal.js`、`append-store.js`          | 日志键、追加写入与折叠                     |
| `src/repository-details.js`                         | 仓库详情、比较及证据来源                   |
| `src/live-probes.js`                                | GitHub 仓库、代码和技术网页搜索            |
| `scripts/index.js`                                  | 收藏同步与数据构建入口                     |
| `scripts/github_stars.js`、`github-lists.js`        | GitHub 分页、README 下载与分类同步         |
| `scripts/vector_pipeline.js`                        | 增量向量计算与本地文件输出                 |
| `scripts/asset_store.js`                            | 合并持久状态，生成热集索引和日志快照       |
| `scripts/search_stars_cli.py`                       | REST 命令行客户端                          |
| `test/`                                             | 独立造数的单元、契约与本地 Worker 集成测试 |
| `skills/stars-radar/`                               | 可选的 AI Agent 使用指南                   |

## 环境与配置

使用 Node.js 22.19.0 或更高版本及 pnpm 10。CI 通过 `.node-version` 安装 Node，包管理器版本来自 `package.json`。Python 客户端要求 Python 3.8 或更高版本。

```sh
pnpm install --frozen-lockfile
```

### 配置位置

| 位置                             | 使用者              | 配置方式                                          |
| -------------------------------- | ------------------- | ------------------------------------------------- |
| `.env`                           | 本地数据构建        | 从 `.env.example` 复制；`pnpm dev:stars` 自动加载 |
| `.dev.vars`                      | `wrangler dev`      | 从 `.dev.vars.example` 复制                       |
| Actions secrets / Worker secrets | 线上构建 / 线上服务 | 分别在 GitHub 和 Cloudflare 配置                  |

这三处不会自动互相同步。`pnpm build:stars`、收割脚本和 Python 客户端使用当前进程的环境变量；Python 不读取 `.env`。真实配置及其环境专用变体均被忽略，示例文件可以入仓。本地 secret 文件规则见 [Cloudflare 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

<!-- prettier-ignore -->
| 名称                                       | 用途                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `GITHUB_TOKEN`                             | 本地构建和 Worker 的 Stars、Lists、GitHub 搜索及点 Star |
| `GH_TOKEN`                                 | 仅 Actions secret，在构建步骤映射为 `GITHUB_TOKEN`      |
| `SILICONFLOW_KEY`                          | 数据构建和 Worker 查询向量                              |
| `SILICONFLOW_URL`                          | 可选向量接口地址，默认 SiliconFlow embeddings 接口      |
| `MCP_API_KEY`                              | Worker 读取认证；未配置独立写密钥时保持旧版读写行为      |
| `MCP_WRITE_API_KEY`                        | 必填独立写密钥；capture / star / ingest 只接受它         |
| `MCP_TOOLSET`                              | MCP 工具暴露面：`research`（默认）/ `core` / `all`       |
| `R2_ACCOUNT_ID`、`R2_BUCKET`               | CI S3 上传及本地 R2 REST 操作的目标                     |
| `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | Actions 的 S3 读写凭据                                  |
| `CLOUDFLARE_API_TOKEN`                     | 可选 CI 部署；本地收割与向量恢复的 REST 操作也需要它    |
| `WORKER_URL`                               | Python 客户端的服务根地址，不含 `/mcp`，没有内置地址    |
| `BRAVE_SEARCH_API_KEY`、`TAVILY_API_KEY`   | 可选网页搜索提供商，配置到 Worker secrets               |
| `HTTP_PROXY`、`HTTPS_PROXY`                | 可选本地出站代理，Worker 不使用本地代理                 |

`ASSET_STORE_ROOT` 和 `VECTOR_STORE_ROOT` 是测试隔离入口，不是生产部署配置。生成数据使用项目内相对路径，测试在临时目录中造数并自行清理。

### GitHub 权限与分类

完整流程使用个人访问令牌，而非 Actions 自动生成的工作流令牌。Classic token 可选择 `public_repo` 和 `read:user`，用于公开仓库、用户 Lists 和收藏操作，无需为公开语料库申请读取私有仓库的 `repo` 权限。

Fine-grained token 对 Stars 读取要求 Starring read，点 Star 要求 Starring write 和 Metadata read，详见 [GitHub Stars API 文档](https://docs.github.com/en/rest/activity/starring)。选用这种令牌时还要验证自己的 GraphQL Lists 和代码搜索权限，不同接口的授权要求并不相同。Lists 读取不完整或无权读取时，构建会失败，不会把错误响应当成空分类发布。

同步排除私有仓库。分类名称按用户自己的 Lists 同步，取消分类会在下次成功构建生效；未分类仓库使用 `everything-else`。收录接口填写的标签属于 Radar 备注，不会修改 GitHub Lists。

## 首次部署与更新

首次部署步骤见 [README](../README.md#开始使用)。`wrangler.jsonc` 的 Worker 名称和桶名需要按部署环境填写，代码使用固定 R2 绑定名 `R2`，并声明 `EXPENSIVE_RATE_LIMITER` 与 `WRITE_RATE_LIMITER` 两个 Rate Limiting binding。R2 配置见 [Cloudflare R2 文档](https://developers.cloudflare.com/r2/get-started/workers-api/)，限流 binding 见 [Cloudflare Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。`namespace_id` 由部署者定义且在同一 Cloudflare 账号内需要保持唯一；示例 ID 若冲突必须替换。

`.github/workflows/build.yaml` 每 6 小时运行，也支持手动触发。Fork 后需要主动启用 Actions 和定时工作流。一次运行依次：

1. 读取 `active-generation.json`，从当前 `generations/<id>/` 恢复向量、资产状态和社区快照；README 与追加日志仍从各自长期前缀增量恢复。没有 active generation 是首次运行，认证、指针损坏或当前 generation 缺文件都会停止运行。
2. 获取当前公开 Stars 和全部 Lists / 成员页，更新目录和 README。
3. 为 Stars 和已确认收录构建向量，再抓取社区快照。
4. 合并持久资产状态，生成热集索引和入库日志快照。
5. 运行 lint、测试、向量一致性检查及 Worker 打包检查。
6. 上传派生 generation，逐对象从 R2 回读并与本地 staged artifact 做 byte-for-byte 比较；全部一致后才切换 active pointer。
7. 设置部署令牌时部署 Worker，否则仅更新 R2 数据。

数据发布使用共享并发组串行执行。Checkout 使用只读工作流令牌，个人 `GH_TOKEN` 只用于业务 API 调用。Worker secrets 由部署者独立设置，不从 Actions 自动注入。

derived JSON/vector 数据平面采用 generation 发布：`catalog.json`、`rankings.json`、`asset-index.json`、`asset-state.json` 与向量四件套先写入新的不可变 `generations/<id>/`；验证完成后，单独替换 `active-generation.json` 作为提交点。Worker 先缓存 active generation，再从同一 generation 读取所有 derived 文档；generation id 变化时对应缓存失效，因此不会把新 catalog 与旧 vectors 混读。最近三个 generation 保留用于快速回滚。README archive 仍是独立的增量 corpus，不属于这个原子提交边界。

自定义 `SILICONFLOW_URL` 时，构建和 Worker 必须使用产生相同向量空间的接口，不能只切换查询端。上游价格与额度以服务商当前说明为准。

### 本地开发

从示例复制配置并填入自己的密钥：

PowerShell：

```powershell
Copy-Item .env.example .env
Copy-Item .dev.vars.example .dev.vars
```

Bash / zsh：

```sh
cp .env.example .env
cp .dev.vars.example .dev.vars
```

然后执行：

```sh
pnpm dev:stars
pnpm build:assets
pnpm dev:seed
pnpm dev:mcp
```

`dev:stars` 调用真实 GitHub、社区和向量 API，可能产生请求费用；它只生成本地文件，不发布向量。全新账号可以没有 Star；空语料不会生成向量 generation，直到至少有一个确认仓库需要语义索引。

`dev:seed` 检查向量一致性，先读取全部必要输入，再写入 `.wrangler/state/v3` 下的本地 R2。它加载目录、社区数据、索引和 README，不操作远端桶。默认 `wrangler dev` 使用本地模拟存储，详见 [Cloudflare 本地数据文档](https://developers.cloudflare.com/workers/local-development/local-data/)。此命令覆盖同名对象，适合新的开发环境，不负责清理旧对象。

启动后，在 shell 中设置客户端变量。PowerShell 示例：

```powershell
$env:WORKER_URL = "http://127.0.0.1:8787"
$env:MCP_API_KEY = "与.dev.vars一致的密钥"
python scripts/search_stars_cli.py "terminal music player"
```

Bash / zsh 使用 `export WORKER_URL=...` 和 `export MCP_API_KEY=...`。

## 数据与写入职责

<!-- prettier-ignore -->
| R2 对象                                   | 内容                                         | 写入者            |
| ----------------------------------------- | -------------------------------------------- | ----------------- |
| `catalog.json`                            | 当前公开 Stars、Lists 和元数据               | CI                |
| `<owner>/<repo>.md`                       | README；本地路径为 `stars/<owner>/<repo>.md` | CI                |
| `rankings.json`                           | 社区榜单及各来源更新时间 / 失败状态          | CI                |
| `asset-state.json`                        | 历史资产、首次发现、上榜次数等持久状态       | CI                |
| `generations/<id>/asset-index.json`       | 热集检索索引与 ingest/probe snapshots         | CI                |
| `embeddings.bin`、`embeddings-index.json` | Float32 向量及结构化 records（repo metadata / README chunks） | CI                |
| `embeddings-fingerprints.json`            | 文本 / 模型与向量内容指纹，用于复用          | CI                |
| `embeddings-manifest.json`                | 模型、维度、数量及 index/bin 的 SHA-256      | CI                |
| `state/ingest-journal/*.jsonl`            | 经确认的收录和备注，每次操作追加一个对象     | Worker 或本地收割 |
| `state/probe-captures/*.jsonl`            | 经 `capture_github_discovery` 明确确认的发现元数据 | Worker            |

`state/` 在 Worker 写入侧保持 append-only；CI 只会在新 generation 已激活后，根据上一代 snapshot 的**精确 key 列表**回收已证明持久化的旧对象，绝不递归删除整个前缀。`asset-meta.json` 是本地统计文件，不由 Worker 读取，也不上传。

资产分为 `starred`、`curated`、`community`、`discovered`。前三种进入热集；实时搜索本身永远不写状态，只有显式调用 `capture_github_discovery` 才记录一次发现观察，满足跨查询确认等规则后才晋升为社区资产。取消 Star 会移除个人收藏标记，历史资产可能作为社区候选保留；已明确收录的记录仍保存在日志中。

`ingest_snapshot` 保存已折叠的 curator entries 与对应原始 key；`probe_snapshot` 保存该代已折叠的 probe 原始 key。下一轮只解析上一代 snapshot 尚未覆盖的 raw tail。active generation 成功切换后，CI 只删除**上一代**明确列出的 ingest/probe key；本轮第一次看到的写入至少再保留一个 generation，因此回滚上一代再重建也不会丢掉新收录或新发现。不会递归删除任何 state 前缀。

常规数据缓存为 30 分钟，入库日志视图为 60 秒，均是每个 Worker 实例独立的缓存。写入实例立即安装新视图，其他实例刷新后可见。大量语料或高频写入会增加内存与 R2 请求开销，当前架构适用于个人库，是单账号共享密钥服务，没有多租户隔离。

## 检索与证据

向量模型固定为 `BAAI/bge-m3`，维度为 1024。输入 profile 固定为 `repo-metadata-readme-chunks-v3`。每个仓库至少有一个 metadata record（仓库名、分类、语言、备注、摘要、简介、topics），README 则按 Markdown 章节切分并选择最多 6 个有信息量的 chunk，各自拥有独立向量。`embeddings-index.json` 保存结构化 record，而不是简单仓库名数组；record 明确区分 `kind=repo` 与 `kind=readme_chunk`，README record 同时保存 heading 和用于证据展示的文本。manifest 必须精确匹配该 profile、record count、repo count 以及 index/bin SHA-256；任何旧 profile、字符串 index、混合代次或内容哈希不一致都会被拒绝并要求重建。默认构建与查询都使用 SiliconFlow；查询向量接口失败时退回词法通道。

检索结合向量相似度、关键词、通用意图词表与具体主体匹配。明确的仓库名或技术主体约束候选；个人收藏有排序加权，综合结果也保留社区候选。`scope` 选择收藏 / 社区范围，`category` 选择用户分类，`source` 选择来源。

`explain=true` 同时暴露两类 README 证据。第一类是 `semantic_evidence.readme_chunk`：它来自 v3 chunk 向量本身，返回命中的 heading、短 snippet 与 cosine similarity，可解释“为何一个功能即使不在 GitHub description 里也被召回”，同时避免把完整 chunk 重复塞进响应。第二类是 `readme_evidence`：对前 5 个结果额外读取 R2 已缓存 README，只在存在真实词面命中时返回最多两个短片段。两类证据都不会访问 GitHub；Stars Radar 自己生成的分类/推荐理由头会先被剥离，避免 curator 元数据伪装成上游 README。`min_score` 是排序门槛，不是准确率。

详情和比较区分 `evidence.source`、`snapshot_at`、`fetched_at`。`refresh=true` 请求 GitHub 当前元数据并保留个人备注；未知字段为 `null`，不能推断为“没有许可证”或“已经停止维护”。README 最多返回 50,000 个字符。上游文字与代码片段是来源内容，应结合原始链接核实。

## MCP 工具

Streamable HTTP 入口为 `/mcp`，认证为 Bearer key。`MCP_API_KEY` 与 `MCP_WRITE_API_KEY` 都是必填：读 key 只能读取和检索，写 key 可读且允许 `capture_github_discovery` 与 `star_and_ingest_repo`。REST 写接口使用相同规则，读 key 调用时返回 `403 write_forbidden`。昂贵的向量/GitHub/Web 路径与写路径分别经过平台 Rate Limiting binding；默认预算分别为 60/分钟与 20/分钟，超限返回 `429 rate_limited`。Cloudflare Rate Limiting 是按 location 的保护性、最终一致计数，不应作为精确用量或计费系统；配置了 binding 但 binding 调用异常时服务 fail closed，返回 `503 rate_limiter_unavailable`，避免静默失去成本保护。

`MCP_TOOLSET` 只控制 MCP server 注册哪些工具，不改变 REST 路由：默认 `research` 自动包含所有声明为只读的 MCP 工具并隐藏写工具；`core` 只保留 7 个个人库检索、README/比较、分类/列表和状态工具；只有显式设置 `all` 才暴露全部 15 个工具。非法值会返回 MCP 配置错误。不提供 OAuth 或旧 SSE 入口。参数定义以 `src/tool-schemas.js` 为准。

<!-- prettier-ignore -->
| 工具                    | 用途 / 常用参数                                                              |
| ----------------------- | ---------------------------------------------------------------------------- |
| `get_radar_status`      | 数据规模、状态与工具选择提示                                                 |
| `search_github_stars`   | `query`；可选 `scope`、`category`、`source`、`limit`、`min_score`、`explain` |
| `get_repo_readme`       | `repo`；`include_readme=false` 获取元数据，`refresh=true` 获取当前元数据     |
| `compare_repositories`  | `repos` 数组，2–5 个不同仓库；可选 `refresh`                                 |
| `search_github_live`    | 只读实时 GitHub 查询：语言、Star 数、日期、排序                               |
| `capture_github_discovery` | 显式写入一个已选择的发现；服务端重新读取 GitHub 元数据后再决定是否记录         |
| `search_github_code`    | 查询；可选仓库、语言、扩展名和路径                                           |
| `search_web_tech`       | 查询；可选 `domain`、`freshness`                                             |
| `star_and_ingest_repo`  | `repo`、`reason`、`categories`；点 Star 并追加收录                           |
| `get_trending_repos`    | `category`；日榜、语言周榜及 `breakout_weekly`                               |
| `get_top_skills`        | `type`、`limit`；Skills 与近期技能仓库                                       |
| `get_hellogithub_picks` | `category`、`limit`                                                          |
| `list_categories`       | 当前 GitHub Lists 分类和数量                                                 |
| `get_category_repos`    | `category`、`limit`                                                          |
| `list_starred_repos`    | README 归档分页，`limit`、`cursor`                                           |

收录结果分别报告 `starred_on_github` 与 `staged_in_radar`。GitHub 拒绝点 Star 时，真实仓库仍可能收录到 Radar，需要检查两个状态。服务没有取消收录或修改 GitHub Lists 的接口。

网页搜索只使用显式配置的 Brave / Tavily API。未配置任何 provider，或所有已配置 provider 均失败时返回 `503 search_unavailable`；不再解析第三方搜索 HTML 页面。`freshness_applied` 表明日期过滤是否实际生效。GitHub 限流或不完整结果会在返回值中说明，不应解释成“没有项目”。

## REST 接口

除 CORS 预检外，所有接口都需要 Bearer 密钥，包括 `/health`。成功返回 `{ "ok": true, "data": ... }`，可能包含 `meta`；失败返回 `ok=false` 和错误上下文。

<!-- prettier-ignore -->
| 方法 / 路径           | 主要参数或用途                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| `GET /health`         | 数据状态、数量、向量模型及社区新鲜度                                       |
| `GET /api/search`     | `q`、`scope`、`category`、`source`、`limit`、`explain`                     |
| `GET /api/repository` | `repo`、`include_readme`、`refresh`                                        |
| `GET /api/compare`    | `repos=owner/a,owner/b`、`refresh`                                         |
| `GET /api/categories` | 用户分类                                                                   |
| `GET /api/trending`   | `category`，返回快照榜单                                                   |
| `GET /api/skills`     | `type=all` 或 `repos`、`limit`                                             |
| `GET /api/live`       | 只读：`q`、`language`、`min_stars`、`sort`、`since`、`until`、`limit` |
| `POST /api/capture`   | 写入：JSON `repo`、`query`；服务端重新校验 GitHub 元数据                     |
| `GET /api/code`       | `q`、`repo`、`language`、`extension`、`path`、`limit`                      |
| `GET /api/web`        | `q`、`domain`、`freshness`、`limit`                                        |
| `POST /api/ingest`    | JSON：`repo`、可选 `reason`、字符串数组 `categories`                       |

REST 与 MCP 的工具集合和可选参数不完全相同。例如 `min_score` 是 MCP 搜索参数，REST `/api/search` 没有暴露它。

在已设置客户端环境变量的终端中检查状态：

```sh
python -c "import os,json,urllib.request; r=urllib.request.Request(os.environ['WORKER_URL'].rstrip('/')+'/health',headers={'Authorization':'Bearer '+os.environ['MCP_API_KEY']}); print(json.load(urllib.request.urlopen(r)))"
```

### 本地收割

收割是写入行为。它获取候选并向配置的远端 R2 入库日志追加元数据，不点 GitHub Star，也不计算或上传向量。

```sh
node --env-file .env scripts/harvest_and_ingest.js --source breakout --days 14 --limit 10
```

`--source` 支持 `all`、`skills`、`breakout`。日志发布必须具备完整的 `R2_ACCOUNT_ID`、`R2_BUCKET`、`CLOUDFLARE_API_TOKEN`。空候选不会写空日志，抓取或追加失败退出非零。下一次成功 CI 构建会计算已确认收录的向量。

## 测试与发布检查

```sh
pnpm lint
pnpm test
pnpm eval:retrieval
pnpm exec wrangler deploy --dry-run --outdir dist

# 使用自己的真实 Stars / 向量做离线检索质量评估（标注文件不会提交）
cp test/fixtures/retrieval-benchmark.example.json data/retrieval-benchmark.private.json
# 编辑 private fixture 后：
pnpm eval:retrieval:real -- --fixture data/retrieval-benchmark.private.json --k 10
# fixture 中配置 thresholds 后，可作为失败门禁运行
pnpm eval:retrieval:gate -- --fixture data/retrieval-benchmark.private.json --k 10 --output retrieval-report.json
```

行为变更需补充结果测试。工具参数变化还需检查 schema snapshot；确实改变契约时，运行跨平台命令 `pnpm test:schema:update`，不要更新快照来掩盖意外变化。

常规测试不要求真实 GitHub / R2 数据。Worker 集成测试使用临时本地 R2 验证认证、REST 和实际 MCP Client。`pnpm eval:retrieval` 仍使用合成标注及固定向量，只负责规则回归，不能作为真实模型质量或生产准确率声明。`pnpm eval:retrieval:real` 则直接读取本地真实 `catalog.json`、`asset-index.json`、`embeddings.bin` 与私有 relevance labels，并用真实 BGE-M3 query embedding 比较 lexical 与 hybrid，输出 Recall@K、Precision@K、MRR、NDCG@K、forbidden hits 以及 P50/P95 延迟。真实标注文件 `data/retrieval-benchmark.private.json` 已加入忽略规则，避免个人收藏与判断进入仓库。fixture 可为 lexical / hybrid 模式配置最低 Recall、Precision、MRR、NDCG、negative empty-success，以及最大 forbidden hits / P95；`pnpm eval:retrieval:gate` 任一阈值不达标即非零退出，因此可以接入部署者自己的私有 CI。公共仓库仍不会假装持有真实 relevance labels。

发布前在自己的目标环境完成：

- 从空桶运行一次数据工作流，确认各阶段成功。
- 设置 Worker secrets，部署后检查 `/health` 的文档状态和来源时间。
- 用实际 MCP 客户端确认工具调用、搜索、详情和比较。
- 在明确授权的测试仓库上验证收藏和备注，检查下次构建后的检索。
- 确认桶名、地址、密钥及生成数据没有被提交。

常规推送由 `ci.yaml` 检查代码，数据工作流执行自己的发布前检查。GitHub Release 或版本标签是单独的项目发布操作，`pnpm deploy` 只部署服务。

## 排查问题

<!-- prettier-ignore -->
| 现象                        | 检查与处理                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| `401 unauthorized`          | 检查 Bearer 请求头与 Worker 的读取 / 写入密钥                                 |
| `403 write_forbidden`       | capture / star / ingest 使用了读取密钥；必须改用 `MCP_WRITE_API_KEY`         |
| `429 rate_limited`          | 当前 Cloudflare location 的该认证 key 已用完对应保护预算；稍后重试             |
| `503 rate_limiter_unavailable` | 已配置限流 binding 但平台调用异常；检查 Wrangler binding/Cloudflare 状态     |
| `server_misconfigured`      | 本地检查 `.dev.vars`，线上检查 Worker secrets                              |
| 没有收藏                    | 检查 `GH_TOKEN` 是否属于你的账号，公开 Stars 是否为空                      |
| 分类构建失败                | 检查 GraphQL 权限、限流和错误日志，修复后重跑                              |
| 新收藏暂时搜不到            | 区分 GitHub 直接收藏与服务收录，检查工作流与缓存时间                       |
| `dataPlane` 出现 `missing`  | 检查首次构建和桶名；`status=ok` 不代表缺失对象已初始化                     |
| `degraded`                  | 有陈旧副本或读取失败，检查各文档状态、R2 与对象内容                        |
| 向量 manifest / 长度错误    | 重跑数据构建，用 `node scripts/verify_vector_pair.js` 检查产物，不混用代次 |
| 社区榜单陈旧                | 查看每个来源的更新时间和错误；上游失败时保留旧快照                         |
| 收录成功但 GitHub 没点 Star | 检查 `starred_on_github`、令牌写权限与限流                                 |
| 资产或日志损坏              | 保留原始对象，修复失败记录或从完整备份恢复；构建停止覆盖持久状态           |

R2 是运行数据的持久存储，代码仓库不能恢复个人备注和发现历史。derived data plane 默认保留最近三个不可变 generation，可通过切换 `active-generation.json` 快速回滚 derived 状态；这不是整桶备份，因为 README corpus 和最新尚未折叠的 `state/` tail 独立存在。重要部署仍应独立备份 R2。
