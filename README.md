# Stars Radar · 星标雷达

[English](README.en.md) · [开发文档](docs/DEVELOPMENT.md)

Stars Radar 是一个自托管的开源项目研究助手。它把你的 GitHub 收藏、社区推荐和实时搜索接入 AI 助手，帮助你找回收藏过的工具、发现新项目、比较候选方案，并保存收藏理由。

你可以这样使用它：

> “从我收藏的项目里找一个支持 Markdown 的笔记工具。”
>
> “找最近两周出现的 Rust 命令行工具，给我几个候选。”
>
> “比较这三个仓库的许可证、最近维护时间和用途，说明信息来自哪里。”
>
> “收藏这个项目，记下我准备用它做什么。”

目前项目处于开发阶段，适合个人使用和自行部署。它提供 MCP 服务和命令行工具，没有独立的图形界面。使用 AI 助手时，需要客户端支持 **Streamable HTTP MCP** 和自定义认证请求头。

## 能做什么

- **找回收藏**：按用途、关键词或自然语言搜索自己的 GitHub Stars，分类来自你在 GitHub 上创建的 Lists。
- **发现项目**：浏览 GitHub Trending、近期增长的仓库、HelloGitHub 推荐和 Agent Skills 榜单，也可以直接搜索 GitHub。
- **比较候选**：一次比较 2–5 个仓库的简介、许可证、语言、维护日期和个人备注；缺少的信息会保留为未知。
- **README 章节级语义检索**：每个语义语料库仓库保留 metadata vector，并最多为 8 个均匀覆盖全文的 README chunks 建立独立 BGE-M3 vectors。被选入索引的 README-only 能力可直接参与召回，但不会宣称每一节都已向量化。
- **查看依据**：`explain=true` 把 `ranking`（排序信号）、`provenance`（字段到证据 ID）和 `evidence[]`（事实依据）分开返回。README evidence 可定位到 generation、SHA-256、chunk/section 身份和新鲜度；第三方 README、描述、代码与网页片段均标为 `external_untrusted`，只能作为证据，不能当作指令。
- **保存研究结果**：为仓库点 Star 并记录收藏理由。元数据先参与关键词检索，语义检索在下一次成功的数据更新后可用。

检索排序用于筛选候选，不代表项目质量或结论的可信概率。社区榜单来自第三方，可能暂时不可用；请结合数据时间、README、许可证和代码做判断。

## 开始使用

如果已经有自己的服务地址和访问密钥，可以直接跳到[连接 AI 助手](#连接-ai-助手)。首次使用需要部署自己的实例，仓库不会附带维护者的收藏数据或公共服务密钥。

### 1. 准备账号和工具

你需要：

| 项目 | 用途 |
| --- | --- |
| GitHub 账号及个人访问令牌 | 同步你的公开 Stars 和 Lists；为仓库点 Star |
| Cloudflare 账号，启用 Workers 与 R2 | 运行服务并保存数据 |
| SiliconFlow API 密钥 | 生成语义检索使用的向量 |
| Node.js 22.19.0 或更高版本、pnpm 10 | 安装和部署项目 |
| Python 3.8 或更高版本（可选） | 使用命令行客户端 |

这些外部服务可能产生费用，额度与价格请以服务商当前说明为准。GitHub 令牌的权限选择、数据存储方式和本地运行步骤见[开发文档](docs/DEVELOPMENT.md)。

### 2. 获取代码并创建存储桶

先在 GitHub 上 Fork 本仓库，再克隆你的 Fork。在仓库目录中运行：

```sh
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm exec wrangler r2 bucket create your-radar-bucket
```

`your-radar-bucket` 是示例名称，请换成自己的桶名。编辑 `wrangler.jsonc`：

- 将 `name` 设置为自己的 Worker 名称。
- 将 `r2_buckets` 中的 `bucket_name` 设置为刚创建的桶名，保留绑定名 `R2`。

### 3. 配置数据更新

在 Fork 的 **Settings → Secrets and variables → Actions** 中添加以下 Repository secrets：

| 名称 | 内容 |
| --- | --- |
| `GH_TOKEN` | 你自己的 GitHub 个人访问令牌 |
| `SILICONFLOW_KEY` | SiliconFlow API 密钥 |
| `R2_ACCOUNT_ID` | Cloudflare Account ID |
| `R2_BUCKET` | 上一步创建的桶名 |
| `R2_ACCESS_KEY_ID` | R2 S3 访问密钥 ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 访问密钥 |
| `MCP_API_KEY` | 与 Worker 上设置的读取密钥相同；供 `Deploy Worker` 部署后调用 `/health` 验证 |
| `RETRIEVAL_BENCHMARK_B64` | 私有人工标注检索 benchmark 的 base64；用于候选 generation activation 与 PR retrieval gate |

`RETRIEVAL_BENCHMARK_B64` 没有公开数据可继承——它是你自己的标注集。仓库提供了一个可直接使用的模板 `test/fixtures/retrieval-benchmark.example.json`（7 个用例，覆盖全部 7 个必测类别，默认阈值可通过校验）。把它改写成针对你自己收藏的问题后生成 base64：

```sh
base64 -w0 test/fixtures/retrieval-benchmark.example.json   # Linux
base64 -i test/fixtures/retrieval-benchmark.example.json    # macOS
```

把输出整行写入该 secret。模板里的查询命中不了你的仓库时，candidate retrieval gate 会失败并列出未达标指标——按提示换掉用例即可。**这个 secret 缺失时 `Update Repos Info` 会在 activation 前中止**，不会发布 generation。

同时添加 Repository **variable**（不是 secret）：

| 名称 | 内容 |
| --- | --- |
| `WORKER_URL` | 你的服务地址，例如 `https://stars.example.com`；不含 `/mcp` |

`MCP_API_KEY` 与 `WORKER_URL` 缺失时，`Deploy Worker` 会直接失败而不是跳过部署后验证——这两种情况必须显式配置，否则部署成功与否无从判断。

R2 的 S3 凭据需要能读写该桶。这里的 `GH_TOKEN` 在构建时映射为 `GITHUB_TOKEN`，GitHub 自动提供的工作流令牌不能代替你的个人令牌来同步个人收藏。

**配置顺序很重要。** `Deploy Worker` 要求线上 Worker 已存在 `MCP_API_KEY` 与 `MCP_WRITE_API_KEY` 两个 secret，因此在 Fork 上要先完成下一步（第 4 节，配置并部署服务），再在 **Actions** 中启用工作流并手动运行 **Update Repos Info**。

首次 `Update Repos Info` 会从你的账号生成收藏目录、README 和检索索引。以后工作流每 6 小时运行一次。catalog、榜单、资产索引、candidate vectors 以及 README 引用表会作为同一个不可变 generation 发布；activation 前必须先通过 private human-labeled retrieval gate，并对 generation manifest hashes、vector manifest/index/bin 与所有 README blob SHA-256 做完整性校验。只有全部通过才切换 `active-generation.json`。`state/` 下的 ingest/probe 日志与内容寻址 README blobs 作为不可变 source truth 永久保留；构建先读取上一代 snapshot，只从 R2 下载未见过的 state tail。派生 `generations/` 只保留最近 30 个通过远端完整性校验的 ready snapshots，失败/partial generation 不占 rollback 窗口。

`Deploy Worker` 在真正 `wrangler deploy` 前会校验 active generation；指针存在但内容损坏时直接 fail closed。桶还是空的全新安装没有指针可校验，此时允许部署 Worker（否则首次部署永远无法完成，而 Worker 正是验证数据流程的前提），`/health` 会把数据面报告为 `missing`，直到数据 workflow 发布第一代 generation。

### 4. 配置服务并部署

在本地仓库中设置 Worker secrets，按提示输入实际值：

```sh
pnpm exec wrangler secret put MCP_API_KEY
# 必填：写操作使用独立密钥
pnpm exec wrangler secret put MCP_WRITE_API_KEY
pnpm exec wrangler secret put GITHUB_TOKEN
pnpm exec wrangler secret put SILICONFLOW_KEY
pnpm deploy
```

`MCP_API_KEY` 与 `MCP_WRITE_API_KEY` 都是必填，并且必须使用两枚不同的随机密钥。读取密钥只能搜索和读取；写密钥可读且可执行 capture / Star / 收录。`GITHUB_TOKEN` 使用你的 GitHub 个人令牌。部署完成后，Wrangler 会输出服务地址。

Worker secrets 与 Actions secrets 是两套配置，需要分别设置。完整环境变量示例在 [.env.example](.env.example) 中。请妥善保管两个访问密钥：普通客户端只分发 `MCP_API_KEY`；只有明确需要写操作的可信客户端才分发 `MCP_WRITE_API_KEY`。

`wrangler.jsonc` 还配置了两个 Cloudflare Rate Limiting binding：昂贵检索默认 60 次/分钟，写操作默认 20 次/分钟，按认证 key 在当前 Cloudflare location 计数。它们用于保护 embedding、GitHub/Web 探针和写接口，不是精确计费器；如果你的 Cloudflare 账号已经使用示例中的 `namespace_id`，部署前把两个 ID 改成该账号内未占用的正整数。

`MCP_TOOLSET` 控制 **MCP 客户端可见的工具面**：默认 `research`（全部只读研究工具，不暴露 capture / star-and-ingest）；只有显式设置 `all` 才暴露写工具。该选项只改变 MCP 的工具发现与调用面，REST 路由保持不变；无效值会让 MCP 初始化失败。

数据更新与 Worker 部署已经彻底分离。`Update Repos Info` 只负责 R2 数据；`Deploy Worker` 只在主分支 Worker 相关代码变化或手动触发时部署。部署 workflow 需要 Actions secrets `CLOUDFLARE_API_TOKEN`、`R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`MCP_API_KEY`，以及 repository variable `WORKER_URL`；部署后无条件调用 `/health` 做生产 smoke check，任何一项缺失都会让 workflow 失败而不是跳过验证。

## 连接 AI 助手

在客户端添加一个远程 MCP 服务：

| 设置 | 值 |
| --- | --- |
| 名称 | `stars-radar` |
| 地址 | `https://你的服务地址/mcp` |
| 传输方式 | Streamable HTTP |
| 请求头 | `Authorization: Bearer 你的MCP_API_KEY` |

支持 `mcpServers`、`url` 和 `headers` 配置的客户端可以参考：

```json
{
  "mcpServers": {
    "stars-radar": {
      "url": "https://stars.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

把示例地址和密钥换成实际值。不同客户端的配置格式可能不同，请按其 MCP 设置页面填写。本服务使用 Bearer 密钥认证，没有 OAuth 登录流程。

连接后可以先让助手“检查星标雷达的数据状态”，再搜索或比较项目。收藏操作会改变你的 GitHub Stars；请在对话中明确说明要收藏的仓库和理由。

## 在终端使用

命令行客户端仅依赖 Python 标准库。先设置 `WORKER_URL` 和 `MCP_API_KEY`；执行 `--capture` 或 `--star` 时必须另外设置 `MCP_WRITE_API_KEY`。

PowerShell：

```powershell
$env:WORKER_URL = "https://stars.example.com"
$env:MCP_API_KEY = "YOUR_MCP_API_KEY"
python skills/stars-radar/scripts/search_stars_cli.py "Markdown 笔记工具" --scope starred
```

Bash / zsh：

```sh
export WORKER_URL="https://stars.example.com"
export MCP_API_KEY="YOUR_MCP_API_KEY"
# 仅需要写操作时：
export MCP_WRITE_API_KEY="YOUR_MCP_WRITE_API_KEY"
python skills/stars-radar/scripts/search_stars_cli.py "Markdown 笔记工具" --scope starred
```

常用命令：

```sh
# 搜索收藏与社区候选
python skills/stars-radar/scripts/search_stars_cli.py "rust terminal music player"

# 实时搜索 GitHub
python skills/stars-radar/scripts/search_stars_cli.py --live "markdown notes" --min-stars 50

# 浏览每周榜单
python skills/stars-radar/scripts/search_stars_cli.py --trending overall_weekly

# 收藏项目并记录理由（会写入 GitHub 和服务）
python skills/stars-radar/scripts/search_stars_cli.py --star owner/repo --reason "用于个人知识库"

# 查看完整参数
python skills/stars-radar/scripts/search_stars_cli.py --help
```

## 常见问题

**搜索不到刚收藏的项目？**

通过 Stars Radar 收藏的项目先进入入库日志，通常在一分钟内被其他服务实例的关键词检索读到。语义向量由下一次成功的 CI 构建生成。语义热集只覆盖当前 Stars 与明确收录的 curated 项目；社区榜单和 archive 长尾仍可通过词法/资产索引参与候选生成，但并不承诺全部向量化。直接在 GitHub 点 Star 的项目，要等收藏同步完成才会进入本服务。

**为什么分类和示例不一样？**

分类来自你自己的 GitHub Lists，没有固定的分类数量。未放进任何 List 的公开收藏归入 `everything-else`。通过服务填写的收录标签保存在本服务，不会自动修改 GitHub Lists。

**数据会公开吗？**

检索质量只认一套真实门禁：必填的 `RETRIEVAL_BENCHMARK_B64` 人工 relevance labels，并要求 README-only、多条件、多语言、negative、community 等 class-level thresholds。可信 workflow 会先恢复 production corpus，再用当前候选代码重新生成 candidate vectors，然后运行 private quality gate；scheduled data build 也在 generation activation 前执行同一门禁。fork PR 只运行不需要 secrets 的 synthetic regression。

生成的数据保存在你的 R2 桶中，不提交到代码仓库；服务接口需要访问密钥。同步管线排除私有仓库。请保持桶为私有，并只把密钥交给受信任的客户端。这是单个账号的个人服务，所有使用同一密钥的客户端共享数据和操作权限。

**连接失败怎么办？**

确认地址以 `/mcp` 结尾，客户端支持 Streamable HTTP 和认证请求头。`401` 通常表示密钥错误；`/health` 可以检查数据读取状态。首次安装、限流、榜单陈旧和向量不一致的处理见[开发文档](docs/DEVELOPMENT.md#排查问题)。

## 开发与贡献

部署细节、数据流、接口说明、测试和发布检查集中在[开发文档](docs/DEVELOPMENT.md)。给 AI 编码工具使用的配套技能位于 [skills/stars-radar](skills/stars-radar/SKILL.md)。

欢迎提交问题和改进建议。报告问题时，请写明操作步骤、预期结果、实际结果及运行环境，并移除密钥和个人备注。

## 许可证

项目代码使用 [Apache License 2.0](LICENSE)。检索到的第三方项目和 README 仍适用各自的许可证。
